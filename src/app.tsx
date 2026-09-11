import { useCallback, useEffect, useRef, useState } from 'preact/hooks'
import {
  ANSWER_MS,
  ANSWER_ROUNDS,
  CORRECT_MS,
  formatClock,
  Phase,
  READ10_MS,
  READ10_PER_QUESTION_MS,
  reachedFor,
  SHADOW_MS,
  SHADOW_REPS,
  STAGES,
  TOTAL_MS,
} from './session'
import { pickDaily, pickThree, Question, swapQuestion } from './questions'
import {
  DEFAULT_SETTINGS,
  loadRecords,
  loadSettings,
  recentQuestionIds,
  saveRecord,
  saveSettings,
  SessionRecord,
  Settings,
  streak,
  today,
} from './storage'
import { cueDone, cueNext, cueRep, cueStage, unlockAudio } from './cues'
import { keepAwake, releaseAwake } from './wakelock'

const CHECKLIST_LABEL = '質問応答（Q10音読→3問回答→1問添削）'
const SHADOW_REP_MS = SHADOW_MS / SHADOW_REPS

interface Run {
  phase: Phase
  endsAt: number
  ten: Question[]
  three: Question[]
  answerIndex: number
  swapped: boolean
  pickedId: string | null
  rewrite: string
  repsCued: number
}

const IDLE: Run = {
  phase: 'idle',
  endsAt: 0,
  ten: [],
  three: [],
  answerIndex: 0,
  swapped: false,
  pickedId: null,
  rewrite: '',
  repsCued: 0,
}

export function App() {
  const run = useRef<Run>(IDLE)
  const [, forceRender] = useState(0)
  const rerender = useCallback(() => forceRender((n) => n + 1), [])

  const [records, setRecords] = useState<SessionRecord[]>([])
  const [settings, setSettings] = useState<Settings>(DEFAULT_SETTINGS)
  const [now, setNow] = useState(Date.now())

  useEffect(() => {
    void loadRecords().then(setRecords)
    void loadSettings().then(setSettings)
  }, [])

  const persist = useCallback(
    (r: Run) => {
      const record: SessionRecord = {
        date: today(),
        reached: reachedFor(r.phase),
        questionIds: r.ten.map((q) => q.id),
        answeredIds: r.three.slice(0, r.answerIndex + 1).map((q) => q.id),
        pickedId: r.pickedId,
        rewrite: r.rewrite,
        quiet: settings.quiet,
        updatedAt: Date.now(),
      }
      void saveRecord(record).then(setRecords)
    },
    [settings.quiet],
  )

  /**
   * 次の工程へ。工程2・3・5 に戻る道は無い。
   * 途中で止めたくなったら「終了」で抜けるだけ。
   */
  const advance = useCallback(() => {
    const r = run.current
    const cue = { quiet: settings.quiet }

    switch (r.phase) {
      case 'read10':
        r.phase = 'answer'
        r.answerIndex = 0
        r.endsAt = Date.now() + ANSWER_MS
        cueStage(cue)
        break
      case 'answer':
        if (r.answerIndex < ANSWER_ROUNDS - 1) {
          r.answerIndex += 1
          r.endsAt = Date.now() + ANSWER_MS
          cueNext(cue)
        } else {
          r.phase = 'correct'
          r.endsAt = Date.now() + CORRECT_MS
          cueStage(cue)
        }
        break
      case 'correct':
        // 書けていなければ工程5は成立しない。到達4のまま終える。
        if (r.rewrite.trim().length === 0) {
          r.phase = 'done'
          releaseAwake()
          cueDone(cue)
        } else {
          r.phase = 'shadow'
          r.endsAt = Date.now() + SHADOW_MS
          r.repsCued = 0
          cueStage(cue)
        }
        break
      case 'shadow':
        r.phase = 'done'
        releaseAwake()
        cueDone(cue)
        break
      default:
        return
    }
    // 遷移した瞬間に時計を合わせる。次の tick を待つと、新しい工程の残り時間が
    // 一瞬だけ上限を超えて見える（音読が 0/3 から始まる）。
    setNow(Date.now())
    persist(r)
    rerender()
  }, [persist, rerender, settings.quiet])

  // 時計。残り時間は必ず絶対時刻から引く。裏に回っても遅れない。
  useEffect(() => {
    const id = window.setInterval(() => {
      const r = run.current
      const t = Date.now()
      setNow(t)
      if (r.phase === 'idle' || r.phase === 'done') return

      if (r.phase === 'shadow') {
        const elapsed = SHADOW_MS - (r.endsAt - t)
        const rep = Math.floor(elapsed / SHADOW_REP_MS)
        if (rep > r.repsCued && rep < SHADOW_REPS) {
          r.repsCued = rep
          cueRep({ quiet: settings.quiet })
        }
      }
      if (t >= r.endsAt) advance()
    }, 100)
    return () => window.clearInterval(id)
  }, [advance, settings.quiet])

  const start = useCallback(() => {
    unlockAudio()
    keepAwake()
    const date = today()
    const ten = pickDaily(date, recentQuestionIds(records))
    run.current = {
      ...IDLE,
      phase: 'read10',
      endsAt: Date.now() + READ10_MS,
      ten,
      three: pickThree(date, ten),
    }
    cueStage({ quiet: settings.quiet })
    setNow(Date.now())
    persist(run.current)
    rerender()
  }, [persist, records, rerender, settings.quiet])

  const stop = useCallback(() => {
    persist(run.current)
    releaseAwake()
    run.current = { ...IDLE }
    rerender()
  }, [persist, rerender])

  const toggleQuiet = useCallback(() => {
    const next = { ...settings, quiet: !settings.quiet }
    setSettings(next)
    void saveSettings(next)
  }, [settings])

  const swap = useCallback(() => {
    const r = run.current
    if (r.swapped) return
    const target = r.three[r.answerIndex]
    const replacement = swapQuestion(r.ten, r.three, target)
    if (replacement.id === target.id) return
    r.three = r.three.map((q) => (q.id === target.id ? replacement : q))
    r.swapped = true
    rerender()
  }, [rerender])

  const pickWorst = useCallback(
    (id: string) => {
      run.current.pickedId = id
      persist(run.current)
      rerender()
    },
    [persist, rerender],
  )

  const setRewrite = useCallback(
    (text: string) => {
      run.current.rewrite = text
      rerender()
    },
    [rerender],
  )

  const r = run.current
  const remaining = Math.max(0, r.endsAt - now)

  return (
    <main class={`screen screen-${r.phase}`}>
      {r.phase === 'idle' && (
        <IdleScreen
          records={records}
          quiet={settings.quiet}
          onToggleQuiet={toggleQuiet}
          onStart={start}
        />
      )}

      {r.phase === 'read10' && (
        <Read10Screen questions={r.ten} remaining={remaining} onStop={stop} />
      )}

      {r.phase === 'answer' && (
        <AnswerScreen
          question={r.three[r.answerIndex]}
          index={r.answerIndex}
          remaining={remaining}
          canSwap={!r.swapped && remaining > ANSWER_MS - 5_000}
          onSwap={swap}
          onStop={stop}
        />
      )}

      {r.phase === 'correct' && (
        <CorrectScreen
          three={r.three}
          pickedId={r.pickedId}
          rewrite={r.rewrite}
          remaining={remaining}
          onPick={pickWorst}
          onRewrite={setRewrite}
          onDone={advance}
          onStop={stop}
        />
      )}

      {r.phase === 'shadow' && (
        <ShadowScreen text={r.rewrite} remaining={remaining} onStop={stop} />
      )}

      {r.phase === 'done' && (
        <DoneScreen
          reached={reachedFor('done')}
          record={records.find((rec) => rec.date === today())}
          onClose={stop}
        />
      )}
    </main>
  )
}

function Ring({ progress, label, sub }: { progress: number; label: string; sub?: string }) {
  const radius = 86
  const circumference = 2 * Math.PI * radius
  return (
    <div class="ring">
      <svg viewBox="0 0 200 200" aria-hidden="true">
        <circle class="ring-track" cx="100" cy="100" r={radius} />
        <circle
          class="ring-fill"
          cx="100"
          cy="100"
          r={radius}
          stroke-dasharray={circumference}
          stroke-dashoffset={circumference * (1 - progress)}
          transform="rotate(-90 100 100)"
        />
      </svg>
      <div class="ring-label">
        <strong>{label}</strong>
        {sub && <span>{sub}</span>}
      </div>
    </div>
  )
}

function StopButton({ onStop }: { onStop: () => void }) {
  return (
    <button class="stop" onClick={onStop} aria-label="セッションを終了">
      終了
    </button>
  )
}

function Dots({ reached }: { reached: number }) {
  return (
    <span class="dots" title={STAGES.map((s) => s.label).join(' → ')}>
      {STAGES.map((stage, i) => (
        <i key={stage.id} class={i < reached ? 'dot on' : 'dot'} />
      ))}
    </span>
  )
}

function IdleScreen({
  records,
  quiet,
  onToggleQuiet,
  onStart,
}: {
  records: SessionRecord[]
  quiet: boolean
  onToggleQuiet: () => void
  onStart: () => void
}) {
  const days = streak(records)
  const todayRecord = records.find((r) => r.date === today())
  return (
    <div class="idle">
      <header class="idle-head">
        <h1>質問応答</h1>
        <p class="sub">Q10音読 → 3問回答 → 1問添削 · {formatClock(TOTAL_MS)}</p>
      </header>

      <button class="start" onClick={onStart}>
        <span class="start-main">{todayRecord?.reached === 5 ? 'もう一度' : '開始'}</span>
        <span class="start-sub">タップしたら喋りはじめる</span>
      </button>

      <div class="idle-meta">
        <button class={quiet ? 'chip on' : 'chip'} onClick={onToggleQuiet}>
          小声モード{quiet ? ' ON' : ' OFF'}
        </button>
        {days > 0 && <span class="chip flat">{days}日連続</span>}
      </div>

      <section class="log">
        <h2>{CHECKLIST_LABEL}</h2>
        {records.length === 0 && <p class="empty">まだ記録がありません。今日から。</p>}
        <ul>
          {records.slice(0, 14).map((record) => (
            <li key={record.date}>
              <span class="log-date">{record.date.slice(5).replace('-', '/')}</span>
              <Dots reached={record.reached} />
              <span class="log-note">
                {record.reached === 5 ? '完了' : `${STAGES[record.reached - 1]?.label ?? '—'}まで`}
              </span>
            </li>
          ))}
        </ul>
      </section>
    </div>
  )
}

function Read10Screen({
  questions,
  remaining,
  onStop,
}: {
  questions: Question[]
  remaining: number
  onStop: () => void
}) {
  const elapsed = READ10_MS - remaining
  const current = Math.min(questions.length - 1, Math.floor(elapsed / READ10_PER_QUESTION_MS))
  const listRef = useRef<HTMLOListElement>(null)

  useEffect(() => {
    // 次の行を探す視線移動をなくす。現在行を画面の中央に置く。
    listRef.current
      ?.querySelector('.now')
      ?.scrollIntoView({ block: 'center', behavior: 'smooth' })
  }, [current])

  return (
    <div class="stage">
      <StageHead
        title="Q10音読"
        hint="考えず口だけ動かす"
        remaining={remaining}
        total={READ10_MS}
        onStop={onStop}
      />
      <ol class="ten" ref={listRef}>
        {questions.map((q, i) => (
          <li key={q.id} class={i === current ? 'now' : i < current ? 'past' : ''}>
            {q.text}
          </li>
        ))}
      </ol>
    </div>
  )
}

function AnswerScreen({
  question,
  index,
  remaining,
  canSwap,
  onSwap,
  onStop,
}: {
  question: Question
  index: number
  remaining: number
  canSwap: boolean
  onSwap: () => void
  onStop: () => void
}) {
  return (
    <div class="stage stage-answer">
      <StageHead
        title={`3問回答 ${index + 1}/${ANSWER_ROUNDS}`}
        hint="詰まっても止めない"
        remaining={remaining}
        total={ANSWER_MS}
        onStop={onStop}
        showClock={false}
      />
      <p class="big-question">{question.text}</p>
      <Ring
        progress={remaining / ANSWER_MS}
        label={formatClock(remaining)}
        sub={`${index + 1} / ${ANSWER_ROUNDS}`}
      />
      {/* 一時停止も「次へ」も置かない。45秒は必ず経過する。 */}
      {canSwap && (
        <button class="ghost" onClick={onSwap}>
          この質問を差し替える（1回だけ）
        </button>
      )}
    </div>
  )
}

function CorrectScreen({
  three,
  pickedId,
  rewrite,
  remaining,
  onPick,
  onRewrite,
  onDone,
  onStop,
}: {
  three: Question[]
  pickedId: string | null
  rewrite: string
  remaining: number
  onPick: (id: string) => void
  onRewrite: (text: string) => void
  onDone: () => void
  onStop: () => void
}) {
  const picked = three.find((q) => q.id === pickedId)
  return (
    <div class="stage">
      <StageHead
        title="1問添削"
        hint={picked ? '言いたかったことを書き直す' : '一番言えなかった1問'}
        remaining={remaining}
        total={CORRECT_MS}
        onStop={onStop}
      />
      {!picked ? (
        <div class="pick">
          {three.map((q) => (
            <button key={q.id} class="pick-item" onClick={() => onPick(q.id)}>
              {q.text}
            </button>
          ))}
        </div>
      ) : (
        <div class="write">
          <p class="picked-question">{picked.text}</p>
          <textarea
            autofocus
            rows={6}
            placeholder="キーボードのマイクで話しても、打っても。2〜4文で。"
            value={rewrite}
            onInput={(e) => onRewrite((e.target as HTMLTextAreaElement).value)}
          />
          <button class="primary" onClick={onDone} disabled={rewrite.trim().length === 0}>
            書けた → 3回音読へ
          </button>
        </div>
      )}
    </div>
  )
}

function ShadowScreen({
  text,
  remaining,
  onStop,
}: {
  text: string
  remaining: number
  onStop: () => void
}) {
  const elapsed = Math.max(0, SHADOW_MS - remaining)
  const rep = Math.min(SHADOW_REPS, Math.floor(elapsed / SHADOW_REP_MS) + 1)
  return (
    <div class="stage">
      <StageHead
        title="3回音読"
        hint="声に出して読む"
        remaining={remaining}
        total={SHADOW_MS}
        onStop={onStop}
      />
      <p class="shadow-text">{text}</p>
      <div class="reps">
        {Array.from({ length: SHADOW_REPS }, (_, i) => (
          <i key={i} class={i < rep ? 'dot on' : 'dot'} />
        ))}
        <span>{rep} / {SHADOW_REPS}</span>
      </div>
    </div>
  )
}

function DoneScreen({
  reached,
  record,
  onClose,
}: {
  reached: number
  record: SessionRecord | undefined
  onClose: () => void
}) {
  return (
    <div class="done">
      <h1>おつかれさま</h1>
      <Dots reached={record?.reached ?? reached} />
      <p class="checklist-line">{CHECKLIST_LABEL}</p>
      {record?.rewrite && <p class="done-rewrite">{record.rewrite}</p>}
      <button class="primary" onClick={onClose}>
        閉じる
      </button>
    </div>
  )
}

function StageHead({
  title,
  hint,
  remaining,
  total,
  onStop,
  showClock = true,
}: {
  title: string
  hint: string
  remaining: number
  total: number
  onStop: () => void
  /** リングが同じ数字を出している工程では隠す。 */
  showClock?: boolean
}) {
  return (
    <header class="stage-head">
      <div
        class="bar"
        style={{ transform: `scaleX(${Math.min(1, Math.max(0, remaining / total))})` }}
      />
      <div class="stage-head-row">
        <div>
          <h2>{title}</h2>
          <p class="hint">{hint}</p>
        </div>
        <div class="stage-head-right">
          {showClock && <span class="clock">{formatClock(remaining)}</span>}
          <StopButton onStop={onStop} />
        </div>
      </div>
    </header>
  )
}

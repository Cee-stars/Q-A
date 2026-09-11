import { useCallback, useEffect, useRef, useState } from 'preact/hooks'
import {
  ANSWER_ROUNDS_MS,
  CORRECT_MS,
  formatClock,
  Phase,
  REVIEW_CARD_MS,
  REVIEW_MS,
  REVIEW_RECALL_MS,
  REVIEW_SLOTS,
  reachedFor,
  SETTLE_MS,
  SETTLE_STEP_MS,
  SETTLE_STEPS,
  STAGES,
  TOTAL_MS,
  WARMUP_PER_QUESTION_MS,
} from './session'
import { pickDaily, pickFocus, Question } from './questions'
import {
  advance as advanceItem,
  createItem,
  dueCount,
  ReviewItem,
  selectForReview,
} from './review'
import {
  DEFAULT_SETTINGS,
  loadRecords,
  loadReviews,
  loadSettings,
  recentQuestionIds,
  saveRecord,
  saveReviews,
  saveSettings,
  SessionRecord,
  Settings,
  streak,
  today,
} from './storage'
import { cueDone, cueNext, cueRep, cueStage, unlockAudio } from './cues'
import { keepAwake, releaseAwake } from './wakelock'

const CHECKLIST_LABEL = '質問応答（復習→3回回答→添削→定着）'

/** 工程2 の中身。復習カードを並べ、余った時間を質問の音読で埋める。 */
interface Segment {
  kind: 'card' | 'warmup'
  item: ReviewItem | null
  startAt: number
  ms: number
}

function buildSegments(cards: ReviewItem[]): Segment[] {
  const segments: Segment[] = cards.map((item, i) => ({
    kind: 'card',
    item,
    startAt: i * REVIEW_CARD_MS,
    ms: REVIEW_CARD_MS,
  }))
  const used = cards.length * REVIEW_CARD_MS
  if (used < REVIEW_MS) {
    segments.push({ kind: 'warmup', item: null, startAt: used, ms: REVIEW_MS - used })
  }
  return segments
}

function segmentAt(segments: Segment[], elapsed: number): { index: number; local: number } {
  for (let i = segments.length - 1; i >= 0; i--) {
    if (elapsed >= segments[i].startAt) return { index: i, local: elapsed - segments[i].startAt }
  }
  return { index: 0, local: 0 }
}

interface Run {
  phase: Phase
  endsAt: number
  ten: Question[]
  focus: Question | null
  round: number
  segments: Segment[]
  rewrite: string
  cueKey: string
}

const IDLE: Run = {
  phase: 'idle',
  endsAt: 0,
  ten: [],
  focus: null,
  round: 0,
  segments: [],
  rewrite: '',
  cueKey: '',
}

export function App() {
  const run = useRef<Run>(IDLE)
  const [, forceRender] = useState(0)
  const rerender = useCallback(() => forceRender((n) => n + 1), [])

  const [records, setRecords] = useState<SessionRecord[]>([])
  const [reviews, setReviews] = useState<ReviewItem[]>([])
  const [settings, setSettings] = useState<Settings>(DEFAULT_SETTINGS)
  const [now, setNow] = useState(Date.now())

  useEffect(() => {
    void loadRecords().then(setRecords)
    void loadReviews().then(setReviews)
    void loadSettings().then(setSettings)
  }, [])

  const persist = useCallback(
    (r: Run) => {
      const record: SessionRecord = {
        date: today(),
        reached: reachedFor(r.phase),
        questionIds: r.ten.map((q) => q.id),
        answeredIds: r.focus ? [r.focus.id] : [],
        pickedId: r.focus?.id ?? null,
        rewrite: r.rewrite,
        reviewed: r.segments.filter((s) => s.kind === 'card').length,
        quiet: settings.quiet,
        updatedAt: Date.now(),
      }
      void saveRecord(record).then(setRecords)
    },
    [settings.quiet],
  )

  /** 工程2を終えた時点で、出した復習カードを次の間隔へ進める。 */
  const commitReviews = useCallback(
    (r: Run) => {
      const date = today()
      const shown = new Set(
        r.segments.filter((s) => s.item).map((s) => s.item as ReviewItem).map((i) => i.id),
      )
      setReviews((current) => {
        const next = current.map((i) => (shown.has(i.id) ? advanceItem(i, date) : i))
        void saveReviews(next)
        return next
      })
    },
    [],
  )

  /** 添削した文を、後日もう一度答えさせるために積む。 */
  const enqueueRewrite = useCallback((r: Run) => {
    if (!r.focus || r.rewrite.trim().length === 0) return
    const item = createItem(r.focus.text, r.rewrite.trim(), today())
    setReviews((current) => {
      const next = [...current, item]
      void saveReviews(next)
      return next
    })
  }, [])

  const advance = useCallback(() => {
    const r = run.current
    const cue = { quiet: settings.quiet }

    switch (r.phase) {
      case 'review':
        commitReviews(r)
        r.phase = 'answer'
        r.round = 0
        r.endsAt = Date.now() + ANSWER_ROUNDS_MS[0]
        cueStage(cue)
        break
      case 'answer':
        if (r.round < ANSWER_ROUNDS_MS.length - 1) {
          r.round += 1
          r.endsAt = Date.now() + ANSWER_ROUNDS_MS[r.round]
          cueNext(cue)
        } else {
          r.phase = 'correct'
          r.endsAt = Date.now() + CORRECT_MS
          cueStage(cue)
        }
        break
      case 'correct':
        // 書けていなければ定着させるものが無い。到達4のまま終える。
        if (r.rewrite.trim().length === 0) {
          r.phase = 'done'
          releaseAwake()
          cueDone(cue)
        } else {
          enqueueRewrite(r)
          r.phase = 'settle'
          r.endsAt = Date.now() + SETTLE_MS
          cueStage(cue)
        }
        break
      case 'settle':
        r.phase = 'done'
        releaseAwake()
        cueDone(cue)
        break
      default:
        return
    }
    r.cueKey = ''
    setNow(Date.now())
    persist(r)
    rerender()
  }, [commitReviews, enqueueRewrite, persist, rerender, settings.quiet])

  // 工程の中の小さな切り替え（カードの答え表示、定着の3手）も音で伝える。
  // 画面を見ないので、これが無いと「いま何をする時間か」が分からない。
  const innerCue = useCallback(
    (r: Run, t: number) => {
      let key = ''
      if (r.phase === 'review') {
        const { index, local } = segmentAt(r.segments, REVIEW_MS - (r.endsAt - t))
        const seg = r.segments[index]
        key = `${index}:${seg.kind === 'card' && local >= REVIEW_RECALL_MS ? 'a' : 'q'}`
      } else if (r.phase === 'settle') {
        key = String(Math.floor((SETTLE_MS - (r.endsAt - t)) / SETTLE_STEP_MS))
      }
      if (key && key !== r.cueKey) {
        if (r.cueKey !== '') cueRep({ quiet: settings.quiet })
        r.cueKey = key
      }
    },
    [settings.quiet],
  )

  useEffect(() => {
    const id = window.setInterval(() => {
      const r = run.current
      const t = Date.now()
      setNow(t)
      if (r.phase === 'idle' || r.phase === 'done') return
      innerCue(r, t)
      if (t >= r.endsAt) advance()
    }, 100)
    return () => window.clearInterval(id)
  }, [advance, innerCue])

  const start = useCallback(() => {
    unlockAudio()
    keepAwake()
    const date = today()
    const ten = pickDaily(date, recentQuestionIds(records))
    run.current = {
      ...IDLE,
      phase: 'review',
      endsAt: Date.now() + REVIEW_MS,
      ten,
      focus: pickFocus(date, ten),
      segments: buildSegments(selectForReview(reviews, date, REVIEW_SLOTS)),
    }
    cueStage({ quiet: settings.quiet })
    setNow(Date.now())
    persist(run.current)
    rerender()
  }, [persist, records, reviews, rerender, settings.quiet])

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
          reviews={reviews}
          quiet={settings.quiet}
          onToggleQuiet={toggleQuiet}
          onStart={start}
        />
      )}

      {r.phase === 'review' && (
        <ReviewScreen
          segments={r.segments}
          questions={r.ten}
          remaining={remaining}
          onStop={stop}
        />
      )}

      {r.phase === 'answer' && r.focus && (
        <AnswerScreen question={r.focus} round={r.round} remaining={remaining} onStop={stop} />
      )}

      {r.phase === 'correct' && r.focus && (
        <CorrectScreen
          question={r.focus}
          rewrite={r.rewrite}
          remaining={remaining}
          onRewrite={setRewrite}
          onDone={advance}
          onStop={stop}
        />
      )}

      {r.phase === 'settle' && (
        <SettleScreen text={r.rewrite} remaining={remaining} onStop={stop} />
      )}

      {r.phase === 'done' && (
        <DoneScreen record={records.find((rec) => rec.date === today())} onClose={stop} />
      )}
    </main>
  )
}

/* ---------- 部品 ---------- */

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

function Dots({ reached }: { reached: number }) {
  return (
    <span class="dots" title={STAGES.map((s) => s.label).join(' → ')}>
      {STAGES.map((stage, i) => (
        <i key={stage.id} class={i < reached ? 'dot on' : 'dot'} />
      ))}
    </span>
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
          <button class="stop" onClick={onStop} aria-label="セッションを終了">
            終了
          </button>
        </div>
      </div>
    </header>
  )
}

/* ---------- 工程2: 復習 ---------- */

function ReviewScreen({
  segments,
  questions,
  remaining,
  onStop,
}: {
  segments: Segment[]
  questions: Question[]
  remaining: number
  onStop: () => void
}) {
  const elapsed = Math.max(0, REVIEW_MS - remaining)
  const { index, local } = segmentAt(segments, elapsed)
  const seg = segments[index]
  const cards = segments.filter((s) => s.kind === 'card').length

  if (seg.kind === 'warmup') {
    const i = Math.floor(local / WARMUP_PER_QUESTION_MS) % Math.max(1, questions.length)
    return (
      <div class="stage">
        <StageHead
          title="復習"
          hint="考えず口だけ動かす"
          remaining={remaining}
          total={REVIEW_MS}
          onStop={onStop}
        />
        <div class="card">
          <p class="card-kicker">音読 {i + 1}</p>
          <p class="card-question">{questions[i]?.text}</p>
        </div>
      </div>
    )
  }

  const item = seg.item as ReviewItem
  const revealed = local >= REVIEW_RECALL_MS
  return (
    <div class="stage">
      <StageHead
        title={`復習 ${index + 1}/${cards}`}
        hint={revealed ? '答えを見て読む' : '見ずに思い出して言う'}
        remaining={remaining}
        total={REVIEW_MS}
        onStop={onStop}
      />
      <div class={revealed ? 'card revealed' : 'card'}>
        <p class="card-kicker">{item.createdAt} の添削</p>
        <p class="card-question">{item.question}</p>
        {revealed ? (
          <p class="card-answer">{item.sentence}</p>
        ) : (
          <p class="card-veil">思い出して、声に出す</p>
        )}
      </div>
    </div>
  )
}

/* ---------- 工程3: 3回回答 ---------- */

const ROUND_HINTS = ['詰まっても止めない', 'もう一度。今度は速く', '最後。25秒に収める']

function AnswerScreen({
  question,
  round,
  remaining,
  onStop,
}: {
  question: Question
  round: number
  remaining: number
  onStop: () => void
}) {
  const total = ANSWER_ROUNDS_MS[round]
  return (
    <div class="stage stage-answer">
      <StageHead
        title={`3回回答 ${round + 1}/${ANSWER_ROUNDS_MS.length}`}
        hint={ROUND_HINTS[round]}
        remaining={remaining}
        total={total}
        onStop={onStop}
        showClock={false}
      />
      <p class="big-question">{question.text}</p>
      <Ring
        progress={remaining / total}
        label={formatClock(remaining)}
        sub={`${round + 1} / ${ANSWER_ROUNDS_MS.length}`}
      />
      {/* 一時停止も「次へ」も置かない。時間は必ず経過する。 */}
    </div>
  )
}

/* ---------- 工程4: 添削 ---------- */

function CorrectScreen({
  question,
  rewrite,
  remaining,
  onRewrite,
  onDone,
  onStop,
}: {
  question: Question
  rewrite: string
  remaining: number
  onRewrite: (text: string) => void
  onDone: () => void
  onStop: () => void
}) {
  return (
    <div class="stage">
      <StageHead
        title="添削"
        hint="3回目の答えを書き直す"
        remaining={remaining}
        total={CORRECT_MS}
        onStop={onStop}
      />
      <div class="write">
        <p class="picked-question">{question.text}</p>
        <textarea
          autofocus
          rows={6}
          placeholder="キーボードのマイクで話しても、打っても。2〜4文で。"
          value={rewrite}
          onInput={(e) => onRewrite((e.target as HTMLTextAreaElement).value)}
        />
        <p class="note">この文は明日・3日後・7日後・21日後に質問として戻ってくる。</p>
        <button class="primary" onClick={onDone} disabled={rewrite.trim().length === 0}>
          書けた → 定着へ
        </button>
      </div>
    </div>
  )
}

/* ---------- 工程5: 定着 ---------- */

function SettleScreen({
  text,
  remaining,
  onStop,
}: {
  text: string
  remaining: number
  onStop: () => void
}) {
  const elapsed = Math.max(0, SETTLE_MS - remaining)
  const step = Math.min(SETTLE_STEPS.length - 1, Math.floor(elapsed / SETTLE_STEP_MS))
  const hidden = SETTLE_STEPS[step].kind === 'recall'
  return (
    <div class="stage">
      <StageHead
        title="定着"
        hint={SETTLE_STEPS[step].label}
        remaining={remaining}
        total={SETTLE_MS}
        onStop={onStop}
      />
      {hidden ? (
        <p class="settle-text hidden-text">見ずに言う</p>
      ) : (
        <p class="settle-text">{text}</p>
      )}
      <div class="reps">
        {SETTLE_STEPS.map((s, i) => (
          <i key={s.kind + i} class={i <= step ? 'dot on' : 'dot'} />
        ))}
        <span>
          {step + 1} / {SETTLE_STEPS.length}
        </span>
      </div>
    </div>
  )
}

/* ---------- 待機・完了 ---------- */

function IdleScreen({
  records,
  reviews,
  quiet,
  onToggleQuiet,
  onStart,
}: {
  records: SessionRecord[]
  reviews: ReviewItem[]
  quiet: boolean
  onToggleQuiet: () => void
  onStart: () => void
}) {
  const days = streak(records)
  const due = dueCount(reviews, today())
  const todayRecord = records.find((r) => r.date === today())
  return (
    <div class="idle">
      <header class="idle-head">
        <h1>質問応答</h1>
        <p class="sub">復習 → 3回回答 → 添削 → 定着 · {formatClock(TOTAL_MS)}</p>
      </header>

      <button class="start" onClick={onStart}>
        <span class="start-main">{todayRecord?.reached === 5 ? 'もう一度' : '開始'}</span>
        <span class="start-sub">タップしたら喋りはじめる</span>
      </button>

      <div class="idle-meta">
        <button class={quiet ? 'chip on' : 'chip'} onClick={onToggleQuiet}>
          小声モード{quiet ? ' ON' : ' OFF'}
        </button>
        {due > 0 && <span class="chip flat">復習 {due}</span>}
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

function DoneScreen({
  record,
  onClose,
}: {
  record: SessionRecord | undefined
  onClose: () => void
}) {
  return (
    <div class="done">
      <h1>おつかれさま</h1>
      <Dots reached={record?.reached ?? 5} />
      <p class="checklist-line">{CHECKLIST_LABEL}</p>
      {record?.rewrite && <p class="done-rewrite">{record.rewrite}</p>}
      <p class="note">明日また質問として出る。</p>
      <button class="primary" onClick={onClose}>
        閉じる
      </button>
    </div>
  )
}

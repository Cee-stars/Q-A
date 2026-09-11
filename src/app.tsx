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
import { correct, describeError, generateQuestions, type Correction } from './claude'
import { DEFAULT_CORRECTION_PROMPT, DEFAULT_GENERATION_PROMPT } from './prompts'
import {
  advance as advanceItem,
  createItem,
  dueCount,
  ReviewItem,
  selectForReview,
} from './review'
import {
  DEFAULT_SETTINGS,
  hasApiKey,
  loadAsked,
  loadGenerated,
  loadRecords,
  loadReviews,
  loadSettings,
  recentQuestionIds,
  saveAsked,
  saveGenerated,
  saveRecord,
  saveReviews,
  saveSettings,
  SessionRecord,
  Settings,
  streak,
  today,
  tomorrow,
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
  /** 学習者が書いた（話した）そのままの文。添削が失敗してもこれは残る。 */
  answer: string
  /** 工程5と復習に送る文。添削が返ればそちらに差し替わる。 */
  rewrite: string
  correcting: boolean
  correction: Correction | null
  error: string | null
  cueKey: string
}

const IDLE: Run = {
  phase: 'idle',
  endsAt: 0,
  ten: [],
  focus: null,
  round: 0,
  segments: [],
  answer: '',
  rewrite: '',
  correcting: false,
  correction: null,
  error: null,
  cueKey: '',
}

export function App() {
  const run = useRef<Run>(IDLE)
  const [, forceRender] = useState(0)
  const rerender = useCallback(() => forceRender((n) => n + 1), [])

  const [records, setRecords] = useState<SessionRecord[]>([])
  const [reviews, setReviews] = useState<ReviewItem[]>([])
  const [settings, setSettings] = useState<Settings>(DEFAULT_SETTINGS)
  const [prefetched, setPrefetched] = useState<Question[] | null>(null)
  const [showSettings, setShowSettings] = useState(false)
  const [now, setNow] = useState(Date.now())

  useEffect(() => {
    void loadRecords().then(setRecords)
    void loadReviews().then(setReviews)
    void loadSettings().then(setSettings)
    void loadGenerated(today()).then(setPrefetched)
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
    const item = createItem(r.focus.text, r.focus.ja, r.rewrite.trim(), today())
    setReviews((current) => {
      const next = [...current, item]
      void saveReviews(next)
      return next
    })
  }, [])

  /**
   * 翌日ぶんを先読みする。セッションが終わってから走らせるので、
   * 練習の待ち時間にはならない。失敗しても黙って種問題バンクに落ちる。
   */
  const prefetchNext = useCallback(async () => {
    if (!hasApiKey(settings)) return
    const date = tomorrow()
    if (await loadGenerated(date)) return
    try {
      const generated = await generateQuestions(settings, await loadAsked())
      await saveGenerated(date, generated)
    } catch {
      // 明日は種問題バンクで練習すればよい。ここで利用者に知らせることは無い。
    }
  }, [settings])

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
          void prefetchNext()
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
        void prefetchNext()
        break
      default:
        return
    }
    r.cueKey = ''
    setNow(Date.now())
    persist(r)
    rerender()
  }, [commitReviews, enqueueRewrite, persist, prefetchNext, rerender, settings.quiet])

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

  const begin = useCallback(
    (ten: Question[]) => {
      const date = today()
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
      // 実際に出した問題を控える。出どころが種問題バンクでも生成でも、
      // 次の生成はこれを除外指定として受け取る。
      void loadAsked().then((asked) => saveAsked([...asked, ...ten.map((q) => q.text)]))
    },
    [persist, reviews, rerender, settings.quiet],
  )

  const start = useCallback(() => {
    unlockAudio()
    keepAwake()
    const date = today()
    // 前夜に先読みしたぶんがあればそれを使う。無ければ種問題バンク。
    // ここで API を待つことは絶対にしない（開いた瞬間に喋り始められることが最優先）。
    begin(prefetched ?? pickDaily(date, recentQuestionIds(records)))
  }, [begin, prefetched, records])

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

  const setAnswer = useCallback(
    (text: string) => {
      const r = run.current
      r.answer = text
      // 添削が返らなくても自分の文は残る。時間切れでも工程5と復習に送れる。
      if (!r.correction) r.rewrite = text
      rerender()
    },
    [rerender],
  )

  const requestCorrection = useCallback(async () => {
    const r = run.current
    if (r.correcting || r.answer.trim().length === 0) return
    r.correcting = true
    r.error = null
    rerender()
    try {
      const result = await correct(settings, r.focus?.text ?? '', r.answer.trim())
      r.correction = result
      r.rewrite = result.corrected
    } catch (error) {
      r.error = describeError(error)
    } finally {
      r.correcting = false
      rerender()
    }
  }, [rerender, settings])

  const r = run.current
  const remaining = Math.max(0, r.endsAt - now)

  if (showSettings) {
    return (
      <main class="screen">
        <SettingsScreen
          settings={settings}
          onSave={(next) => {
            setSettings(next)
            void saveSettings(next)
          }}
          onClose={() => setShowSettings(false)}
        />
      </main>
    )
  }

  return (
    <main class={`screen screen-${r.phase}`}>
      {r.phase === 'idle' && (
        <IdleScreen
          records={records}
          reviews={reviews}
          settings={settings}
          prefetched={prefetched !== null}
          onToggleQuiet={toggleQuiet}
          onOpenSettings={() => setShowSettings(true)}
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
          answer={r.answer}
          correcting={r.correcting}
          correction={r.correction}
          error={r.error}
          canCorrect={hasApiKey(settings)}
          lastCorrected={records.find((rec) => rec.rewrite)?.rewrite ?? null}
          remaining={remaining}
          onAnswer={setAnswer}
          onCorrect={requestCorrection}
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
          <p class="card-ja">{questions[i]?.ja}</p>
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
        {item.questionJa && <p class="card-ja">{item.questionJa}</p>}
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
      <p class="big-question-ja">{question.ja}</p>
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
  answer,
  correcting,
  correction,
  error,
  canCorrect,
  lastCorrected,
  remaining,
  onAnswer,
  onCorrect,
  onDone,
  onStop,
}: {
  question: Question
  answer: string
  correcting: boolean
  correction: Correction | null
  error: string | null
  canCorrect: boolean
  lastCorrected: string | null
  remaining: number
  onAnswer: (text: string) => void
  onCorrect: () => void
  onDone: () => void
  onStop: () => void
}) {
  return (
    <div class="stage">
      <StageHead
        title="添削"
        hint={correction ? '直った文を確認する' : '3回目の答えを書く'}
        remaining={remaining}
        total={CORRECT_MS}
        onStop={onStop}
      />
      <div class="write">
        <p class="picked-question">
          {question.text}
          <span class="picked-question-ja">{question.ja}</span>
        </p>

        {correction ? (
          <div class="corrected">
            <p class="corrected-text">{correction.corrected}</p>
            {correction.fixes.length > 0 && (
              <ul class="fixes">
                {correction.fixes.map((fix, i) => (
                  <li key={i}>
                    <s>{fix.was}</s> → <b>{fix.now}</b>
                    <span> {fix.why}</span>
                  </li>
                ))}
              </ul>
            )}
          </div>
        ) : correcting ? (
          // 待ち時間を無音にしない。前回の添削文を出して読ませておく。
          <div class="waiting">
            <p class="waiting-label">添削中…</p>
            {lastCorrected && <p class="waiting-text">{lastCorrected}</p>}
          </div>
        ) : (
          <textarea
            autofocus
            rows={6}
            placeholder="キーボードのマイクで話しても、打っても。2〜4文で。"
            value={answer}
            onInput={(e) => onAnswer((e.target as HTMLTextAreaElement).value)}
          />
        )}

        {error && <p class="error">{error}　自分の文のまま進みます</p>}
        <p class="note">この文は明日・3日後・7日後・21日後に質問として戻ってくる。</p>

        {canCorrect && !correction && !error ? (
          <button
            class="primary"
            onClick={onCorrect}
            disabled={correcting || answer.trim().length === 0}
          >
            {correcting ? '添削中…' : '添削する'}
          </button>
        ) : (
          <>
            <button class="primary" onClick={onDone} disabled={answer.trim().length === 0}>
              定着へ
            </button>
            {/* 添削が落ちても練習は止めない。やり直しは任意。 */}
            {error && !correcting && (
              <button class="ghost" onClick={onCorrect}>
                もう一度添削する
              </button>
            )}
          </>
        )}
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
  settings,
  prefetched,
  onToggleQuiet,
  onOpenSettings,
  onStart,
}: {
  records: SessionRecord[]
  reviews: ReviewItem[]
  settings: Settings
  prefetched: boolean
  onToggleQuiet: () => void
  onOpenSettings: () => void
  onStart: () => void
}) {
  const days = streak(records)
  const due = dueCount(reviews, today())
  const todayRecord = records.find((r) => r.date === today())
  return (
    <div class="idle">
      <header class="idle-head">
        <div class="idle-title">
          <h1>質問応答</h1>
          <button class="stop" onClick={onOpenSettings}>
            設定
          </button>
        </div>
        <p class="sub">復習 → 3回回答 → 添削 → 定着 · {formatClock(TOTAL_MS)}</p>
      </header>

      <button class="start" onClick={onStart}>
        <span class="start-main">{todayRecord?.reached === 5 ? 'もう一度' : '開始'}</span>
        <span class="start-sub">タップしたら喋りはじめる</span>
      </button>

      <div class="idle-meta">
        <button class={settings.quiet ? 'chip on' : 'chip'} onClick={onToggleQuiet}>
          小声モード{settings.quiet ? ' ON' : ' OFF'}
        </button>
        {prefetched && <span class="chip flat">今日のぶん生成済み</span>}
        {!hasApiKey(settings) && <span class="chip flat dim">種問題で練習中</span>}
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

/* ---------- 設定 ---------- */

function SettingsScreen({
  settings,
  onSave,
  onClose,
}: {
  settings: Settings
  onSave: (next: Settings) => void
  onClose: () => void
}) {
  const [draft, setDraft] = useState<Settings>(settings)
  const field = (key: keyof Settings) => (e: Event) =>
    setDraft({ ...draft, [key]: (e.target as HTMLInputElement | HTMLTextAreaElement).value })

  return (
    <div class="settings">
      <header class="idle-head">
        <div class="idle-title">
          <h1>設定</h1>
          <button class="stop" onClick={onClose}>
            戻る
          </button>
        </div>
      </header>

      <label>
        <span>Claude API キー</span>
        <input
          type="password"
          autocomplete="off"
          placeholder="sk-ant-..."
          value={draft.apiKey}
          onInput={field('apiKey')}
        />
        <em>この端末にだけ保存される。空のままでも種問題バンクで練習はできる。</em>
      </label>

      <label>
        <span>レベル</span>
        <input type="text" value={draft.level} onInput={field('level')} />
      </label>

      <label>
        <span>話せるようになりたい場面</span>
        <input type="text" value={draft.goal} onInput={field('goal')} />
      </label>

      <label>
        <span>扱いたいテーマ</span>
        <input type="text" value={draft.themes} onInput={field('themes')} />
      </label>

      <details>
        <summary>プロンプトを編集する</summary>
        <label>
          <span>質問生成</span>
          <textarea
            rows={10}
            placeholder={DEFAULT_GENERATION_PROMPT}
            value={draft.generationPrompt}
            onInput={field('generationPrompt')}
          />
        </label>
        <label>
          <span>添削</span>
          <textarea
            rows={10}
            placeholder={DEFAULT_CORRECTION_PROMPT}
            value={draft.correctionPrompt}
            onInput={field('correctionPrompt')}
          />
        </label>
        <em>空にすると既定のプロンプトに戻る。</em>
      </details>

      <button
        class="primary"
        onClick={() => {
          onSave(draft)
          onClose()
        }}
      >
        保存
      </button>
    </div>
  )
}

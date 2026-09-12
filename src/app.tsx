import { useCallback, useEffect, useRef, useState } from 'preact/hooks'
import {
  ATTEMPT_MS,
  formatClock,
  MODEL_MS,
  Phase,
  REVIEW_CARD_MS,
  REVIEW_MS,
  REVIEW_RECALL_MS,
  REVIEW_SLOTS,
  PARTIAL_WORDS,
  RESPEAK_ROUNDS_MS,
  RESPEAK_SCAFFOLD,
  reachedFor,
  STAGES,
  TOTAL_MS,
  WARMUP_PER_QUESTION_MS,
} from './session'
import { pickDaily, pickFocus, type Level, type Question } from './questions'
import {
  allPlaylists,
  findPlaylist,
  newPlaylist,
  newQuestion,
  type Playlist,
  type QuestionDraft,
} from './playlists'
import { correct, describeError, fillQuestion, generateQuestions, type Correction } from './claude'
import { DEFAULT_CORRECTION_PROMPT, DEFAULT_GENERATION_PROMPT } from './prompts'
import {
  advance as advanceItem,
  createItem,
  dueCount,
  type ReviewItem,
  selectForReview,
} from './review'
import {
  canSync,
  DEFAULT_SETTINGS,
  hasApiKey,
  loadAsked,
  loadGenerated,
  loadPlaylists,
  loadRecords,
  loadReviews,
  loadSettings,
  recentQuestionIds,
  saveAsked,
  saveGenerated,
  savePlaylists,
  saveRecord,
  saveRecords,
  saveReviews,
  saveSettings,
  type SessionRecord,
  type Settings,
  streak,
  today,
  tomorrow,
} from './storage'
import { emptySnapshot, syncOnce, SyncError, type Snapshot } from './sync'
import { touch } from './playlists'
import { cueDone, cueNext, cueRep, cueStage, unlockAudio } from './cues'
import { speak, stopSpeaking, supported as speechSupported, unlockSpeech } from './speech'
import { keepAwake, releaseAwake } from './wakelock'

const CHECKLIST_LABEL = '質問応答（復習→挑戦→手本→言い直し）'

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
  /** 工程5の何回目か。 */
  round: number
  segments: Segment[]
  /** 学習者が書いた（話した）そのままの文。 */
  answer: string
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
  correcting: false,
  correction: null,
  error: null,
  cueKey: '',
}

/**
 * その日の持ち帰り。言い直しで口に出し、後日の復習に入る文。
 * 添削が返ればそれ、自分で書いていればそれ、何も無ければ手本。
 * **必ず何かが残る**のが要点で、何も書けなかった日でも持ち帰りが空にならない。
 */
function takeaway(r: Run): string {
  if (r.correction) return r.correction.corrected
  if (r.answer.trim()) return r.answer.trim()
  return r.focus?.model ?? ''
}

export function App() {
  const run = useRef<Run>(IDLE)
  const [, forceRender] = useState(0)
  const rerender = useCallback(() => forceRender((n) => n + 1), [])

  const [records, setRecords] = useState<SessionRecord[]>([])
  const [reviews, setReviews] = useState<ReviewItem[]>([])
  const [playlists, setPlaylists] = useState<Playlist[]>([])
  const [settings, setSettings] = useState<Settings>(DEFAULT_SETTINGS)
  const [prefetched, setPrefetched] = useState<Question[] | null>(null)
  const [screen, setScreen] = useState<'drill' | 'settings' | 'library'>('drill')
  const [syncState, setSyncState] = useState<'idle' | 'running' | 'ok' | 'error'>('idle')
  const [syncError, setSyncError] = useState<string | null>(null)
  const [now, setNow] = useState(Date.now())

  useEffect(() => {
    void loadRecords().then(setRecords)
    void loadReviews().then(setReviews)
    void loadPlaylists().then(setPlaylists)
    void loadSettings().then(setSettings)
    void loadGenerated(today()).then(setPrefetched)
  }, [])


  const voice = { quiet: settings.quiet, enabled: settings.speak }

  /**
   * 1往復ぶんの同期。読んで合流させて書き戻し、合流結果を端末にも反映する。
   * 失敗しても練習は止めない（記録は端末に残っている）。
   */
  const sync = useCallback(async () => {
    if (!canSync(settings)) return
    setSyncState('running')
    setSyncError(null)
    try {
      const local: Snapshot = {
        ...emptySnapshot(),
        updatedAt: Date.now(),
        records: await loadRecords(),
        reviews: await loadReviews(),
        playlists: await loadPlaylists(),
        asked: await loadAsked(),
      }
      const { gistId, merged } = await syncOnce(settings.syncToken, settings.syncGistId, local)

      await Promise.all([
        saveReviews(merged.reviews),
        savePlaylists(merged.playlists),
        saveAsked(merged.asked),
        saveRecords(merged.records),
      ])
      setRecords(merged.records)
      setReviews(merged.reviews)
      setPlaylists(merged.playlists)
      if (gistId !== settings.syncGistId) {
        setSettings((current) => {
          const next = { ...current, syncGistId: gistId }
          void saveSettings(next)
          return next
        })
      }
      setSyncState('ok')
    } catch (error) {
      setSyncError(error instanceof SyncError ? error.message : '同期に失敗しました')
      setSyncState('error')
    }
  }, [settings])


  const persist = useCallback(
    (r: Run) => {
      const record: SessionRecord = {
        date: today(),
        reached: reachedFor(r.phase),
        questionIds: r.ten.map((q) => q.id),
        answeredIds: r.focus ? [r.focus.id] : [],
        pickedId: r.focus?.id ?? null,
        rewrite: takeaway(r),
        reviewed: r.segments.filter((s) => s.kind === 'card').length,
        quiet: settings.quiet,
        updatedAt: Date.now(),
      }
      void saveRecord(record).then(setRecords)
    },
    [settings.quiet],
  )

  const commitReviews = useCallback((r: Run) => {
    const date = today()
    const shown = new Set(
      r.segments.filter((s) => s.item).map((s) => (s.item as ReviewItem).id),
    )
    setReviews((current) => {
      const next = current.map((i) => (shown.has(i.id) ? advanceItem(i, date) : i))
      void saveReviews(next)
      return next
    })
  }, [])

  const enqueueTakeaway = useCallback((r: Run) => {
    const sentence = takeaway(r)
    if (!r.focus || sentence.trim().length === 0) return
    const item = createItem(r.focus.text, r.focus.ja, sentence.trim(), today())
    setReviews((current) => {
      const next = [...current, item]
      void saveReviews(next)
      return next
    })
  }, [])

  const prefetchNext = useCallback(async () => {
    if (!hasApiKey(settings)) return
    const date = tomorrow()
    if (await loadGenerated(date)) return
    try {
      const generated = await generateQuestions(settings, await loadAsked())
      await saveGenerated(date, generated)
    } catch {
      // 明日は種問題バンクで練習すればよい。
    }
  }, [settings])

  const advance = useCallback(() => {
    const r = run.current
    const cue = { quiet: settings.quiet }

    switch (r.phase) {
      case 'review':
        commitReviews(r)
        r.phase = 'attempt'
        r.endsAt = Date.now() + ATTEMPT_MS
        cueStage(cue)
        if (r.focus) speak(r.focus.text, voice)
        break
      case 'attempt':
        r.phase = 'model'
        r.endsAt = Date.now() + MODEL_MS
        cueStage(cue)
        // 手本を聞かせる。真似して言うには、読むだけでなく音が要る。
        speak(takeaway(r), voice)
        break
      case 'model':
        enqueueTakeaway(r)
        r.phase = 'respeak'
        r.round = 0
        r.endsAt = Date.now() + RESPEAK_ROUNDS_MS[0]
        stopSpeaking()
        cueStage(cue)
        break
      case 'respeak':
        if (r.round < RESPEAK_ROUNDS_MS.length - 1) {
          r.round += 1
          r.endsAt = Date.now() + RESPEAK_ROUNDS_MS[r.round]
          cueNext(cue)
        } else {
          r.phase = 'done'
          releaseAwake()
          cueDone(cue)
          void prefetchNext()
          if (settings.syncAuto) void sync()
        }
        break
      default:
        return
    }
    r.cueKey = ''
    setNow(Date.now())
    persist(r)
    rerender()
  }, [
    commitReviews,
    enqueueTakeaway,
    persist,
    prefetchNext,
    rerender,
    settings.quiet,
    settings.syncAuto,
    sync,
    voice,
  ])

  const innerCue = useCallback(
    (r: Run, t: number) => {
      if (r.phase !== 'review') return
      const { index, local } = segmentAt(r.segments, REVIEW_MS - (r.endsAt - t))
      const seg = r.segments[index]
      const revealed = seg.kind === 'card' && local >= REVIEW_RECALL_MS
      const key = `${index}:${revealed ? 'a' : 'q'}`
      if (key === r.cueKey) return
      if (r.cueKey !== '') cueRep({ quiet: settings.quiet })
      // 答えが出た瞬間に読み上げる。思い出している間は黙っている。
      if (revealed && seg.item) speak(seg.item.sentence, voice)
      r.cueKey = key
    },
    [settings.quiet, voice],
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
    unlockSpeech()
    keepAwake()
    const date = today()
    const pool = findPlaylist(playlists, settings.playlistId).questions
    const ten = prefetched ?? pickDaily(date, pool, recentQuestionIds(records))
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
    void loadAsked().then((asked) => saveAsked([...asked, ...ten.map((q) => q.text)]))
  }, [persist, playlists, prefetched, records, reviews, rerender, settings])

  const stop = useCallback(() => {
    persist(run.current)
    releaseAwake()
    stopSpeaking()
    run.current = { ...IDLE }
    rerender()
  }, [persist, rerender])

  const patchSettings = useCallback(
    (patch: Partial<Settings>) => {
      setSettings((current) => {
        const next = { ...current, ...patch }
        void saveSettings(next)
        return next
      })
    },
    [],
  )

  const setAnswer = useCallback(
    (text: string) => {
      run.current.answer = text
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
      speak(result.corrected, voice)
    } catch (error) {
      r.error = describeError(error)
    } finally {
      r.correcting = false
      rerender()
    }
  }, [rerender, settings, voice])

  const r = run.current
  const remaining = Math.max(0, r.endsAt - now)

  if (screen === 'settings') {
    return (
      <main class="screen">
        <SettingsScreen
          settings={settings}
          onSave={(next) => {
            setSettings(next)
            void saveSettings(next)
          }}
          onClose={() => setScreen('drill')}
        />
      </main>
    )
  }

  if (screen === 'library') {
    return (
      <main class="screen">
        <LibraryScreen
          playlists={playlists}
          settings={settings}
          onChange={(next, changedId) => {
            // 触った束だけ時刻を進める。これが無いと合流で古いほうが勝つ。
            const stamped = changedId
              ? next.map((p) => (p.id === changedId ? touch(p) : p))
              : next
            setPlaylists(stamped)
            void savePlaylists(stamped)
            if (settings.syncAuto) void sync()
          }}
          onSelect={(id) => patchSettings({ playlistId: id })}
          onClose={() => setScreen('drill')}
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
          playlists={playlists}
          settings={settings}
          prefetched={prefetched !== null}
          syncState={syncState}
          syncError={syncError}
          onSync={() => void sync()}
          onPatchSettings={patchSettings}
          onOpenSettings={() => setScreen('settings')}
          onOpenLibrary={() => setScreen('library')}
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

      {r.phase === 'attempt' && r.focus && (
        <AttemptScreen question={r.focus} remaining={remaining} onStop={stop} />
      )}

      {r.phase === 'model' && r.focus && (
        <ModelScreen
          question={r.focus}
          answer={r.answer}
          correcting={r.correcting}
          correction={r.correction}
          error={r.error}
          canCorrect={hasApiKey(settings)}
          remaining={remaining}
          onAnswer={setAnswer}
          onCorrect={requestCorrection}
          onSpeak={() => speak(takeaway(r), voice)}
          onDone={advance}
          onStop={stop}
        />
      )}

      {r.phase === 'respeak' && r.focus && (
        <RespeakScreen
          question={r.focus}
          sentence={takeaway(r)}
          round={r.round}
          remaining={remaining}
          onStop={stop}
        />
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
        <p class="card-kicker">{item.createdAt} の持ち帰り</p>
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

/* ---------- 工程3: 挑戦 ---------- */

function AttemptScreen({
  question,
  remaining,
  onStop,
}: {
  question: Question
  remaining: number
  onStop: () => void
}) {
  return (
    <div class="stage stage-answer">
      <StageHead
        title="挑戦"
        hint="言えなければ日本語でいい"
        remaining={remaining}
        total={ATTEMPT_MS}
        onStop={onStop}
        showClock={false}
      />
      <p class="big-question">{question.text}</p>
      <p class="big-question-ja">{question.ja}</p>
      <Ring progress={remaining / ATTEMPT_MS} label={formatClock(remaining)} sub="まず自力で" />
      {/* 一時停止も「次へ」も置かない。45秒は必ず経過する。 */}
    </div>
  )
}

/* ---------- 工程4: 手本 ---------- */

function ModelScreen({
  question,
  answer,
  correcting,
  correction,
  error,
  canCorrect,
  remaining,
  onAnswer,
  onCorrect,
  onSpeak,
  onDone,
  onStop,
}: {
  question: Question
  answer: string
  correcting: boolean
  correction: Correction | null
  error: string | null
  canCorrect: boolean
  remaining: number
  onAnswer: (text: string) => void
  onCorrect: () => void
  onSpeak: () => void
  onDone: () => void
  onStop: () => void
}) {
  const shown = correction?.corrected ?? question.model
  return (
    <div class="stage">
      <StageHead
        title="手本"
        hint={correction ? '直った文' : '1文目は真似、2文目は自分のことに'}
        remaining={remaining}
        total={MODEL_MS}
        onStop={onStop}
      />
      <div class="write">
        <p class="picked-question">
          {question.text}
          <span class="picked-question-ja">{question.ja}</span>
        </p>

        <div class="model-answer">
          <p class="corrected-text">{shown}</p>
          {speechSupported() && (
            <button class="ghost small" onClick={onSpeak}>
              もう一度聞く
            </button>
          )}
        </div>

        {correction && correction.fixes.length > 0 && (
          <ul class="fixes">
            {correction.fixes.map((fix, i) => (
              <li key={i}>
                <s>{fix.was}</s> → <b>{fix.now}</b>
                <span> {fix.why}</span>
              </li>
            ))}
          </ul>
        )}

        {canCorrect && !correction && (
          <>
            <textarea
              rows={3}
              placeholder="自分が言おうとしたこと（任意）。書けば直してもらえる。"
              value={answer}
              onInput={(e) => onAnswer((e.target as HTMLTextAreaElement).value)}
            />
            <button
              class="ghost"
              onClick={onCorrect}
              disabled={correcting || answer.trim().length === 0}
            >
              {correcting ? '添削中…' : '自分の文を添削する'}
            </button>
          </>
        )}

        {error && <p class="error">{error}　手本のまま進みます</p>}
        <p class="note">この文は明日・3日後・7日後・21日後に質問として戻ってくる。</p>
        <button class="primary" onClick={onDone}>
          言い直しへ
        </button>
      </div>
    </div>
  )
}

/* ---------- 工程5: 言い直し ---------- */

function RespeakScreen({
  question,
  sentence,
  round,
  remaining,
  onStop,
}: {
  question: Question
  sentence: string
  round: number
  remaining: number
  onStop: () => void
}) {
  const total = RESPEAK_ROUNDS_MS[round]
  // 足場は急に外さず、全表示 → 最初の3語 → 非表示 と段階的に減らす。
  const scaffold = RESPEAK_SCAFFOLD[round] ?? 'none'
  const words = sentence.split(/\s+/)
  const hint =
    scaffold === 'full'
      ? '手本を見ながら言う'
      : scaffold === 'partial'
        ? '書き出しだけ見て、続きは自分で'
        : '見ずに言い切る。2文目は自分のことで'
  return (
    <div class="stage stage-answer">
      <StageHead
        title={`言い直し ${round + 1}/${RESPEAK_ROUNDS_MS.length}`}
        hint={hint}
        remaining={remaining}
        total={total}
        onStop={onStop}
        showClock={false}
      />
      <p class="big-question">{question.text}</p>
      <p class="big-question-ja">{question.ja}</p>
      {scaffold === 'full' && <p class="respeak-model">{sentence}</p>}
      {scaffold === 'partial' && (
        <p class="respeak-model">
          {words.slice(0, PARTIAL_WORDS).join(' ')}
          <span class="fade-rest"> …</span>
        </p>
      )}
      {scaffold === 'none' && <p class="respeak-model hidden-text">見ずに言う</p>}
      <Ring
        progress={remaining / total}
        label={formatClock(remaining)}
        sub={`${round + 2}回目`}
      />
    </div>
  )
}

/* ---------- 待機・完了 ---------- */

function IdleScreen({
  records,
  reviews,
  playlists,
  settings,
  prefetched,
  syncState,
  syncError,
  onSync,
  onPatchSettings,
  onOpenSettings,
  onOpenLibrary,
  onStart,
}: {
  records: SessionRecord[]
  reviews: ReviewItem[]
  playlists: Playlist[]
  settings: Settings
  prefetched: boolean
  syncState: 'idle' | 'running' | 'ok' | 'error'
  syncError: string | null
  onSync: () => void
  onPatchSettings: (patch: Partial<Settings>) => void
  onOpenSettings: () => void
  onOpenLibrary: () => void
  onStart: () => void
}) {
  const days = streak(records)
  const due = dueCount(reviews, today())
  const todayRecord = records.find((r) => r.date === today())
  const options = allPlaylists(playlists)
  return (
    <div class="idle">
      <header class="idle-head">
        <div class="idle-title">
          <h1>質問応答</h1>
          <button class="stop" onClick={onOpenSettings}>
            設定
          </button>
        </div>
        <p class="sub">復習 → 挑戦 → 手本 → 言い直し · {formatClock(TOTAL_MS)}</p>
      </header>

      <div class="picker">
        <select
          value={settings.playlistId}
          onChange={(e) => onPatchSettings({ playlistId: (e.target as HTMLSelectElement).value })}
        >
          {options.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}（{p.questions.length}）
            </option>
          ))}
        </select>
        <button class="picker-add" onClick={onOpenLibrary} aria-label="プレイリストを編集">
          ＋
        </button>
      </div>

      <button class="start" onClick={onStart}>
        <span class="start-main">{todayRecord?.reached === 5 ? 'もう一度' : '開始'}</span>
        <span class="start-sub">タップしたら喋りはじめる</span>
      </button>

      <div class="idle-meta">
        <button
          class={settings.quiet ? 'chip on' : 'chip'}
          onClick={() => onPatchSettings({ quiet: !settings.quiet })}
        >
          小声モード{settings.quiet ? ' ON' : ' OFF'}
        </button>
        {speechSupported() && (
          <button
            class={settings.speak ? 'chip on' : 'chip'}
            onClick={() => onPatchSettings({ speak: !settings.speak })}
          >
            読み上げ{settings.speak ? ' ON' : ' OFF'}
          </button>
        )}
        {canSync(settings) && (
          <button class={syncState === 'error' ? 'chip warn' : 'chip'} onClick={onSync}>
            {syncState === 'running' ? '同期中…' : syncState === 'error' ? '同期できず' : '同期'}
          </button>
        )}
        {prefetched && <span class="chip flat">今日のぶん生成済み</span>}
        {due > 0 && <span class="chip flat">復習 {due}</span>}
        {days > 0 && <span class="chip flat">{days}日連続</span>}
      </div>
      {syncError && <p class="error">{syncError}</p>}

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

/* ---------- プレイリスト ---------- */

const EMPTY_DRAFT: QuestionDraft = { text: '', ja: '', model: '', level: 'easy' }

function LibraryScreen({
  playlists,
  settings,
  onChange,
  onSelect,
  onClose,
}: {
  playlists: Playlist[]
  settings: Settings
  onChange: (next: Playlist[], changedId?: string) => void
  onSelect: (id: string) => void
  onClose: () => void
}) {
  const [openId, setOpenId] = useState<string | null>(playlists[0]?.id ?? null)
  const [name, setName] = useState('')
  const [draft, setDraft] = useState<QuestionDraft>(EMPTY_DRAFT)
  const [filling, setFilling] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const open = playlists.find((p) => p.id === openId) ?? null

  const addPlaylist = () => {
    if (name.trim().length === 0) return
    const created = newPlaylist(name.trim())
    onChange([...playlists, created])
    setOpenId(created.id)
    setName('')
  }

  const removePlaylist = (id: string) => {
    onChange(playlists.filter((p) => p.id !== id))
    if (openId === id) setOpenId(null)
    if (settings.playlistId === id) onSelect('seed')
  }

  const addQuestion = () => {
    if (!open || draft.text.trim().length === 0 || draft.model.trim().length === 0) return
    const question = newQuestion(open, draft)
    onChange(
      playlists.map((p) => (p.id === open.id ? { ...p, questions: [...p.questions, question] } : p)),
      open.id,
    )
    setDraft(EMPTY_DRAFT)
  }

  const removeQuestion = (playlistId: string, questionId: string) => {
    onChange(
      playlists.map((p) =>
        p.id === playlistId ? { ...p, questions: p.questions.filter((q) => q.id !== questionId) } : p,
      ),
      playlistId,
    )
  }

  /** 英語か日本語を片方書けば、残りを埋めてもらう。3つとも手で書かせると足さなくなる。 */
  const autofill = async () => {
    setFilling(true)
    setError(null)
    try {
      const filled = await fillQuestion(settings, { text: draft.text, ja: draft.ja })
      setDraft({ text: filled.text, ja: filled.ja, model: filled.model, level: filled.level as Level })
    } catch (e) {
      setError(describeError(e))
    } finally {
      setFilling(false)
    }
  }

  return (
    <div class="settings">
      <header class="idle-head">
        <div class="idle-title">
          <h1>プレイリスト</h1>
          <button class="stop" onClick={onClose}>
            戻る
          </button>
        </div>
        <p class="sub">種問題 60 は組み込みで、消せません。</p>
      </header>

      <div class="picker">
        <input
          type="text"
          placeholder="新しいプレイリスト名"
          value={name}
          onInput={(e) => setName((e.target as HTMLInputElement).value)}
        />
        <button class="picker-add" onClick={addPlaylist} aria-label="プレイリストを作る">
          ＋
        </button>
      </div>

      {playlists.length === 0 && (
        <p class="empty">まだ自分のプレイリストはありません。名前を入れて ＋ を押す。</p>
      )}

      <ul class="playlists">
        {playlists.map((p) => (
          <li key={p.id}>
            <div class="playlist-row">
              <button class="playlist-name" onClick={() => setOpenId(openId === p.id ? null : p.id)}>
                {p.name}
                <span>{p.questions.length} 問</span>
              </button>
              <button
                class={settings.playlistId === p.id ? 'chip on' : 'chip'}
                onClick={() => onSelect(p.id)}
              >
                {settings.playlistId === p.id ? '使用中' : '使う'}
              </button>
              <button class="stop" onClick={() => removePlaylist(p.id)}>
                削除
              </button>
            </div>

            {openId === p.id && (
              <div class="playlist-body">
                <ul class="qlist">
                  {p.questions.map((q) => (
                    <li key={q.id}>
                      <div>
                        <b>{q.text}</b>
                        <span>{q.ja}</span>
                        <em>{q.model}</em>
                      </div>
                      <button class="stop" onClick={() => removeQuestion(p.id, q.id)}>
                        削除
                      </button>
                    </li>
                  ))}
                </ul>

                <div class="qform">
                  <label>
                    <span>英語の質問</span>
                    <input
                      type="text"
                      value={draft.text}
                      onInput={(e) => setDraft({ ...draft, text: (e.target as HTMLInputElement).value })}
                    />
                  </label>
                  <label>
                    <span>日本語</span>
                    <input
                      type="text"
                      value={draft.ja}
                      onInput={(e) => setDraft({ ...draft, ja: (e.target as HTMLInputElement).value })}
                    />
                  </label>
                  <label>
                    <span>手本の答え（英語）</span>
                    <textarea
                      rows={3}
                      placeholder={'例: I live in Osaka. I have lived there for three years.'}
                      value={draft.model}
                      onInput={(e) => setDraft({ ...draft, model: (e.target as HTMLTextAreaElement).value })}
                    />
                    <em>
                      詰まったときに渡される答えの例。言い直しの3回で声に出すのもこれ。
                      2文で、真似して言える短さに。
                      {hasApiKey(settings) && '　英語か日本語を書いて「残りを埋めてもらう」でも作れます。'}
                    </em>
                  </label>
                  <label>
                    <span>難しさ</span>
                    <select
                      value={draft.level}
                      onChange={(e) =>
                        setDraft({ ...draft, level: (e.target as HTMLSelectElement).value as Level })
                      }
                    >
                      <option value="easy">easy</option>
                      <option value="mid">mid</option>
                      <option value="hard">hard</option>
                    </select>
                  </label>

                  {error && <p class="error">{error}</p>}

                  <div class="qform-actions">
                    {hasApiKey(settings) && (
                      <button
                        class="ghost"
                        onClick={autofill}
                        disabled={filling || (draft.text.trim() === '' && draft.ja.trim() === '')}
                      >
                        {filling ? '整えています…' : '日本語か英語から、残りを作ってもらう'}
                      </button>
                    )}
                    <button
                      class="primary"
                      onClick={addQuestion}
                      disabled={draft.text.trim() === '' || draft.model.trim() === ''}
                    >
                      追加
                    </button>
                  </div>
                </div>
              </div>
            )}
          </li>
        ))}
      </ul>
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
        <summary>端末どうしの同期</summary>
        <label>
          <span>GitHub トークン（gist 権限）</span>
          <input
            type="password"
            autocomplete="off"
            placeholder="ghp_..."
            value={draft.syncToken}
            onInput={field('syncToken')}
          />
        </label>
        <label>
          <span>Gist ID</span>
          <input
            type="text"
            autocomplete="off"
            placeholder="空なら新しく作ります"
            value={draft.syncGistId}
            onInput={field('syncGistId')}
          />
        </label>
        <label class="row">
          <input
            type="checkbox"
            checked={draft.syncAuto}
            onChange={(e) => setDraft({ ...draft, syncAuto: (e.target as HTMLInputElement).checked })}
          />
          <span>起動時と練習後に自動で同期する</span>
        </label>
        <em>
          瞬間英作文アプリと同じ Gist ID を入れて構いません。ファイル名を分けてあるので、
          向こうの中身には触れません。トークンはこの端末にだけ保存されます。
        </em>
      </details>

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

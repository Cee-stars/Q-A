import { useCallback, useEffect, useRef, useState } from 'preact/hooks'
import { pickDaily, type Level, type Question } from './questions'
import {
  buildCards,
  CARDS_PER_SESSION,
  clampWindow,
  MAX_WINDOW_MS,
  MIN_WINDOW_MS,
  type Card,
} from './cards'
import { CardDrill } from './CardDrill'
import { SEED_PLAYLIST_ID } from './playlists'
import {
  addQuestionTo,
  allPlaylists,
  findPlaylist,
  isUsable,
  moveQuestion,
  newPlaylist,
  removeQuestionFrom,
  resolvePool,
  type Playlist,
  type QuestionDraft,
} from './playlists'
import { describeError, fillQuestion, generateQuestions } from './claude'
import { DEFAULT_CORRECTION_PROMPT, DEFAULT_GENERATION_PROMPT } from './prompts'
import {
  advance as advanceItem,
  createItem,
  dueCount,
  dueElsewhere,
  isGraduated,
  type ReviewItem,
} from './review'
import {
  canSync,
  DEFAULT_SETTINGS,
  hasApiKey,
  loadAsked,
  loadGenerated,
  loadPlaylists,
  loadRecords,
  loadReflex,
  loadReviews,
  loadSettings,
  recentQuestionIds,
  saveAsked,
  saveGenerated,
  savePlaylists,
  saveRecord,
  saveRecords,
  saveReflexRecord,
  saveReviews,
  saveSettings,
  type SessionRecord,
  type Settings,
  streak,
  today,
  tomorrow,
} from './storage'
import { emptySnapshot, syncOnce, SyncError, type Snapshot } from './sync'
import { ReflexMode } from './ReflexMode'
import { sessionMedian, formatLatency, type ReflexAttempt, type ReflexRecord } from './reflex'
import { unlockAudio } from './cues'
import { stopSpeaking, supported as speechSupported, unlockSpeech } from './speech'
import { keepAwake, releaseAwake } from './wakelock'

const CHECKLIST_LABEL = '質問応答（カード）'

interface Run {
  active: boolean
  cards: Card[]
  done: number
}

const IDLE: Run = { active: false, cards: [], done: 0 }

export function App() {
  const [run, setRun] = useState<Run>(IDLE)
  const [records, setRecords] = useState<SessionRecord[]>([])
  const [reviews, setReviews] = useState<ReviewItem[]>([])
  const [playlists, setPlaylists] = useState<Playlist[]>([])
  const [settings, setSettings] = useState<Settings>(DEFAULT_SETTINGS)
  const [prefetched, setPrefetched] = useState<Question[] | null>(null)
  const [screen, setScreen] = useState<'drill' | 'settings' | 'library' | 'reflex'>('drill')
  const [reflexRecords, setReflexRecords] = useState<ReflexRecord[]>([])
  const [syncState, setSyncState] = useState<'idle' | 'running' | 'ok' | 'error'>('idle')
  const [syncError, setSyncError] = useState<string | null>(null)

  useEffect(() => {
    void loadRecords().then(setRecords)
    void loadReviews().then(setReviews)
    void loadPlaylists().then(setPlaylists)
    void loadSettings().then(setSettings)
    void loadGenerated(today()).then(setPrefetched)
    void loadReflex().then(setReflexRecords)
  }, [])

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

  const booted = useRef(false)
  useEffect(() => {
    if (booted.current || !settings.syncAuto || !canSync(settings)) return
    booted.current = true
    void sync()
  }, [settings, sync])

  /**
   * 途中で閉じても、どこまで進んだかが残るように、1枚ごとに書く。
   * 同期の前には必ず待つこと。待たないと、1枚古い記録を置き場に送る。
   */
  const persist = useCallback(
    (cards: Card[], done: number): Promise<void> => {
      const record: SessionRecord = {
        date: today(),
        reached: 0,
        cards: done,
        cardsTotal: cards.length,
        questionIds: [],
        answeredIds: [],
        pickedId: null,
        rewrite: '',
        reviewed: cards.filter((c) => c.kind === 'review').length,
        quiet: settings.quiet,
        updatedAt: Date.now(),
      }
      return saveRecord(record).then(setRecords)
    },
    [settings.quiet],
  )

  const start = useCallback(() => {
    unlockAudio()
    unlockSpeech()
    keepAwake()
    const date = today()
    const pool = resolvePool(playlists, settings.playlistId)
    const usePrefetched = prefetched !== null && settings.playlistId === SEED_PLAYLIST_ID
    const ten = usePrefetched
      ? (prefetched as Question[])
      : pickDaily(date, pool.questions, recentQuestionIds(records))
    const cards = buildCards(ten, reviews, date, settings.playlistId)
    setRun({ active: true, cards, done: 0 })
    persist(cards, 0)
    void loadAsked().then((asked) => saveAsked([...asked, ...ten.map((q) => q.text)]))
  }, [persist, playlists, prefetched, records, reviews, settings.playlistId])

  /**
   * 1枚終えるごとに、復習の予定を動かす。
   *   - 新しい質問で答え方を見た → 言えなかったので、復習に積む
   *   - 復習カードを自力で言えた → 次の間隔へ進める
   *   - 復習カードでまた見た → 進めない。間隔を進めると、言えないまま卒業する
   */
  const handleCard = useCallback(
    (card: Card, usedHelp: boolean, done: number) => {
      void persist(run.cards, done)
      const date = today()

      if (card.kind === 'question') {
        if (!usedHelp) return
        setReviews((current) => {
          // 同じ質問が未卒業で残っているなら、二重に積まない。
          if (current.some((i) => i.question === card.question && !isGraduated(i))) return current
          const next = [
            ...current,
            createItem(card.question, card.ja, card.answer, date, settings.playlistId),
          ]
          void saveReviews(next)
          return next
        })
        return
      }

      if (usedHelp) return
      setReviews((current) => {
        const next = current.map((i) => (i.id === card.reviewId ? advanceItem(i, date) : i))
        void saveReviews(next)
        return next
      })
    },
    [persist, run.cards, settings.playlistId],
  )

  const finish = useCallback(() => {
    releaseAwake()
    stopSpeaking()
    setRun({ ...IDLE })
    void (async () => {
      // 記録を書き終えてから同期する。順番を崩すと1枚古い記録が送られる。
      await persist(run.cards, run.cards.length)
      if (settings.syncAuto) await sync()
    })()
    void (async () => {
      if (!hasApiKey(settings)) return
      const date = tomorrow()
      if (await loadGenerated(date)) return
      try {
        await saveGenerated(date, await generateQuestions(settings, await loadAsked()))
      } catch {
        // 明日は種問題バンクで練習すればよい。
      }
    })()
  }, [persist, run.cards, settings, sync])

  const stop = useCallback(
    (done: number) => {
      releaseAwake()
      stopSpeaking()
      void persist(run.cards, done)
      setRun({ ...IDLE })
    },
    [persist, run.cards],
  )

  const patchSettings = useCallback((patch: Partial<Settings>) => {
    setSettings((current) => {
      const next = { ...current, ...patch }
      void saveSettings(next)
      return next
    })
  }, [])

  if (screen === 'reflex') {
    const pool = resolvePool(playlists, settings.playlistId)
    return (
      <main class="screen">
        <ReflexMode
          questions={pickDaily(today(), pool.questions, recentQuestionIds(records))}
          settings={settings}
          onFinish={(attempts: ReflexAttempt[]) => {
            const record: ReflexRecord = {
              date: today(),
              playlistId: settings.playlistId,
              attempts,
              updatedAt: Date.now(),
            }
            void saveReflexRecord(record).then(setReflexRecords)
            setScreen('drill')
          }}
          onClose={() => setScreen('drill')}
        />
      </main>
    )
  }

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
          onChange={(next) => {
            setPlaylists(next)
            void savePlaylists(next)
            if (settings.syncAuto) void sync()
          }}
          onSelect={(id) => patchSettings({ playlistId: id })}
          onClose={() => setScreen('drill')}
        />
      </main>
    )
  }

  return (
    <main class={run.active ? 'screen screen-cards' : 'screen'}>
      {run.active ? (
        <CardDrill
          cards={run.cards}
          windowMs={clampWindow(settings.answerWindowMs)}
          quiet={settings.quiet}
          speakEnabled={settings.speak}
          onCardDone={handleCard}
          onFinish={finish}
          onStop={stop}
        />
      ) : (
        <IdleScreen
          records={records}
          reviews={reviews}
          playlists={playlists}
          settings={settings}
          prefetched={prefetched !== null}
          syncState={syncState}
          syncError={syncError}
          reflexRecords={reflexRecords}
          onSync={() => void sync()}
          onPatchSettings={patchSettings}
          onOpenSettings={() => setScreen('settings')}
          onOpenLibrary={() => setScreen('library')}
          onOpenReflex={() => setScreen('reflex')}
          onStart={start}
        />
      )}
    </main>
  )
}

/* ---------- 部品 ---------- */

/** その日の進み具合。カード形式より前の記録は工程数しか持っていない。 */
function Progress({ record }: { record: SessionRecord }) {
  if (record.cardsTotal) {
    const done = record.cards ?? 0
    return (
      <span class="progress">
        <span class="progress-bar">
          <i style={{ transform: `scaleX(${done / record.cardsTotal})` }} />
        </span>
        <span class="progress-text">
          {done} / {record.cardsTotal}
        </span>
      </span>
    )
  }
  return <span class="progress-text old">旧形式 · 工程 {record.reached}</span>
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
  onOpenReflex,
  reflexRecords,
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
  onOpenReflex: () => void
  reflexRecords: ReflexRecord[]
  onStart: () => void
}) {
  const days = streak(records)
  const due = dueCount(reviews, today(), settings.playlistId)
  const elsewhere = dueElsewhere(reviews, today(), settings.playlistId)
  const selected = findPlaylist(playlists, settings.playlistId)
  const emptySelected = !isUsable(selected)
  const reflexMedian = reflexRecords[0] ? sessionMedian(reflexRecords[0].attempts) : null
  const windowSec = Math.round(clampWindow(settings.answerWindowMs) / 1000)
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
        <p class="sub">
          質問 → 声に出す → 意味と答え方 · 1枚 {Math.round(clampWindow(settings.answerWindowMs) / 1000)}秒 ·{' '}
          {CARDS_PER_SESSION}枚
        </p>
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
        {emptySelected && <span class="chip warn">この束は0問。種問題で練習します</span>}
        {canSync(settings) && (
          <button class={syncState === 'error' ? 'chip warn' : 'chip'} onClick={onSync}>
            {syncState === 'running' ? '同期中…' : syncState === 'error' ? '同期できず' : '同期'}
          </button>
        )}
        {prefetched && <span class="chip flat">今日のぶん生成済み</span>}
        {due > 0 && <span class="chip flat">復習 {due}</span>}
        {elsewhere > 0 && <span class="chip dim">他の束に {elsewhere}</span>}
        {days > 0 && <span class="chip flat">{days}日連続</span>}
      </div>
      {syncError && <p class="error">{syncError}</p>}

      <div class="window-row">
        <span>答える時間</span>
        <input
          type="range"
          min={MIN_WINDOW_MS / 1000}
          max={MAX_WINDOW_MS / 1000}
          step={1}
          value={windowSec}
          onInput={(e) =>
            onPatchSettings({
              answerWindowMs: Number((e.target as HTMLInputElement).value) * 1000,
            })
          }
        />
        <b>{windowSec}秒</b>
      </div>

      <button class="secondary" onClick={onOpenReflex}>
        <span>反射 — 何秒で声が出るか測る</span>
        {reflexMedian !== null && <b>{formatLatency(reflexMedian)}</b>}
      </button>

      <section class="log">
        <h2>{CHECKLIST_LABEL}</h2>
        {records.length === 0 && <p class="empty">まだ記録がありません。今日から。</p>}
        <ul>
          {records.slice(0, 14).map((record) => (
            <li key={record.date}>
              <span class="log-date">{record.date.slice(5).replace('-', '/')}</span>
              <Progress record={record} />
            </li>
          ))}
        </ul>
      </section>
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
  onChange: (next: Playlist[]) => void
  onSelect: (id: string) => void
  onClose: () => void
}) {
  // 開く束は、いま使っている束に合わせる。
  // 先頭を勝手に開くと、使用中に押した束とは別の束のフォームに書き込んでしまう。
  const [openId, setOpenId] = useState<string | null>(
    playlists.some((p) => p.id === settings.playlistId) ? settings.playlistId : null,
  )
  const [name, setName] = useState('')
  const [draft, setDraft] = useState<QuestionDraft>(EMPTY_DRAFT)
  const [filling, setFilling] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const open = playlists.find((p) => p.id === openId) ?? null
  // 移動先の候補。束が1つしか無ければ移動先は無い。
  const others = playlists.length > 1 ? playlists : []

  const addPlaylist = () => {
    if (name.trim().length === 0) return
    const created = newPlaylist(name.trim())
    onChange([...playlists, created])
    setOpenId(created.id)
    setDraft(EMPTY_DRAFT)
    setName('')
  }

  const removePlaylist = (id: string) => {
    onChange(playlists.filter((p) => p.id !== id))
    if (openId === id) setOpenId(null)
    if (settings.playlistId === id) onSelect('seed')
  }

  const addQuestion = () => {
    if (!open || draft.text.trim().length === 0 || draft.model.trim().length === 0) return
    onChange(addQuestionTo(playlists, open.id, draft))
    setDraft(EMPTY_DRAFT)
  }

  const removeQuestion = (playlistId: string, questionId: string) => {
    onChange(removeQuestionFrom(playlists, playlistId, questionId))
  }

  /** 間違えた束に入れた質問を、消して書き直さずに移す。 */
  const move = (fromId: string, toId: string, questionId: string) => {
    if (!toId) return
    onChange(moveQuestion(playlists, fromId, toId, questionId))
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
              <button
                class="playlist-name"
                onClick={() => {
                  setOpenId(openId === p.id ? null : p.id)
                  setDraft(EMPTY_DRAFT)
                }}
              >
                {p.name}
                <span>{p.questions.length} 問</span>
              </button>
              <button
                class={settings.playlistId === p.id ? 'chip on' : 'chip'}
                onClick={() => {
                  onSelect(p.id)
                  // 使う束と、質問を足す束を必ず一致させる。
                  setOpenId(p.id)
                  setDraft(EMPTY_DRAFT)
                }}
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
                      <div class="qactions">
                        {others.length > 0 && (
                          <select
                            class="qmove"
                            value=""
                            onChange={(e) => {
                              const target = e.target as HTMLSelectElement
                              move(p.id, target.value, q.id)
                              target.value = ''
                            }}
                          >
                            <option value="">移動…</option>
                            {others
                              .filter((other) => other.id !== p.id)
                              .map((other) => (
                                <option key={other.id} value={other.id}>
                                  {other.name} へ
                                </option>
                              ))}
                          </select>
                        )}
                        <button class="stop" onClick={() => removeQuestion(p.id, q.id)}>
                          削除
                        </button>
                      </div>
                    </li>
                  ))}
                </ul>

                <div class="qform">
                  <p class="qform-target">「{p.name}」に質問を足す</p>
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
                      「{p.name}」に追加
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

import { createStore, get as idbGet, set as idbSet } from 'idb-keyval'

// cee-stars.github.io には他のアプリも同居している。既定の 'keyval-store' は
// 汎用名なので、同じオリジンの別アプリと同じ箱を取り合うことになる。
// 記録と復習項目はこのアプリ専用の箱に閉じ込める。
const store = createStore('qa-drill', 'kv')

const get = <T>(key: string) => idbGet<T>(key, store)
const set = (key: string, value: unknown) => idbSet(key, value, store)
import type { ReviewItem } from './review'
import type { Question } from './questions'
import type { Playlist } from './playlists'

const RECORDS_KEY = 'qa:records'
const SETTINGS_KEY = 'qa:settings'

/** チェックリスト1行ぶん。「どこまでやったか」はここに残る。 */
export interface SessionRecord {
  date: string
  /** 到達した工程（1..5）。5 で完了。 */
  reached: number
  questionIds: string[]
  answeredIds: string[]
  pickedId: string | null
  /** Phase 1 は自分で書き直した文。Phase 2 で添削文に置き換わる。 */
  rewrite: string
  /** その日に復習した枚数。 */
  reviewed: number
  quiet: boolean
  updatedAt: number
}

export interface Settings {
  quiet: boolean
  /** 出題に使うプレイリスト。消えていたら種問題に落ちる。 */
  playlistId: string
  /** 英語を読み上げる。工程4の手本と、復習で出た文に効く。 */
  speak: boolean
  /** 端末どうしの同期。瞬間英作文アプリと同じ Gist を指してよい。 */
  syncToken: string
  syncGistId: string
  syncAuto: boolean
  /** 端末内にしか無い。リポジトリにも配信物にも含まれない。 */
  apiKey: string
  level: string
  goal: string
  themes: string
  /** 空ならプロンプトの既定値を使う。デプロイなしで調整するため編集できる。 */
  generationPrompt: string
  correctionPrompt: string
}

export const DEFAULT_SETTINGS: Settings = {
  quiet: false,
  playlistId: 'seed',
  speak: true,
  syncToken: '',
  syncGistId: '',
  syncAuto: true,
  apiKey: '',
  level: '中級（日常会話はできるが、詰まると止まる）',
  goal: '仕事の会議と雑談',
  themes: '仕事・日常・過去の経験',
  generationPrompt: '',
  correctionPrompt: '',
}

export function hasApiKey(settings: Settings): boolean {
  return settings.apiKey.trim().length > 0
}

export function canSync(settings: Settings): boolean {
  return settings.syncToken.trim().length > 0
}

/** ローカル日付。UTC で切ると日本時間の深夜が前日扱いになる。 */
export function today(d = new Date()): string {
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}

export async function loadRecords(): Promise<SessionRecord[]> {
  return (await get<SessionRecord[]>(RECORDS_KEY)) ?? []
}

/** 同じ日の記録は上書きする。1日1行。 */
export async function saveRecord(record: SessionRecord): Promise<SessionRecord[]> {
  const records = await loadRecords()
  const rest = records.filter((r) => r.date !== record.date)
  const next = [...rest, record].sort((a, b) => b.date.localeCompare(a.date))
  await set(RECORDS_KEY, next)
  return next
}

/** 合流結果をまとめて置き換える。同期のあとだけ使う。 */
export async function saveRecords(records: SessionRecord[]): Promise<void> {
  await set(RECORDS_KEY, [...records].sort((a, b) => b.date.localeCompare(a.date)))
}

export async function loadSettings(): Promise<Settings> {
  return { ...DEFAULT_SETTINGS, ...((await get<Settings>(SETTINGS_KEY)) ?? {}) }
}

export async function saveSettings(settings: Settings): Promise<void> {
  await set(SETTINGS_KEY, settings)
}

/** 明日の日付。先読み生成の保存先に使う。 */
export function tomorrow(d = new Date()): string {
  const next = new Date(d)
  next.setDate(next.getDate() + 1)
  return today(next)
}

/** 直近 n 回ぶんの出題。生成のたびに除外して重複を避ける。 */
export function recentQuestionIds(records: SessionRecord[], sessions = 3): string[] {
  return records.slice(0, sessions).flatMap((r) => r.questionIds)
}

/** 連続日数。途切れても罰は与えないが、続いていることは見せる。 */
export function streak(records: SessionRecord[], from = new Date()): number {
  const done = new Set(records.filter((r) => r.reached >= 5).map((r) => r.date))
  const cursor = new Date(from)
  let n = 0
  // 今日がまだ未完了でも、昨日まで続いていればストリークは生きている。
  if (!done.has(today(cursor))) cursor.setDate(cursor.getDate() - 1)
  while (done.has(today(cursor))) {
    n++
    cursor.setDate(cursor.getDate() - 1)
  }
  return n
}

// --- 先読み生成した問題 ---

/**
 * その日ぶんの生成済み10問。前夜のセッション終わりに書いておき、
 * 翌朝は開いた瞬間に問題がある状態にする。
 */
export async function loadGenerated(date: string): Promise<Question[] | null> {
  return (await get<Question[]>(`qa:questions:${date}`)) ?? null
}

export async function saveGenerated(date: string, questions: Question[]): Promise<void> {
  await set(`qa:questions:${date}`, questions)
}

// --- 復習項目 ---

const REVIEWS_KEY = 'qa:reviews'

export async function loadReviews(): Promise<ReviewItem[]> {
  return (await get<ReviewItem[]>(REVIEWS_KEY)) ?? []
}

export async function saveReviews(items: ReviewItem[]): Promise<void> {
  await set(REVIEWS_KEY, items)
}

// --- プレイリスト ---

const PLAYLISTS_KEY = 'qa:playlists'

/** 自作の束だけを保存する。組み込みの種問題はコードの側にある。 */
export async function loadPlaylists(): Promise<Playlist[]> {
  return (await get<Playlist[]>(PLAYLISTS_KEY)) ?? []
}

export async function savePlaylists(playlists: Playlist[]): Promise<void> {
  await set(PLAYLISTS_KEY, playlists)
}

// --- 直近の出題（生成時の重複回避用） ---

const ASKED_KEY = 'qa:asked'
const ASKED_LIMIT = 30

/** 直近に出した質問文。生成プロンプトに除外指定として渡す。 */
export async function loadAsked(): Promise<string[]> {
  return (await get<string[]>(ASKED_KEY)) ?? []
}

/** 重複は落として新しいほうを残す。同じ日に開き直しても膨らまない。 */
export async function saveAsked(texts: string[]): Promise<void> {
  await set(ASKED_KEY, [...new Set(texts)].slice(-ASKED_LIMIT))
}

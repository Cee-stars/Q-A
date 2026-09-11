import { get, set } from 'idb-keyval'

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
  quiet: boolean
  updatedAt: number
}

export interface Settings {
  quiet: boolean
}

export const DEFAULT_SETTINGS: Settings = { quiet: false }

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

export async function loadSettings(): Promise<Settings> {
  return { ...DEFAULT_SETTINGS, ...((await get<Settings>(SETTINGS_KEY)) ?? {}) }
}

export async function saveSettings(settings: Settings): Promise<void> {
  await set(SETTINGS_KEY, settings)
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

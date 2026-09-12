// 端末どうしの同期。サーバーは持たず、GitHub のシークレット Gist を置き場にする。
//
// 既存の瞬間英作文アプリと同じ方式・同じ Gist を使えるように、
// ファイル名だけを分けて同居させる（向こうは sunkan-data.json）。
// トークンと Gist ID を両方のアプリに同じものを入れれば、置き場は1つで済む。
//
// **合流は「最後に書いたほうが勝つ」にしない。** 2台で同じ日に練習したとき、
// 後から同期したほうで、進んだ記録が巻き戻るため。項目ごとに「進んでいるほう」を残す。

import type { Playlist } from './playlists'
import type { ReviewItem } from './review'
import type { SessionRecord } from './storage'

const API = 'https://api.github.com/gists'
const GIST_FILE = 'qa-drill-data.json'
/** Gist の1ファイル上限は 1MB。少し余裕を持たせる。 */
const FILE_MAX = 900 * 1024

export interface Snapshot {
  version: 1
  updatedAt: number
  records: SessionRecord[]
  reviews: ReviewItem[]
  playlists: Playlist[]
  asked: string[]
}

export function emptySnapshot(): Snapshot {
  return { version: 1, updatedAt: 0, records: [], reviews: [], playlists: [], asked: [] }
}

/* ---------- 合流 ---------- */

/** 記録は「到達した工程が多いほう」を残す。並んだら後から書いたほう。 */
function mergeRecords(a: SessionRecord[], b: SessionRecord[]): SessionRecord[] {
  const byDate = new Map<string, SessionRecord>()
  for (const record of [...a, ...b]) {
    const seen = byDate.get(record.date)
    if (
      !seen ||
      record.reached > seen.reached ||
      (record.reached === seen.reached && record.updatedAt > seen.updatedAt)
    ) {
      byDate.set(record.date, record)
    }
  }
  return [...byDate.values()].sort((x, y) => y.date.localeCompare(x.date))
}

/** 復習項目は「復習回数が多いほう」を残す。巻き戻すと同じ日に二度出る。 */
function mergeReviews(a: ReviewItem[], b: ReviewItem[]): ReviewItem[] {
  const byId = new Map<string, ReviewItem>()
  for (const item of [...a, ...b]) {
    const seen = byId.get(item.id)
    if (
      !seen ||
      item.reviews > seen.reviews ||
      (item.reviews === seen.reviews && item.due > seen.due)
    ) {
      byId.set(item.id, item)
    }
  }
  return [...byId.values()].sort((x, y) => x.createdAt.localeCompare(y.createdAt))
}

/** プレイリストは、編集した時刻が新しいほうを丸ごと残す。 */
function mergePlaylists(a: Playlist[], b: Playlist[]): Playlist[] {
  const byId = new Map<string, Playlist>()
  for (const playlist of [...a, ...b]) {
    const seen = byId.get(playlist.id)
    if (!seen || (playlist.updatedAt ?? 0) > (seen.updatedAt ?? 0)) byId.set(playlist.id, playlist)
  }
  return [...byId.values()]
}

export function mergeSnapshots(local: Snapshot, remote: Snapshot): Snapshot {
  return {
    version: 1,
    updatedAt: Math.max(local.updatedAt, remote.updatedAt),
    records: mergeRecords(local.records, remote.records),
    reviews: mergeReviews(local.reviews, remote.reviews),
    playlists: mergePlaylists(local.playlists, remote.playlists),
    // 出題済みは片方にしか無いものも意味があるので、そのまま合わせて末尾を残す。
    asked: [...new Set([...remote.asked, ...local.asked])].slice(-30),
  }
}

/* ---------- 通信 ---------- */

export class SyncError extends Error {}

function describe(status: number): string {
  if (status === 401) return 'トークンが正しくありません'
  if (status === 404) return 'Gist ID が見つかりません'
  if (status === 403) return '断られました（権限に gist が無いか、回数制限）'
  if (status === 422) return '送った中身を GitHub が受け取れませんでした'
  return `通信に失敗しました（${status}）`
}

async function gh(url: string, method: string, token: string, body?: string): Promise<any> {
  let response: Response
  try {
    response = await fetch(url, {
      method,
      headers: {
        Authorization: `token ${token}`,
        Accept: 'application/vnd.github+json',
      },
      body,
    })
  } catch {
    throw new SyncError('ネットにつながっていません')
  }
  if (!response.ok) throw new SyncError(describe(response.status))
  return response.json()
}

function encode(snapshot: Snapshot): string {
  const text = JSON.stringify(snapshot)
  if (text.length > FILE_MAX) {
    throw new SyncError(`中身が大きすぎます（${Math.round(text.length / 1024)}KB）`)
  }
  return text
}

/** その Gist に置いてある、このアプリのぶんだけを読む。他アプリのファイルには触らない。 */
function readOurFile(json: any): Snapshot {
  const file = json?.files?.[GIST_FILE]
  if (!file?.content) return emptySnapshot()
  try {
    const parsed = JSON.parse(file.content) as Snapshot
    return parsed?.version === 1 ? parsed : emptySnapshot()
  } catch {
    // 壊れていたら空として扱い、こちらの中身で上書きする。
    return emptySnapshot()
  }
}

export async function pull(gistId: string, token: string): Promise<Snapshot> {
  return readOurFile(await gh(`${API}/${encodeURIComponent(gistId)}`, 'GET', token))
}

/** 自分のファイルだけを送る。同じ Gist に同居している他アプリのぶんは送らない。 */
export async function push(gistId: string, token: string, snapshot: Snapshot): Promise<void> {
  const body = JSON.stringify({ files: { [GIST_FILE]: { content: encode(snapshot) } } })
  await gh(`${API}/${encodeURIComponent(gistId)}`, 'PATCH', token, body)
}

/** 置き場をまだ持っていない端末のために、シークレット Gist を1枚作る。 */
export async function create(token: string, snapshot: Snapshot): Promise<string> {
  const body = JSON.stringify({
    description: '質問応答ドリル',
    public: false,
    files: { [GIST_FILE]: { content: encode(snapshot) } },
  })
  const json = await gh(API, 'POST', token, body)
  if (!json?.id) throw new SyncError('Gist を作れませんでした')
  return String(json.id)
}

export interface SyncResult {
  gistId: string
  merged: Snapshot
}

/**
 * 1往復ぶんの同期。読んで、合流させて、書き戻す。
 * Gist ID が無ければ作って返すので、呼び出し側はそれを保存する。
 */
export async function syncOnce(
  token: string,
  gistId: string,
  local: Snapshot,
): Promise<SyncResult> {
  if (!token.trim()) throw new SyncError('トークンが設定されていません')

  if (!gistId.trim()) {
    const created = await create(token.trim(), { ...local, updatedAt: Date.now() })
    return { gistId: created, merged: local }
  }

  const remote = await pull(gistId.trim(), token.trim())
  const merged = { ...mergeSnapshots(local, remote), updatedAt: Date.now() }
  await push(gistId.trim(), token.trim(), merged)
  return { gistId: gistId.trim(), merged }
}

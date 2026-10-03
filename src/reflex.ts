// 反射モード。**測るだけ**で、合否は出さない。
//
// 1秒という目標をいきなり課さないのは、反応時間がべき乗則で下がるから。
// 初日に 100% 失敗する基準は、練習をやめさせるだけで何も鍛えない。
// まず自分の現在値を知る。目標とやり直しの規則は、その実測が出てから決める。
//
// 型は「結論 → 理由」に固定する。自然な発話の大半は定型のまとまりで、
// まとまりは組み立てるより取り出すほうがずっと速い。
// 型が先に決まっていれば、質問を聞いている最中に中身だけを埋められる。

import { median } from './vad'

export const FRAME = 'I think ___. Because ___.'
export const FRAME_JA = '結論 → 理由'

/** 1回で出す問題数。短く終わらせる。 */
export const REFLEX_QUESTIONS = 8
/** 無音の基準を測る時間。セッションの頭で1回だけ。 */
export const CALIBRATE_MS = 1_000
/** 声が出るのをここまで待つ。超えたら「出なかった」として次へ。 */
export const LISTEN_TIMEOUT_MS = 6_000
/** 測り終えてから次の質問までの間。 */
export const FEEDBACK_MS = 1_500
/** これより速い値は、読み上げの残響を拾った疑いがあるので印を付ける。 */
export const SUSPICIOUS_MS = 150

export interface ReflexAttempt {
  questionId: string
  question: string
  ja: string
  /** 声が出るまでの時間。出なかったら null。 */
  latencyMs: number | null
  /** 残響を拾った疑い。集計から外す。 */
  suspicious?: boolean
}

export interface ReflexRecord {
  date: string
  playlistId: string
  attempts: ReflexAttempt[]
  updatedAt: number
}

/** 集計に使える試行だけ。出なかったものと、疑わしいものを外す。 */
export function usableLatencies(attempts: ReflexAttempt[]): number[] {
  return attempts
    .filter((a) => a.latencyMs !== null && !a.suspicious)
    .map((a) => a.latencyMs as number)
}

/** その回の中央値。測れた試行が無ければ null。 */
export function sessionMedian(attempts: ReflexAttempt[]): number | null {
  return median(usableLatencies(attempts))
}

/** 声が出なかった回数。これが多いうちは、速さより先に中身の問題。 */
export function missCount(attempts: ReflexAttempt[]): number {
  return attempts.filter((a) => a.latencyMs === null).length
}

export function formatLatency(ms: number | null): string {
  if (ms === null) return '—'
  return `${(ms / 1000).toFixed(2)}秒`
}

/** 直近の記録から、日ごとの中央値を新しい順に。推移を見るためのもの。 */
export function trend(records: ReflexRecord[], limit = 14): { date: string; ms: number }[] {
  return records
    .map((r) => ({ date: r.date, ms: sessionMedian(r.attempts) }))
    .filter((d): d is { date: string; ms: number } => d.ms !== null)
    .slice(0, limit)
}

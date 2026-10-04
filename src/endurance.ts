// 「その質問について30秒話せるか」を質問ごとに記録する。
//
// 利用者の指定:
//   - 目標は30秒。超えても止めず、ストップを押すまで測り続ける
//   - 30秒に届いていない質問を、**記録が長い順**に出す（あと少しのものから片付ける）
//   - 全部が30秒に届くまで出し続ける
//   - その日に終わらなかったものは翌日に持ち越す

/** 目標。ここに届いた質問は出題から外れる。 */
export const TARGET_MS = 30_000

/** 1日に出すカードの上限。1枚あたり30秒＋読み・間を見て、だいたい7〜8分。 */
export const MAX_CARDS_PER_DAY = 10

/**
 * 1日に扱う質問の種類。少なくして、同じ質問を繰り返す。
 * 10問を1回ずつ触っても30秒には届かない。届かせるには同じ質問に戻る必要がある。
 */
export const DAILY_QUESTION_POOL = 5

export interface QuestionProgress {
  /** 束と質問文で一意に決める。質問の id は束をまたぐと衝突するため使わない。 */
  key: string
  playlistId: string
  question: string
  /** これまでの最長。30秒に届いたら卒業。 */
  bestMs: number
  /** 最後に挑戦した日。 */
  lastAt: string
  /** 挑戦した回数。 */
  attempts: number
}

export function progressKey(playlistId: string, question: string): string {
  return `${playlistId}\u0000${question}`
}

export function isMastered(p: QuestionProgress | undefined): boolean {
  return (p?.bestMs ?? 0) >= TARGET_MS
}

export function bestOf(
  progress: QuestionProgress[],
  playlistId: string,
  question: string,
): QuestionProgress | undefined {
  const key = progressKey(playlistId, question)
  return progress.find((p) => p.key === key)
}

/**
 * 1回ぶんの記録を足す。**最長だけを残す。**
 * 今回が短くても、一度30秒に届いた質問を出題に戻さないため。
 */
export function record(
  progress: QuestionProgress[],
  playlistId: string,
  question: string,
  durationMs: number,
  date: string,
): QuestionProgress[] {
  const key = progressKey(playlistId, question)
  const existing = progress.find((p) => p.key === key)
  if (!existing) {
    return [...progress, { key, playlistId, question, bestMs: durationMs, lastAt: date, attempts: 1 }]
  }
  return progress.map((p) =>
    p.key === key
      ? {
          ...p,
          bestMs: Math.max(p.bestMs, durationMs),
          lastAt: date,
          attempts: p.attempts + 1,
        }
      : p,
  )
}

/**
 * まだ30秒に届いていない質問を、記録が長い順に並べる。
 * 一度も挑戦していないものは 0 として最後に回る。
 */
export function orderByBest<T extends { text: string }>(
  questions: T[],
  progress: QuestionProgress[],
  playlistId: string,
): T[] {
  return questions
    .map((q) => ({ q, best: bestOf(progress, playlistId, q.text)?.bestMs ?? 0 }))
    .filter((x) => x.best < TARGET_MS)
    .sort((a, b) => b.best - a.best)
    .map((x) => x.q)
}

/** 卒業した質問の数と、残り。待機画面に出す。 */
export function masteryOf(
  questions: { text: string }[],
  progress: QuestionProgress[],
  playlistId: string,
): { mastered: number; total: number } {
  const mastered = questions.filter((q) =>
    isMastered(bestOf(progress, playlistId, q.text)),
  ).length
  return { mastered, total: questions.length }
}

export function formatDuration(ms: number): string {
  const total = Math.floor(ms / 1000)
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`
}

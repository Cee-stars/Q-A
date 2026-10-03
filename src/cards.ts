// カード形式のドリル。
//
// 利用者の案:「質問を表示する → 意味を出すボタン → 答える → 答え方も見られる」。
// これは本人が毎日使っている瞬間英作文アプリと同じ操作感で、迷わないのが最大の利点。
//
// 復習（過去の持ち帰り）も同じカードに畳み込む。形が1つになるぶん、
// 分散検索の仕組みをそのまま残せる。

import type { Question } from './questions'
import { homeOf, isGraduated, type ReviewItem } from './review'

/** 1回に出すカードの枚数。 */
export const CARDS_PER_SESSION = 8

/** 答える時間の範囲。利用者が「1秒から10秒でもいい」と言った幅。 */
export const MIN_WINDOW_MS = 1_000
export const MAX_WINDOW_MS = 10_000
export const DEFAULT_WINDOW_MS = 5_000

export function clampWindow(ms: number): number {
  if (!Number.isFinite(ms)) return DEFAULT_WINDOW_MS
  return Math.min(MAX_WINDOW_MS, Math.max(MIN_WINDOW_MS, Math.round(ms / 1000) * 1000))
}

export interface Card {
  kind: 'question' | 'review'
  /** セッション内で一意。 */
  key: string
  question: string
  ja: string
  /** 答え方。新しい質問なら手本、復習なら前回の自分の持ち帰り。 */
  answer: string
  /** 復習カードのときだけ入る。 */
  reviewId?: string
  since?: string
}

function fromQuestion(q: Question): Card {
  return { kind: 'question', key: `q:${q.id}`, question: q.text, ja: q.ja, answer: q.model }
}

function fromReview(item: ReviewItem): Card {
  return {
    kind: 'review',
    key: `r:${item.id}`,
    question: item.question,
    ja: item.questionJa ?? '',
    answer: item.sentence,
    reviewId: item.id,
    since: item.createdAt,
  }
}

/**
 * その日のカードを組む。**期限が来た復習を先に置く。**
 * 後ろに回すと、途中でやめた日に復習だけが落ちて、間隔が静かに崩れる。
 */
export function buildCards(
  questions: Question[],
  reviews: ReviewItem[],
  date: string,
  playlistId: string,
  limit = CARDS_PER_SESSION,
): Card[] {
  const due = reviews
    .filter((i) => homeOf(i) === playlistId && !isGraduated(i) && i.due <= date)
    .sort((a, b) => a.due.localeCompare(b.due) || a.createdAt.localeCompare(b.createdAt))
    .slice(0, limit)
    .map(fromReview)

  const fresh = questions.map(fromQuestion).slice(0, Math.max(0, limit - due.length))
  return [...due, ...fresh]
}

/** 復習として出たカードの項目 id。終わったあと間隔を進めるのに使う。 */
export function reviewIdsIn(cards: Card[]): string[] {
  return cards.filter((c) => c.reviewId).map((c) => c.reviewId as string)
}

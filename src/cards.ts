// カード形式のドリル。
//
// 利用者の案:「質問を表示する → 意味を出すボタン → 答える → 答え方も見られる」。
// これは本人が毎日使っている瞬間英作文アプリと同じ操作感で、迷わないのが最大の利点。
//
// 復習（過去の持ち帰り）も同じカードに畳み込む。形が1つになるぶん、
// 分散検索の仕組みをそのまま残せる。

import type { Question } from './questions'
import { homeOf, isGraduated, type ReviewItem } from './review'
import {
  DAILY_QUESTION_POOL,
  MAX_CARDS_PER_DAY,
  orderByBest,
  type QuestionProgress,
} from './endurance'

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
 * その日のカードを組む。
 *   1. 期限が来た復習を先に置く（後ろに回すと、途中でやめた日に復習だけ落ちる）
 *   2. 残りは、30秒に届いていない質問を**記録が長い順**に
 *   3. 枠が余ったら同じ並びを繰り返す（全部が30秒に届くまで出し続けるため）
 */
export function buildCards(
  questions: Question[],
  reviews: ReviewItem[],
  progress: QuestionProgress[],
  date: string,
  playlistId: string,
  limit = MAX_CARDS_PER_DAY,
): Card[] {
  const due = reviews
    .filter((i) => homeOf(i) === playlistId && !isGraduated(i) && i.due <= date)
    .sort((a, b) => a.due.localeCompare(b.due) || a.createdAt.localeCompare(b.createdAt))
    .slice(0, limit)
    .map(fromReview)

  // その日に扱う種類を絞る。絞らないと全部を1回ずつ触って終わり、30秒に届かない。
  const pending = orderByBest(questions, progress, playlistId).slice(0, DAILY_QUESTION_POOL)
  const room = Math.max(0, limit - due.length)
  if (pending.length === 0 || room === 0) return due

  // 同じ順で何周もする。1問を連続で叩くのではなく、一巡してから戻る。
  const cycled: Card[] = []
  for (let i = 0; i < room; i++) cycled.push(fromQuestion(pending[i % pending.length]))
  return [...due, ...cycled]
}

/** その質問が30秒に届いたら、まだ残っている同じ質問のカードを落とす。 */
export function dropMastered(queue: Card[], question: string): Card[] {
  return queue.filter((c) => !(c.kind === 'question' && c.question === question))
}

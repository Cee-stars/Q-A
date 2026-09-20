// 添削文を「読み返す文」ではなく「後日もう一度答えさせられる質問」として戻す。
//
// 直後に3回読むのは集中練習で、初回の再生はほぼ完璧になるが急速に忘れる。
// 分散した検索練習は初回成績こそ劣るが、最終的な保持で上回る。
// このアプリで一番効く仕掛けはここ。

import { SEED_PLAYLIST_ID } from './playlists'

/** 復習間隔（日）。1項目あたり4回で卒業する。 */
export const INTERVALS = [1, 3, 7, 21]

export interface ReviewItem {
  id: string
  /** 元の質問。復習のときはこれだけを見せて思い出させる。 */
  question: string
  /** 質問の日本語。古い記録には無いので optional。 */
  questionJa?: string
  /** 添削された文。Phase 1 は自分で書き直した文。 */
  sentence: string
  createdAt: string
  /** どの束から出た質問か。付いていない古い記録は種問題のものとして扱う。 */
  playlistId?: string
  /** 済んだ復習回数。INTERVALS.length に達したら卒業。 */
  reviews: number
  /** 次にこの項目を出す日。 */
  due: string
}

function addDays(date: string, days: number): string {
  const d = new Date(`${date}T12:00:00`)
  d.setDate(d.getDate() + days)
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${d.getFullYear()}-${m}-${day}`
}

export function createItem(
  question: string,
  questionJa: string,
  sentence: string,
  date: string,
  playlistId: string = SEED_PLAYLIST_ID,
): ReviewItem {
  return {
    id: `${date}-${Math.random().toString(36).slice(2, 8)}`,
    question,
    questionJa,
    playlistId,
    sentence,
    createdAt: date,
    reviews: 0,
    due: addDays(date, INTERVALS[0]),
  }
}

export function isGraduated(item: ReviewItem): boolean {
  return item.reviews >= INTERVALS.length
}

/** 1回復習した。次の間隔へ進める。 */
export function advance(item: ReviewItem, date: string): ReviewItem {
  const reviews = item.reviews + 1
  const next = INTERVALS[reviews]
  return { ...item, reviews, due: next === undefined ? item.due : addDays(date, next) }
}

/** その項目がどの束のものか。印が無い古い記録は種問題のものとして扱う。 */
export function homeOf(item: ReviewItem): string {
  return item.playlistId ?? SEED_PLAYLIST_ID
}

/**
 * その日の復習カードを選ぶ。
 *   1. 期限が来たもの（遅れている順）
 *   2. 埋まらなければ、卒業済みのものを古い順に混ぜる（枠を遊ばせない）
 * 足りないぶんは呼び出し側が質問の音読で埋める。
 *
 * **いま使っている束のものだけを出す。** 別の束の質問が混ざると、
 * その束を選んだ意味が無くなる。
 */
export function selectForReview(
  items: ReviewItem[],
  date: string,
  slots: number,
  playlistId: string = SEED_PLAYLIST_ID,
): ReviewItem[] {
  const mine = items.filter((i) => homeOf(i) === playlistId)
  const due = mine
    .filter((i) => !isGraduated(i) && i.due <= date)
    .sort((a, b) => a.due.localeCompare(b.due) || a.createdAt.localeCompare(b.createdAt))

  if (due.length >= slots) return due.slice(0, slots)

  const chosen = new Set(due.map((i) => i.id))
  const spare = mine
    .filter((i) => isGraduated(i) && !chosen.has(i.id))
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt))

  return [...due, ...spare.slice(0, slots - due.length)]
}

/**
 * 期限が来ていて、まだ卒業していない項目の数。溜まり具合の目安。
 * 束を指定すればその束のぶんだけ、省けば全部。
 */
export function dueCount(items: ReviewItem[], date: string, playlistId?: string): number {
  return items.filter(
    (i) =>
      !isGraduated(i) &&
      i.due <= date &&
      (playlistId === undefined || homeOf(i) === playlistId),
  ).length
}

/**
 * いま使っていない束に溜まっている復習の数。
 * 束ごとに分けた以上、他の束の復習は出てこない。**黙って腐らせない**ために数える。
 */
export function dueElsewhere(items: ReviewItem[], date: string, playlistId: string): number {
  return dueCount(items, date) - dueCount(items, date, playlistId)
}

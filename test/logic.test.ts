import assert from 'node:assert/strict'
import { BANK, DAILY_COUNT, DAILY_MIX, pickDaily, pickFocus } from '../src/questions'
import { recentQuestionIds, streak, today, SessionRecord } from '../src/storage'
import {
  ANSWER_ROUNDS_MS,
  REVIEW_MS,
  REVIEW_SLOTS,
  SETTLE_MS,
  TOTAL_MS,
  reachedFor,
} from '../src/session'
import {
  advance,
  createItem,
  dueCount,
  INTERVALS,
  isGraduated,
  ReviewItem,
  selectForReview,
} from '../src/review'

/* --- 仕様の数字 --- */

assert.equal(TOTAL_MS, 365_000, '合計は6分5秒でなければならない')
assert.ok(TOTAL_MS <= 480_000, '8分を超えている')
assert.equal(REVIEW_MS, REVIEW_SLOTS * 20_000)
assert.equal(SETTLE_MS, 60_000)
assert.equal(reachedFor('idle'), 0)
assert.equal(reachedFor('done'), 5)

// 4/3/2: 同じ内容を、時間を縮めて3回
assert.equal(ANSWER_ROUNDS_MS.length, 3)
for (let i = 1; i < ANSWER_ROUNDS_MS.length; i++) {
  assert.ok(ANSWER_ROUNDS_MS[i] < ANSWER_ROUNDS_MS[i - 1], '回を追うごとに短くなっていない')
}

/* --- 問題バンク --- */

for (const q of BANK) {
  const words = q.text.split(/\s+/).length
  assert.ok(words <= 15, `長すぎる: ${q.text} (${words}語)`)
  // 質問文か Describe/Tell me 型の指示文。どちらも句読点で終わる。
  assert.ok(/[?.]$/.test(q.text), `文末の句読点がない: ${q.text}`)
  // 日本語が無いと、答える前に意味が分からず止まる。全問に必ず付ける。
  assert.ok(q.ja && q.ja.trim().length > 0, `日本語が無い: ${q.text}`)
  assert.ok(/[ぁ-んァ-ン一-龥]/.test(q.ja), `日本語になっていない: ${q.text} → ${q.ja}`)
  assert.notEqual(q.ja, q.text, `日本語が英語のまま: ${q.text}`)
}
assert.equal(new Set(BANK.map((q) => q.ja)).size, BANK.length, '日本語が重複している')
assert.equal(new Set(BANK.map((q) => q.id)).size, BANK.length, 'id が重複している')

const ten = pickDaily('2026-09-11')
assert.equal(ten.length, DAILY_COUNT)
assert.equal(new Set(ten.map((q) => q.id)).size, 10, '同じ日の10問に重複がある')
for (const level of ['easy', 'mid', 'hard'] as const) {
  assert.equal(ten.filter((q) => q.level === level).length, DAILY_MIX[level], `${level} の数`)
}
assert.deepEqual(pickDaily('2026-09-11').map((q) => q.id), ten.map((q) => q.id), '同じ日は同じ10問')

const recent = pickDaily('2026-09-10').map((q) => q.id)
assert.equal(
  pickDaily('2026-09-11', recent).filter((q) => recent.includes(q.id)).length,
  0,
  '直近問題を除外できていない',
)
assert.equal(pickDaily('2026-09-11', BANK.map((q) => q.id)).length, 10, '除外過多で問題数が減った')

// その日の1問は10問の中から選ばれ、日によって変わり、難易度が偏らない
const focus = pickFocus('2026-09-11', ten)
assert.ok(ten.some((q) => q.id === focus.id), '10問の外から選んでいる')
assert.equal(pickFocus('2026-09-11', ten).id, focus.id, '同じ日は同じ1問')
const levels = new Set(
  Array.from({ length: 30 }, (_, i) => {
    const date = `2026-10-${String(i + 1).padStart(2, '0')}`
    return pickFocus(date, pickDaily(date)).level
  }),
)
assert.ok(levels.size >= 2, '毎日同じ難易度ばかり出ている')

/* --- 復習スケジュール --- */

const item = createItem('What did you do?', '何をした？', 'I went to the gym.', '2026-09-11')
assert.equal(item.questionJa, '何をした？', '復習項目に日本語が入っていない')
assert.equal(item.due, '2026-09-12', '最初の復習は翌日')
assert.equal(item.reviews, 0)
assert.ok(!isGraduated(item))

// 間隔どおりに伸び、規定回数で卒業する
let cursor = item
const dues = ['2026-09-12']
for (let i = 0; i < INTERVALS.length; i++) {
  cursor = advance(cursor, cursor.due)
  dues.push(cursor.due)
}
assert.equal(cursor.reviews, INTERVALS.length)
assert.ok(isGraduated(cursor), '規定回数を終えても卒業しない')
assert.deepEqual(dues.slice(0, 4), ['2026-09-12', '2026-09-15', '2026-09-22', '2026-10-13'])
// 卒業後に間隔が壊れない
assert.equal(advance(cursor, '2026-10-13').due, cursor.due)

const mk = (id: string, due: string, reviews = 0): ReviewItem => ({
  id, question: `Q${id}`, sentence: `S${id}`, createdAt: due, reviews, due,
})

// 期限が来たものを、遅れている順に取る
const pool = [mk('a', '2026-09-11'), mk('b', '2026-09-09'), mk('c', '2026-09-10'), mk('d', '2026-09-20')]
const picked = selectForReview(pool, '2026-09-11', 4)
assert.deepEqual(picked.map((i) => i.id), ['b', 'c', 'a'], '遅れている順になっていない')
assert.ok(!picked.some((i) => i.id === 'd'), '未来の項目を出している')
assert.equal(dueCount(pool, '2026-09-11'), 3)

// 枠に上限がある
assert.equal(selectForReview(pool, '2026-09-11', 2).length, 2)

// 期限が足りなければ卒業済みで埋め、枠を遊ばせない
const withGrads = [...pool, mk('g1', '2026-08-01', INTERVALS.length), mk('g2', '2026-08-05', INTERVALS.length)]
const filled = selectForReview(withGrads, '2026-09-11', 4)
assert.equal(filled.length, 4, '枠が埋まっていない')
assert.equal(filled[3].id, 'g1', '卒業済みは古い順に入れる')
// 同じ項目を二度出さない
assert.equal(new Set(filled.map((i) => i.id)).size, filled.length, '同じ項目が重複している')

// 履歴が無い日でも落ちない
assert.deepEqual(selectForReview([], '2026-09-11', 4), [])

// 1日1項目増える定常状態で、枠が需要に足りているか
assert.equal(INTERVALS.length, REVIEW_SLOTS, '1日あたりの復習需要と枠数が釣り合っていない')

/* --- 記録 --- */

const day = (offset: number) => {
  const d = new Date('2026-09-11T09:00:00')
  d.setDate(d.getDate() + offset)
  return today(d)
}
const rec = (date: string, reached: number): SessionRecord => ({
  date, reached, questionIds: [], answeredIds: [], pickedId: null,
  rewrite: '', reviewed: 0, quiet: false, updatedAt: 0,
})
const from = new Date('2026-09-11T09:00:00')
assert.equal(streak([rec(day(-1), 5), rec(day(-2), 5)], from), 2, '昨日まで続いている')
assert.equal(streak([rec(day(0), 5), rec(day(-1), 5)], from), 2, '今日も完了')
assert.equal(streak([rec(day(0), 3), rec(day(-1), 5)], from), 1, '今日は途中')
assert.equal(streak([rec(day(-2), 5)], from), 0, '一昨日で途切れている')
assert.equal(streak([], from), 0)

const many = [rec(day(0), 5), rec(day(-1), 5), rec(day(-2), 5), rec(day(-3), 5)]
many[0].questionIds = ['a']; many[3].questionIds = ['z']
const ids = recentQuestionIds(many)
assert.ok(ids.includes('a') && !ids.includes('z'), '直近3回ぶんに絞れていない')

console.log('logic: all assertions passed')

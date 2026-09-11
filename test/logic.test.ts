import assert from 'node:assert/strict'
import { BANK, DAILY_COUNT, DAILY_MIX, pickDaily, pickThree, swapQuestion } from '../src/questions'
import { recentQuestionIds, streak, today, SessionRecord } from '../src/storage'
import { TOTAL_MS, reachedFor } from '../src/session'

// 仕様の数字が計画書とずれていないか
assert.equal(TOTAL_MS, 375_000, '合計は375秒でなければならない')
assert.equal(reachedFor('idle'), 0)
assert.equal(reachedFor('done'), 5)

// 音読6秒に収まる長さ（15語以内）
for (const q of BANK) {
  const words = q.text.split(/\s+/).length
  assert.ok(words <= 15, `長すぎる: ${q.text} (${words}語)`)
  // 質問文か Describe/Tell me 型の指示文。どちらも句読点で終わる。
  assert.ok(/[?.]$/.test(q.text), `文末の句読点がない: ${q.text}`)
}
assert.equal(new Set(BANK.map((q) => q.id)).size, BANK.length, 'id が重複している')

// 毎日10問、配分どおり、重複なし、同じ日は同じ問題
const ten = pickDaily('2026-09-11')
assert.equal(ten.length, DAILY_COUNT)
assert.equal(new Set(ten.map((q) => q.id)).size, 10, '同じ日の10問に重複がある')
for (const level of ['easy', 'mid', 'hard'] as const) {
  assert.equal(ten.filter((q) => q.level === level).length, DAILY_MIX[level], `${level} の数`)
}
assert.deepEqual(pickDaily('2026-09-11').map((q) => q.id), ten.map((q) => q.id), '同じ日は同じ10問')
assert.notDeepEqual(pickDaily('2026-09-12').map((q) => q.id), ten.map((q) => q.id), '別の日は別の10問')

// 直近の出題は避ける
const recent = pickDaily('2026-09-10').map((q) => q.id)
const avoided = pickDaily('2026-09-11', recent)
assert.equal(avoided.filter((q) => recent.includes(q.id)).length, 0, '直近問題を除外できていない')

// 除外しきれない場合でも10問は必ず出す
const everything = BANK.map((q) => q.id)
assert.equal(pickDaily('2026-09-11', everything).length, 10, '除外過多で問題数が減った')

// 工程3は easy/mid/hard を1問ずつ
const three = pickThree('2026-09-11', ten)
assert.equal(three.length, 3)
assert.deepEqual(three.map((q) => q.level), ['easy', 'mid', 'hard'], '3問のレベル配分')
assert.ok(three.every((q) => ten.some((t) => t.id === q.id)), '10問の外から選んでいる')

// 差し替えは同レベルの別問題
const swapped = swapQuestion(ten, three, three[0])
assert.notEqual(swapped.id, three[0].id, '差し替わっていない')
assert.equal(swapped.level, three[0].level, 'レベルが変わった')

// ストリーク: 今日が未完了でも昨日まで続いていれば生きている
const day = (offset: number) => {
  const d = new Date('2026-09-11T09:00:00')
  d.setDate(d.getDate() + offset)
  return today(d)
}
const rec = (date: string, reached: number): SessionRecord => ({
  date, reached, questionIds: [], answeredIds: [], pickedId: null,
  rewrite: '', quiet: false, updatedAt: 0,
})
const from = new Date('2026-09-11T09:00:00')
assert.equal(streak([rec(day(-1), 5), rec(day(-2), 5)], from), 2, '昨日まで続いている')
assert.equal(streak([rec(day(0), 5), rec(day(-1), 5)], from), 2, '今日も完了')
assert.equal(streak([rec(day(0), 3), rec(day(-1), 5)], from), 1, '今日は途中')
assert.equal(streak([rec(day(-2), 5)], from), 0, '一昨日で途切れている')
assert.equal(streak([], from), 0)

// 直近の出題 id は新しい順に3回ぶん
const many = [rec(day(0), 5), rec(day(-1), 5), rec(day(-2), 5), rec(day(-3), 5)]
many[0].questionIds = ['a']; many[3].questionIds = ['z']
const ids = recentQuestionIds(many)
assert.ok(ids.includes('a') && !ids.includes('z'), '直近3回ぶんに絞れていない')

console.log('logic: all assertions passed')

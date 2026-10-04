// 30秒を目標にしたカードを通しで確かめる。
// 見るのは「時間が表示され、30秒を超えても止まらないこと」
// 「30秒に届いた質問が出題から外れること」「届かなかったものが翌日に残ること」。
import assert from 'node:assert/strict'
import { launch } from './harness.mjs'

const DAY1 = '2026-10-04T09:00:00'
const DAY2 = '2026-10-05T09:00:00'

const { page, base, text, shot, close } = await launch({ time: DAY1 })
await page.goto(base)

await page.getByRole('button', { name: /開始/ }).waitFor()
assert.match(await text('.sub'), /30秒 話せるまで/, '目標が説明されていない')
await shot('1-idle')

/* --- 1枚目: 時間が出て、伏せてある --- */

await page.getByRole('button', { name: /開始/ }).click()
await page.locator('.card-body').waitFor()
assert.match(await text('.timer-target'), /目標 0:30/, 'タイムリミットが出ていない')
assert.match(await text('.timer'), /^0:0\d$/, '経過時間が出ていない')
assert.equal(await page.locator('.big-question-ja').count(), 0, '意味が最初から見えている')
assert.equal(await page.locator('.answer-text').count(), 0, '答え方が最初から見えている')

const first = await text('.big-question')
await page.getByRole('button', { name: '意味を表示' }).click()
assert.match(await text('.big-question-ja'), /[ぁ-んァ-ン一-龥]/, '意味が出ない')
await shot('2-card')

/* --- 30秒を超えても止まらない --- */

await page.clock.runFor(45_000)
assert.match(await text('.timer'), /0:4\d/, '30秒で止まってしまう')
assert.equal(await page.getByRole('button', { name: 'ストップ' }).count(), 1, 'ストップが無い')
await shot('3-over-target')

await page.getByRole('button', { name: 'ストップ' }).click()
assert.match(await text('.stopped-note'), /30秒に到達/, '到達を知らせない')
await page.getByRole('button', { name: '次へ' }).click()

/* --- 届かなかった質問は、その日のうちに出直す --- */

const second = await text('.big-question')
await page.clock.runFor(8_000)
await page.getByRole('button', { name: 'ストップ' }).click()
assert.match(await text('.stopped-note'), /あと 0:2\d/, '残りを知らせない')
await shot('4-short')
await page.getByRole('button', { name: '次へ' }).click()

// 到達した1枚目はもう出ない
const seen = []
for (let i = 3; i <= 10; i++) {
  seen.push(await text('.big-question'))
  await page.clock.runFor(2_000)
  await page.getByRole('button', { name: 'ストップ' }).click()
  if (!(await page.getByRole('button', { name: '次へ' }).count())) break
  await page.getByRole('button', { name: '次へ' }).click()
  if (await page.getByRole('button', { name: /開始/ }).count()) break
}
assert.ok(!seen.includes(first), '30秒に到達した質問がまた出た')
assert.ok(seen.includes(second), '届かなかった質問が出直していない')

await page.getByRole('button', { name: /開始/ }).waitFor({ timeout: 10_000 })
assert.match(await text('.idle-meta'), /30秒 到達 1 \//, '到達数が出ていない')
await shot('5-after')

/* --- 翌日: 届かなかったものが残り、長い順に出る --- */

await page.clock.setSystemTime(new Date(DAY2))
await page.reload()
await page.getByRole('button', { name: /開始/ }).waitFor()
assert.match(await text('.idle-meta'), /30秒 到達 1 \//, '到達が翌日に残っていない')

await page.getByRole('button', { name: /開始/ }).click()
await page.locator('.card-body').waitFor()
assert.notEqual(await text('.big-question'), first, '到達済みが翌日に出た')
// 8秒まで話せた質問が、2秒のものより先に来る
assert.match(await text('.hint'), /これまで 0:0[78]|の持ち帰り/, '記録の長い順になっていない')
await shot('6-next-day')

await page.getByRole('button', { name: '終了' }).click()
await page.getByRole('button', { name: /開始/ }).waitFor()

await close()
console.log('smoke: all assertions passed')

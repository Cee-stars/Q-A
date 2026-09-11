// 6分5秒のセッションを、時計を偽装して一気に通す。
// 検証するのは「仕様どおりの時間で工程が進み、書いた文が後日ちゃんと戻り、
// 途中で止めても記録が残る」こと。
import assert from 'node:assert/strict'
import { launch } from './harness.mjs'

const DAY1 = '2026-09-11T09:00:00'
const DAY2 = '2026-09-12T09:00:00'

const { page, base, text, shot, close } = await launch({ time: DAY1 })
await page.goto(base)

// --- 待機画面 ---
await page.getByRole('button', { name: /開始/ }).waitFor()
assert.match(await text('.log h2'), /質問応答（復習→3回回答→添削→定着）/)
await shot('1-idle')

/* =========================================================
   1日目: 復習する材料がまだ無いので、工程2は質問の音読になる
   ========================================================= */

await page.getByRole('button', { name: /開始/ }).click()
await page.locator('.card').waitFor()
assert.equal(await text('.stage-head h2'), '復習')
assert.match(await text('.card-kicker'), /音読 1/, '履歴が無い日は音読で埋まるはず')
const firstWarmup = await text('.card-question')
await shot('2-review-warmup')

await page.clock.runFor(6_200)
assert.notEqual(await text('.card-question'), firstWarmup, '6秒で次の質問に進んでいない')

// --- 工程3: 同じ1問を 45 → 35 → 25 秒 ---
await page.clock.runFor(74_000)
assert.equal(await text('.stage-head h2'), '3回回答 1/3', '工程3へ進んでいない')
assert.equal(await page.locator('button:has-text("一時停止")').count(), 0, '一時停止ボタンが存在する')
const asked = await text('.big-question')
assert.match(await text('.ring-label'), /0:45/)
await shot('3-answer')

await page.clock.runFor(45_000)
assert.equal(await text('.stage-head h2'), '3回回答 2/3')
assert.equal(await text('.big-question'), asked, '2回目が別の質問になっている')
assert.match(await text('.ring-label'), /0:35/, '2回目が35秒になっていない')

await page.clock.runFor(35_000)
assert.equal(await text('.stage-head h2'), '3回回答 3/3')
assert.equal(await text('.big-question'), asked, '3回目が別の質問になっている')
assert.match(await text('.ring-label'), /0:25/, '3回目が25秒になっていない')

// --- 工程4: 添削。選ばせない（3回答えた1問がそのまま来る） ---
await page.clock.runFor(25_000)
assert.equal(await text('.stage-head h2'), '添削')
assert.equal(await text('.picked-question'), asked, '添削の対象が3回答えた問題ではない')
assert.ok(await page.locator('.primary').isDisabled(), '空のまま先へ進めてしまう')

const SENTENCE = 'I usually start the day by checking my messages. It takes about ten minutes.'
await page.locator('textarea').fill(SENTENCE)
await shot('4-correct')

// --- 工程5: 読む → 見ずに言う → 読む ---
await page.locator('.primary').click()
assert.equal(await text('.stage-head h2'), '定着')
assert.match(await text('.hint'), /声に出して読む/)
assert.equal(await text('.settle-text'), SENTENCE)
await shot('5-settle-read')

await page.clock.runFor(21_000)
assert.match(await text('.hint'), /見ずに言う/, '2手目が暗唱になっていない')
assert.ok(!(await text('.settle-text')).includes('checking'), '暗唱の番なのに文が見えている')
await shot('6-settle-recall')

await page.clock.runFor(21_000)
assert.match(await text('.hint'), /もう一度読む/)
assert.equal(await text('.settle-text'), SENTENCE, '3手目で文が戻っていない')

// --- 完了 ---
await page.clock.runFor(20_000)
await page.locator('.done').waitFor()
assert.equal(await page.locator('.done .dot.on').count(), 5, '5工程すべてが点灯していない')
await shot('7-done')

await page.locator('.done .primary').click()
await page.reload()
await page.locator('.log li').first().waitFor()
assert.equal(await page.locator('.log li').first().locator('.dot.on').count(), 5, '記録が残っていない')

/* =========================================================
   2日目: 昨日の文が「質問」として戻ってくる。この再設計の要。
   ========================================================= */

await page.clock.setSystemTime(new Date(DAY2))
await page.reload()
await page.getByRole('button', { name: /開始/ }).waitFor()
assert.match(await text('.idle-meta'), /復習 1/, '復習が期限を迎えていない')
await shot('8-idle-due')

await page.getByRole('button', { name: /開始/ }).click()
await page.locator('.card').waitFor()
assert.equal(await text('.stage-head h2'), '復習 1/1', '昨日の項目が復習に出ていない')
assert.equal(await text('.card-question'), asked, '復習カードの質問が昨日の問題ではない')
assert.match(await text('.hint'), /見ずに思い出して言う/)
// 思い出す時間のあいだは答えを見せない
assert.equal(await page.locator('.card-answer').count(), 0, '思い出す前に答えが見えている')
await shot('9-review-recall')

await page.clock.runFor(12_500)
assert.equal(await text('.card-answer'), SENTENCE, '12秒後に答えが出ていない')
assert.match(await text('.hint'), /答えを見て読む/)
await shot('10-review-reveal')

// 復習枠の残りは音読で埋まる
await page.clock.runFor(8_000)
assert.match(await text('.card-kicker'), /音読/, '残り枠が音読で埋まっていない')

// 復習を終えた項目は、次の間隔まで期限が伸びる（同じ日に二度出ない）
await page.clock.runFor(61_000)
assert.equal(await text('.stage-head h2'), '3回回答 1/3')
await page.getByRole('button', { name: '終了' }).click()
await page.locator('.log li').first().waitFor()
assert.equal(await page.locator('.log li').first().locator('.dot.on').count(), 3, '中断時の到達工程が違う')
assert.match(await page.locator('.log li').first().innerText(), /3回回答まで/)
assert.equal(await page.locator('.idle-meta').innerText().then(t => /復習 \d/.test(t)), false, '復習済みの項目が同じ日にまた期限を迎えている')

await close()
console.log('smoke: all assertions passed')

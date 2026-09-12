// 4分のセッションを、時計を偽装して一気に通す。
// 検証するのは「仕様どおりの時間で工程が進み、言えなかった日でも持ち帰りが残り、
// それが後日ちゃんと質問として戻り、途中で止めても記録が残る」こと。
import assert from 'node:assert/strict'
import { launch } from './harness.mjs'

const DAY1 = '2026-09-11T09:00:00'
const DAY2 = '2026-09-12T09:00:00'

const { page, base, text, shot, close } = await launch({ time: DAY1 })
await page.goto(base)

// --- 待機画面 ---
await page.getByRole('button', { name: /開始/ }).waitFor()
assert.match(await text('.log h2'), /質問応答（復習→挑戦→手本→言い直し）/)
assert.match(await text('.picker'), /種問題/, 'プレイリストの選択が出ていない')
await shot('1-idle')

/* =========================================================
   1日目: 復習する材料がまだ無いので、工程2は質問の音読になる
   ========================================================= */

await page.getByRole('button', { name: /開始/ }).click()
await page.locator('.card').waitFor()
assert.equal(await text('.stage-head h2'), '復習')
assert.match(await text('.card-kicker'), /音読 1/, '履歴が無い日は音読で埋まるはず')
assert.match(await text('.card-ja'), /[ぁ-んァ-ン一-龥]/, '音読カードに日本語が出ていない')
const firstWarmup = await text('.card-question')
await shot('2-review-warmup')

await page.clock.runFor(6_200)
assert.notEqual(await text('.card-question'), firstWarmup, '6秒で次の質問に進んでいない')

// --- 工程3: 挑戦（20秒・自力） ---
await page.clock.runFor(74_000)
assert.equal(await text('.stage-head h2'), '挑戦', '工程3へ進んでいない')
assert.match(await text('.hint'), /日本語でいい/, '日本語で答えてよいと伝えていない')
assert.equal(await page.locator('button:has-text("一時停止")').count(), 0, '一時停止ボタンが存在する')
const asked = await text('.big-question')
const askedJa = await text('.big-question-ja')
assert.match(askedJa, /[ぁ-んァ-ン一-龥]/, '挑戦に日本語が出ていない')
assert.match(await text('.ring-label'), /0:20/, '挑戦が20秒になっていない')
await shot('3-attempt')

// --- 工程4: 手本。何も書かなくても必ず渡される ---
await page.clock.runFor(20_500)
assert.equal(await text('.stage-head h2'), '手本')
const model = await text('.corrected-text')
assert.ok(model.length > 0, '手本が空')
assert.ok((model.match(/[.!?]/g) ?? []).length >= 2, '手本が1文しかない')
assert.ok((await text('.picked-question')).includes(asked), '手本の質問が挑戦と違う')
assert.match(await text('.hint'), /2文目は自分のことに/, '丸暗記を防ぐ指示が出ていない')
await shot('4-model')

// --- 工程5: 言い直し。足場が 全表示 → 書き出しだけ → 非表示 と外れる ---
await page.getByRole('button', { name: '言い直しへ' }).click()
assert.equal(await text('.stage-head h2'), '言い直し 1/3')
assert.equal(await text('.respeak-model'), model, '1回目に手本が出ていない')
assert.match(await text('.ring-label'), /0:35/)
await shot('5-respeak-full')

await page.clock.runFor(35_500)
assert.equal(await text('.stage-head h2'), '言い直し 2/3')
const partial = await text('.respeak-model')
assert.ok(partial.length < model.length, '2回目で足場が減っていない')
assert.ok(model.startsWith(partial.replace(/\s*…\s*$/, '')), '2回目が手本の書き出しになっていない')
assert.match(await text('.ring-label'), /0:25/)
await shot('6-respeak-partial')

await page.clock.runFor(25_500)
assert.equal(await text('.stage-head h2'), '言い直し 3/3')
assert.ok(!(await text('.respeak-model')).includes(model.slice(0, 10)), '3回目で手本が消えていない')
assert.match(await text('.ring-label'), /0:20/)

// --- 完了 ---
await page.clock.runFor(20_500)
await page.locator('.done').waitFor()
assert.equal(await page.locator('.done .dot.on').count(), 5, '5工程すべてが点灯していない')
assert.equal(await text('.done-rewrite'), model, '何も書かなかった日の持ち帰りが手本になっていない')
await shot('7-done')

await page.locator('.done .primary').click()
await page.reload()
await page.locator('.log li').first().waitFor()
assert.equal(await page.locator('.log li').first().locator('.dot.on').count(), 5, '記録が残っていない')

/* =========================================================
   2日目: 一言も書けなくても、手本が質問として戻ってくる
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
assert.equal(await text('.card-ja'), askedJa, '復習カードに日本語が引き継がれていない')
assert.equal(await page.locator('.card-answer').count(), 0, '思い出す前に答えが見えている')
await shot('9-review-recall')

await page.clock.runFor(12_500)
assert.equal(await text('.card-answer'), model, '12秒後に昨日の持ち帰りが出ていない')
await shot('10-review-reveal')

await page.clock.runFor(8_000)
assert.match(await text('.card-kicker'), /音読/, '残り枠が音読で埋まっていない')

// 復習を終えた項目は次の間隔まで期限が伸びる（同じ日に二度出ない）
await page.clock.runFor(61_000)
assert.equal(await text('.stage-head h2'), '挑戦')
await page.getByRole('button', { name: '終了' }).click()
await page.locator('.log li').first().waitFor()
assert.equal(await page.locator('.log li').first().locator('.dot.on').count(), 3, '中断時の到達工程が違う')
assert.match(await page.locator('.log li').first().innerText(), /挑戦まで/)
assert.doesNotMatch(await text('.idle-meta'), /復習 \d/, '復習済みの項目が同じ日にまた期限を迎えている')

await close()
console.log('smoke: all assertions passed')

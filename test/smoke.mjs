// カード形式のドリルを通しで確かめる。
// 見るのは「意味と答え方が伏せてあること」「時間切れで答え方が出ること」
// 「答え方を見た質問が復習に積まれ、見なかった復習が次の間隔へ進むこと」。
import assert from 'node:assert/strict'
import { launch } from './harness.mjs'

const DAY1 = '2026-09-11T09:00:00'
const DAY2 = '2026-09-12T09:00:00'

const { page, base, text, shot, close } = await launch({ time: DAY1 })
await page.goto(base)

await page.getByRole('button', { name: /開始/ }).waitFor()
assert.match(await text('.log h2'), /質問応答（カード）/)
assert.match(await text('.sub'), /質問 → 声に出す → 意味と答え方/, '新しい形式が説明されていない')
assert.match(await text('.window-row'), /答える時間/, '答える時間を変えられない')
await shot('1-idle')

/* --- 1枚目: 伏せてある --- */

await page.getByRole('button', { name: /開始/ }).click()
await page.locator('.card-body').waitFor()
assert.match(await text('.stage-head h2'), /1 \/ 8/, 'カードの枚数が出ていない')

const first = await text('.big-question')
assert.ok(first.length > 0, '質問が出ていない')
assert.equal(await page.locator('.big-question-ja').count(), 0, '意味が最初から見えている')
assert.equal(await page.locator('.answer-text').count(), 0, '答え方が最初から見えている')
assert.equal(await page.getByRole('button', { name: '意味を表示' }).count(), 1)
assert.equal(await page.getByRole('button', { name: '答え方を表示' }).count(), 1)
await shot('2-card-hidden')

// 意味は自分で開ける
await page.getByRole('button', { name: '意味を表示' }).click()
assert.match(await text('.big-question-ja'), /[ぁ-んァ-ン一-龥]/, '意味が日本語で出ていない')
assert.equal(await page.locator('.answer-text').count(), 0, '意味を開けたら答え方まで出た')
await shot('3-meaning-shown')

/* --- 時間切れで答え方がひとりでに出る --- */

await page.clock.runFor(5_200)
await page.locator('.answer-text').waitFor()
const answer = await text('.answer-text')
assert.ok(answer.length > 0, '時間切れでも答え方が出ない')
assert.match(await text('.hint'), /答え方を見る/)
await shot('4-answer-revealed')

// この質問は「言えなかった」ので、復習に積まれるはず
await page.getByRole('button', { name: '次へ' }).click()
assert.match(await text('.stage-head h2'), /2 \/ 8/, '次のカードへ進まない')
assert.equal(await page.locator('.answer-text').count(), 0, '次のカードで伏せ直していない')
assert.equal(await page.locator('.big-question-ja').count(), 0, '次のカードで意味が開いたまま')

/* --- 自力で答えたカードは積まれない --- */

const second = await text('.big-question')
await page.getByRole('button', { name: '次へ' }).click()

// 残りを時間切れで流す
for (let i = 3; i <= 8; i++) {
  await page.clock.runFor(5_200)
  await page.getByRole('button', { name: i === 8 ? '終わる' : '次へ' }).click()
}

await page.getByRole('button', { name: /開始/ }).waitFor()
// 記録の保存は非同期なので、画面に出るまで待つ
await page.waitForFunction(
  () => /8 \/ 8/.test(document.querySelector('.log li')?.textContent ?? ''),
  null,
  { timeout: 5_000 },
)
await shot('5-done')

/* --- 翌日: 答え方を見た質問が復習として戻る --- */

await page.clock.setSystemTime(new Date(DAY2))
await page.reload()
await page.getByRole('button', { name: /開始/ }).waitFor()
assert.match(await text('.idle-meta'), /復習 \d/, '復習が積まれていない')

await page.getByRole('button', { name: /開始/ }).click()
await page.locator('.card-body').waitFor()
assert.match(await text('.hint'), /の持ち帰り/, '復習カードが先頭に来ていない')
assert.equal(await text('.big-question'), first, '復習に出た質問が違う')
assert.notEqual(await text('.big-question'), second, '自力で答えた質問まで積まれている')
await shot('6-review-card')

// 自力で答えれば（答え方を見なければ）次の間隔へ進み、同じ質問は出直さない
await page.getByRole('button', { name: '次へ' }).click()
assert.notEqual(await text('.big-question'), first, '同じ復習が二度続けて出た')

// 途中で終了しても、そこまでが残る
await page.getByRole('button', { name: '終了' }).click()
// 1枚だけ終えて止めたので 1/8
await page.waitForFunction(
  () => /1 \/ 8/.test(document.querySelector('.log li')?.textContent ?? ''),
  null,
  { timeout: 5_000 },
)

await close()
console.log('smoke: all assertions passed')

// 偽のマイクに実際の音を流し込んで、反応時間の測定が端から端まで通るか確かめる。
// しきい値や保持時間の細かい挙動は logic テストで固めてあるので、
// ここで見るのは「マイクが開き、無音を測り、声を拾い、数字が残るか」。
import assert from 'node:assert/strict'
import { launch } from './harness.mjs'

const { page, base, text, shot, close } = await launch({ fakeAudio: 'test/fixtures/onset.wav' })
page.on('console', (m) => {
  if (m.type() === 'error') console.error('CONSOLE:', m.text())
})
await page.goto(base)

// 読み上げを切る。切ると質問の提示が終わった時点ですぐ計測が始まるので、
// 偽マイクの音と計測窓の関係が読みやすくなる。
await page.getByRole('button', { name: /読み上げ/ }).click()
assert.match(await text('.idle-meta'), /読み上げ OFF/)

await page.getByRole('button', { name: /反射/ }).click()
assert.match(await text('.frame-text'), /I think/, '答える型が出ていない')
assert.match(await text('.reflex-notes'), /合否は出しません/, '測るだけだと伝えていない')
await shot('r1-intro')

await page.getByRole('button', { name: '開始' }).click()

// 無音の基準を測る画面を通る
await page.locator('.reflex.center, .stage').first().waitFor()

// 1問目の計測結果が出るまで待つ
const result = page.locator('.reflex-result strong')
await result.waitFor({ timeout: 20_000 })
const first = await result.innerText()
assert.match(first, /^\d+\.\d{2}秒$|^—$/, `計測結果の形式が違う: ${first}`)
assert.notEqual(first, '—', '偽マイクの音を拾えていない')
await shot('r2-measured')

const ms = Number(first.replace('秒', '')) * 1000
assert.ok(ms > 0 && ms < 6_000, `計測値が範囲外: ${first}`)

// 2問目にも進む
await page.locator('.stage-head h2').filter({ hasText: '反射 2/' }).waitFor({ timeout: 20_000 })

// 途中で終了しても壊れない
await page.getByRole('button', { name: '終了' }).click()
await page.getByRole('button', { name: /開始/ }).waitFor()

await close()
console.log('reflex: all assertions passed')

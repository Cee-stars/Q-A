// 「使用中と押した束」と「質問を足した束」がずれる不具合の再現と、その修正の確認。
// 利用者の報告: 何度もオンライン英会話で使用中を押しているのに、質問が別の束に入る。
import assert from 'node:assert/strict'
import { launch } from './harness.mjs'

const { page, base, text, shot, close } = await launch({ time: '2026-09-20T09:00:00' })
await page.goto(base)

const makePlaylist = async (name) => {
  await page.locator('input[placeholder="新しいプレイリスト名"]').fill(name)
  await page.locator('.picker-add').last().click()
}

const addQuestion = async (en, ja, model) => {
  const form = page.locator('.qform')
  await form.locator('input').nth(0).fill(en)
  await form.locator('input').nth(1).fill(ja)
  await form.locator('textarea').fill(model)
  await form.getByRole('button', { name: /に追加$/ }).click()
}

/** 束の行。見出しで特定する（行全体だと移動の選択肢に相手の名前が入って当たる）。 */
const row = (name) =>
  page.locator('.playlists > li').filter({ has: page.locator('.playlist-name', { hasText: name }) })

/** 束ごとの問題数を { 名前: 問題数 } で読む。 */
const counts = async () =>
  Object.fromEntries(
    await page.locator('.playlists > li').evaluateAll((rows) =>
      rows.map((row) => [
        row.querySelector('.playlist-name')?.childNodes[0]?.textContent?.trim(),
        Number(row.querySelector('.playlist-name span')?.textContent?.replace(/\D/g, '') ?? 0),
      ]),
    ),
  )

await page.locator('.picker-add').click()
await page.locator('.playlists, .empty').first().waitFor()

// 1つめの束を作って、質問を1問入れておく（報告時の状況を作る）
await makePlaylist('雑談フレーズ')
await addQuestion('It sounds juicy and yummy.', 'みずみずしくて美味しそう。', 'It sounds juicy. I want to try it.')
assert.deepEqual(await counts(), { 雑談フレーズ: 1 })

// 2つめの束を作る
await makePlaylist('オンライン英会話')
assert.deepEqual(await counts(), { 雑談フレーズ: 1, オンライン英会話: 0 })

/* --- ここが不具合の核心 --- */

// 画面をいったん離れて開き直す。利用者はこの状態から操作していた。
// 開き直すと先頭の束が勝手に開くので、使用中に押した束とフォームがずれる。
await page.getByRole('button', { name: '戻る' }).click()
await page.getByRole('button', { name: /開始/ }).waitFor()
await page.locator('.picker-add').click()
await page.locator('.playlists').waitFor()

// 「オンライン英会話」を使用中にする
const online = row('オンライン英会話')
await online.getByRole('button', { name: /^使う$|^使用中$/ }).click()
assert.match(await online.innerText(), /使用中/, '使用中にならない')

// 開いているフォームは、使用中にした束のものでなければならない
await page.locator('.qform').waitFor()
assert.match(
  await text('.qform-target'),
  /オンライン英会話/,
  '使用中に押した束とは別の束のフォームが開いている',
)
await shot('p1-form-follows-selection')

// ここで足した質問は、オンライン英会話に入る
await addQuestion('How was your day?', '今日はどうだった？', 'It was busy. But I finished my work.')
assert.deepEqual(
  await counts(),
  { 雑談フレーズ: 1, オンライン英会話: 1 },
  '使用中の束ではないほうに質問が入った',
)

// 別の束を開いたら、書きかけは持ち越さない
const chat = row('雑談フレーズ')
await chat.locator('.playlist-name').click()
assert.match(await text('.qform-target'), /雑談フレーズ/)
assert.equal(await page.locator('.qform input').nth(0).inputValue(), '', '書きかけが別の束へ持ち越された')

/* --- 質問の移動。消して書き直さずに済むこと --- */

// 「雑談フレーズ」の質問を「オンライン英会話」へ移す
const chatItem = chat.locator('.qlist li').first()
const movingText = await chatItem.locator('b').innerText()
await chatItem.locator('.qmove').selectOption({ label: 'オンライン英会話 へ' })

assert.deepEqual(
  await counts(),
  { 雑談フレーズ: 0, オンライン英会話: 2 },
  '移動で数が合っていない',
)
await shot('p3-moved')

// 中身がそのまま移っている（消して書き直す必要が無いこと）
await online.locator('.playlist-name').click()
const texts = await online.locator('.qlist b').allInnerTexts()
assert.ok(texts.includes(movingText), '移動した質問の英文が失われた')
const movedRow = online.locator('.qlist li').filter({ has: page.locator('b', { hasText: movingText }) })
assert.match(await movedRow.innerText(), /みずみずしくて美味しそう/, '日本語が移っていない')
assert.match(await movedRow.innerText(), /It sounds juicy/, '手本が移っていない')

// 戻せる
await movedRow.locator('.qmove').selectOption({ label: '雑談フレーズ へ' })
assert.deepEqual(
  await counts(),
  { 雑談フレーズ: 1, オンライン英会話: 1 },
  '戻せていない',
)

// 開き直しても移動が残っている
await page.getByRole('button', { name: '戻る' }).click()
await page.getByRole('button', { name: /開始/ }).waitFor()
await page.locator('.picker-add').click()
await page.locator('.playlists').waitFor()
assert.deepEqual(await counts(), { 雑談フレーズ: 1, オンライン英会話: 1 }, '移動が保存されていない')

/* --- 0問の束を選んだままでも、練習は壊れない --- */

await makePlaylist('からっぽ')
const empty = row('からっぽ')
await empty.getByRole('button', { name: /^使う$/ }).click()
await page.getByRole('button', { name: '戻る' }).click()

assert.match(await text('.idle-meta'), /0問/, '空の束であることを知らせていない')
await shot('p2-empty-warning')

await page.getByRole('button', { name: /開始/ }).click()
await page.locator('.card').waitFor()
await page.clock.runFor(80_500)
assert.equal(await text('.stage-head h2'), '挑戦', '空の束を選ぶとセッションが壊れる')
assert.ok((await text('.big-question')).length > 0, '空の束でその日の1問が出ない')
assert.ok((await text('.big-question-ja')).length > 0, '空の束で日本語が出ない')

await page.clock.runFor(20_500)
assert.equal(await text('.stage-head h2'), '手本')
assert.ok((await text('.corrected-text')).length > 0, '空の束で手本が出ない')

await close()
console.log('playlist: all assertions passed')

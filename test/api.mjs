// Claude API を差し替えて、添削と先読み生成の配線を確かめる。
// 実際に課金される呼び出しはしない。確かめたいのは「何を送り、返ってきたものを
// どこに流すか」と、「失敗しても練習が止まらないか」。
import assert from 'node:assert/strict'
import { launch } from './harness.mjs'

const DAY1 = '2026-09-11T09:00:00'
const DAY2 = '2026-09-12T09:00:00'

const { page, base, text, shot, close, runSession } = await launch({ time: DAY1 })

/** API に届いたリクエスト本文を控えておく。 */
const sent = []
let mode = 'ok'

await page.route('**://api.anthropic.com/**', async (route) => {
  const body = JSON.parse(route.request().postData() ?? '{}')
  sent.push(body)

  if (mode === 'fail') {
    await route.fulfill({
      status: 401,
      contentType: 'application/json',
      body: JSON.stringify({ type: 'error', error: { type: 'authentication_error', message: 'invalid x-api-key' } }),
    })
    return
  }

  // 生成か添削かは、送られたスキーマで見分ける
  const isGeneration = JSON.stringify(body.output_config ?? {}).includes('questions')
  const payload = isGeneration
    ? {
        questions: Array.from({ length: 10 }, (_, i) => ({
          text: `Generated question ${i + 1}?`,
          ja: `生成された質問 ${i + 1}`,
          model: `This is a model answer ${i + 1}. I say it twice.`,
          level: i < 7 ? 'easy' : 'mid',
        })),
      }
    : {
        corrected: CORRECTED,
        fixes: [
          { was: 'go to gym', now: 'go to the gym', why: 'needs the article' },
          { was: 'after I eat', now: 'afterwards I eat', why: 'more natural' },
        ],
      }

  await route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({
      id: 'msg_test',
      type: 'message',
      role: 'assistant',
      model: 'claude-opus-5',
      content: [{ type: 'text', text: JSON.stringify(payload) }],
      stop_reason: 'end_turn',
      stop_sequence: null,
      usage: { input_tokens: 10, output_tokens: 10 },
    }),
  })
})

await page.goto(base)

/* --- 設定にキーを入れる --- */

await page.getByRole('button', { name: '設定' }).click()
await page.locator('input[placeholder="sk-ant-..."]').fill('sk-ant-test-key')
await shot('a1-settings')
await page.getByRole('button', { name: '保存' }).click()
await page.getByRole('button', { name: /開始/ }).waitFor()

/* --- セッションを終えると、翌日ぶんが先読み生成される --- */

await page.getByRole('button', { name: /開始/ }).click()
await page.locator('.card-body').waitFor()
const asked = await text('.big-question')
await page.getByRole('button', { name: '終了' }).click()
await page.getByRole('button', { name: /開始/ }).waitFor()
// 答え方を見ずに終える。見ると復習に積まれ、翌日が復習だけで埋まって
// 生成された問題が出る余地が無くなる。
await runSession({ holdMs: 31_000 })
await page.getByRole('button', { name: /開始/ }).waitFor()

await page.waitForFunction(() => true)
await page.waitForTimeout(500)
const generation = sent.find((r) => JSON.stringify(r.output_config ?? {}).includes('questions'))
assert.ok(generation, '翌日ぶんの生成が走っていない')
assert.equal(generation.model, 'claude-opus-5')
assert.ok(
  generation.messages[0].content.includes(asked),
  '直近の出題が除外指定に入っていない',
)
await shot('a2-generated')

/* --- 翌日: 生成された問題が使われる --- */

await page.clock.setSystemTime(new Date(DAY2))
await page.reload()
await page.getByRole('button', { name: /開始/ }).waitFor()
assert.match(await text('.idle-meta'), /今日のぶん生成済み/, '先読みぶんが読み込まれていない')

await page.getByRole('button', { name: /開始/ }).click()
await page.locator('.card-body').waitFor()

// 先頭は昨日ぶんの復習。そこを抜けると生成された問題が出る。
let sawGenerated = false
for (let i = 1; i <= 12; i++) {
  if (/Generated question/.test(await text('.big-question'))) {
    sawGenerated = true
    await page.getByRole('button', { name: '意味を表示' }).click()
    assert.match(await text('.big-question-ja'), /生成された質問/, '生成された問題に日本語が無い')
    await page.getByRole('button', { name: '答え方を表示' }).click()
    assert.match(await text('.answer-text'), /model answer/i, '生成された問題に手本が無い')
    break
  }
  await page.clock.runFor(31_000)
  await page.getByRole('button', { name: 'ストップ' }).click()
  if (!(await page.getByRole('button', { name: '次へ' }).count())) break
  await page.getByRole('button', { name: '次へ' }).click()
  if (await page.getByRole('button', { name: /開始/ }).count()) break
}
assert.ok(sawGenerated, '生成された問題が使われていない')
await shot('a3-generated')

/* --- API が落ちても練習は止まらない --- */

mode = 'fail'
await page.clock.setSystemTime(new Date('2026-09-13T09:00:00'))
await page.reload()
await page.getByRole('button', { name: /開始/ }).click()
await page.locator('.card-body').waitFor()
assert.ok((await text('.big-question')).length > 0, '生成が落ちるとカードが出ない')
await page.getByRole('button', { name: '答え方を表示' }).click()
assert.ok((await text('.answer-text')).length > 0, '生成が落ちると答え方が出ない')
await shot('a4-offline')

await close()
console.log('api: all assertions passed')

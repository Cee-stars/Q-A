// Claude API を差し替えて、添削と先読み生成の配線を確かめる。
// 実際に課金される呼び出しはしない。確かめたいのは「何を送り、返ってきたものを
// どこに流すか」と、「失敗しても練習が止まらないか」。
import assert from 'node:assert/strict'
import { launch } from './harness.mjs'

const DAY1 = '2026-09-11T09:00:00'
const DAY2 = '2026-09-12T09:00:00'
const ANSWER = 'I go to gym in morning and after I eat breakfast quickly.'
const CORRECTED = 'I go to the gym in the morning, and afterwards I eat a quick breakfast.'

const { page, base, text, shot, close } = await launch({ time: DAY1 })

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
          level: i < 6 ? 'easy' : i < 9 ? 'mid' : 'hard',
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

assert.match(await text('.idle-meta'), /種問題で練習中/, 'キー未設定の表示が出ていない')
await page.getByRole('button', { name: '設定' }).click()
await page.locator('input[type=password]').fill('sk-ant-test-key')
await shot('a1-settings')
await page.getByRole('button', { name: '保存' }).click()
await page.getByRole('button', { name: /開始/ }).waitFor()
assert.doesNotMatch(await text('.idle-meta'), /種問題で練習中/, 'キー設定後も未設定の表示が残っている')

/* --- 工程4まで進める --- */

const toCorrectStage = async () => {
  await page.getByRole('button', { name: /開始/ }).click()
  await page.locator('.card').waitFor()
  await page.clock.runFor(80_500) // 工程2
  await page.clock.runFor(105_500) // 工程3
  assert.equal(await text('.stage-head h2'), '添削')
}
await toCorrectStage()

const asked = await text('.picked-question')
await page.locator('textarea').fill(ANSWER)

/* --- 添削が返る --- */

await page.getByRole('button', { name: '添削する' }).click()
await page.locator('.corrected-text').waitFor()
assert.equal(await text('.corrected-text'), CORRECTED)
assert.equal(await page.locator('.fixes li').count(), 2, '直した箇所が出ていない')
assert.match(await text('.fixes'), /go to the gym/)
await shot('a2-corrected')

// 送った中身: 質問と学習者の答えが両方入っていること
const correctionRequest = sent.at(-1)
assert.equal(correctionRequest.model, 'claude-opus-5')
const prompt = correctionRequest.messages[0].content
assert.ok(prompt.includes(asked), '質問がプロンプトに入っていない')
assert.ok(prompt.includes(ANSWER), '学習者の答えがプロンプトに入っていない')
assert.ok(correctionRequest.max_tokens <= 1000, '出力上限が緩い')

/* --- 定着と復習に流れるのは、添削された文のほう --- */

await page.getByRole('button', { name: '定着へ' }).click()
assert.equal(await text('.stage-head h2'), '定着')
assert.equal(await text('.settle-text'), CORRECTED, '定着で読むのが添削前の文になっている')

await page.clock.runFor(61_000)
await page.locator('.done').waitFor()
assert.equal(await text('.done-rewrite'), CORRECTED)

/* --- 終わってから翌日ぶんを先読みしている --- */

await page.waitForFunction(() => document.querySelector('.done') !== null)
await page.waitForTimeout(500)
const generation = sent.find((r) => JSON.stringify(r.output_config ?? {}).includes('questions'))
assert.ok(generation, '翌日ぶんの生成が走っていない')
assert.ok(
  generation.messages[0].content.includes(asked),
  '直近の出題が除外指定に入っていない',
)

await page.locator('.done .primary').click()
assert.match(await text('.idle-meta'), /復習 0|小声/, '待機画面に戻っていない')

/* --- 翌日: 生成された問題が使われ、添削文が質問として戻る --- */

await page.clock.setSystemTime(new Date(DAY2))
await page.reload()
await page.getByRole('button', { name: /開始/ }).waitFor()
assert.match(await text('.idle-meta'), /今日のぶん生成済み/, '先読みぶんが読み込まれていない')

await page.getByRole('button', { name: /開始/ }).click()
await page.locator('.card').waitFor()
assert.equal(await text('.card-question'), asked, '昨日の問題が復習に出ていない')
await page.clock.runFor(12_500)
assert.equal(await text('.card-answer'), CORRECTED, '復習に出るのが添削前の文になっている')

await page.clock.runFor(68_000)
assert.match(await text('.big-question'), /Generated question/, '生成された問題が使われていない')
await shot('a3-generated')

/* --- API が落ちても練習は止まらない --- */

mode = 'fail'
await page.clock.runFor(105_500)
assert.equal(await text('.stage-head h2'), '添削')
await page.locator('textarea').fill(ANSWER)
await page.getByRole('button', { name: '添削する' }).click()
await page.locator('.error').waitFor()
assert.match(await text('.error'), /APIキーが正しくありません/)
await shot('a4-error')

// 自分の文のまま工程5へ進める
await page.getByRole('button', { name: '定着へ' }).click()
assert.equal(await text('.stage-head h2'), '定着')
assert.equal(await text('.settle-text'), ANSWER, '添削失敗時に自分の文が残っていない')

await close()
console.log('api: all assertions passed')

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

/* --- 工程4まで進める --- */

/** 工程4（手本）まで進めて、その日の1問（英語・日本語）を返す。 */
const toModelStage = async () => {
  await page.getByRole('button', { name: /開始/ }).click()
  await page.locator('.card').waitFor()
  await page.clock.runFor(80_500) // 工程2 復習
  const en = await text('.big-question')
  const ja = await text('.big-question-ja')
  await page.clock.runFor(20_500) // 工程3 挑戦
  assert.equal(await text('.stage-head h2'), '手本')
  return { en, ja }
}
const { en: asked, ja: askedJa } = await toModelStage()
assert.match(askedJa, /[ぁ-んァ-ン一-龥]/, '挑戦に日本語が出ていない')
assert.ok((await text('.picked-question')).includes(askedJa), '手本画面に日本語が出ていない')
// キーが無くても手本は出ている。API はその上書きでしかない。
assert.ok((await text('.corrected-text')).length > 0, 'キーの有無に関わらず手本は出るはず')
assert.equal(
  await page.getByRole('button', { name: '自分の文を添削する' }).count(),
  1,
  'キーを入れたのに添削の口が出ていない',
)
await page.locator('textarea').fill(ANSWER)

/* --- 添削が返る --- */

await page.getByRole('button', { name: '自分の文を添削する' }).click()
await page.waitForFunction(
  (want) => document.querySelector('.corrected-text')?.textContent === want,
  CORRECTED,
)
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

await page.getByRole('button', { name: '言い直しへ' }).click()
assert.equal(await text('.stage-head h2'), '言い直し 1/3')
assert.equal(await text('.respeak-model'), CORRECTED, '言い直しで読むのが添削前の文になっている')

await page.clock.runFor(81_000)
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
assert.match(await text('.big-question-ja'), /生成された質問/, '生成された問題に日本語が無い')
await shot('a3-generated')
// 生成された問題にも手本が付いている
await page.clock.runFor(20_500)
assert.match(await text('.corrected-text'), /model answer/i, '生成された問題に手本が無い')

/* --- API が落ちても練習は止まらない --- */

mode = 'fail'
assert.equal(await text('.stage-head h2'), '手本')
const fallbackModel = await text('.corrected-text')
await page.locator('textarea').fill(ANSWER)
await page.getByRole('button', { name: '自分の文を添削する' }).click()
await page.locator('.error').waitFor()
assert.match(await text('.error'), /APIキーが正しくありません/)
assert.equal(await text('.corrected-text'), fallbackModel, '添削が落ちたのに手本が消えている')
await shot('a4-error')

// 添削が落ちても、自分の文のまま言い直しへ進める
await page.getByRole('button', { name: '言い直しへ' }).click()
assert.equal(await text('.stage-head h2'), '言い直し 1/3')
assert.equal(await text('.respeak-model'), ANSWER, '添削失敗時に自分の文が残っていない')

await close()
console.log('api: all assertions passed')

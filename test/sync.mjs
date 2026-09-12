// GitHub の Gist を差し替えて、2台の端末が同じ置き場を使う状況を再現する。
// 確かめたいのは「進んだ記録が、後から同期した端末で巻き戻らないか」。
import assert from 'node:assert/strict'
import { launch } from './harness.mjs'

const DAY1 = '2026-09-11T09:00:00'
const GIST_ID = 'abc123'
const TOKEN = 'ghp_test_token'

/** Gist の中身。2台のページがこれを共有する。 */
const gist = { files: {} }
const seen = { get: 0, patch: 0, post: 0, auth: new Set() }

async function routeGist(route) {
  const request = route.request()
  seen.auth.add(request.headers()['authorization'])
  const method = request.method()

  if (method === 'POST') {
    seen.post++
    Object.assign(gist.files, JSON.parse(request.postData()).files)
    await route.fulfill({ status: 201, contentType: 'application/json', body: JSON.stringify({ id: GIST_ID }) })
    return
  }
  if (method === 'PATCH') {
    seen.patch++
    // GitHub と同じく、送られたファイルだけを差し替える。
    Object.assign(gist.files, JSON.parse(request.postData()).files)
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ id: GIST_ID, files: gist.files }) })
    return
  }
  seen.get++
  await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ id: GIST_ID, files: gist.files }) })
}

/** 1台ぶん。設定を入れてから、指定の到達工程までセッションを進める。 */
async function device(label, { reach }) {
  const d = await launch({ time: DAY1 })
  await d.page.route('**://api.github.com/gists**', routeGist)
  await d.page.goto(d.base)

  await d.page.getByRole('button', { name: '設定' }).click()
  await d.page.locator('summary', { hasText: '端末どうしの同期' }).click()
  await d.page.locator('input[placeholder="ghp_..."]').fill(TOKEN)
  await d.page.locator('input[placeholder="空なら新しく作ります"]').fill(GIST_ID)
  await d.page.getByRole('button', { name: '保存' }).click()
  await d.page.getByRole('button', { name: /開始/ }).waitFor()

  await d.page.getByRole('button', { name: /開始/ }).click()
  await d.page.locator('.card').waitFor()
  await d.page.clock.runFor(80_500) // 復習
  if (reach >= 4) {
    await d.page.clock.runFor(20_500) // 挑戦
    await d.page.getByRole('button', { name: '言い直しへ' }).click()
    await d.page.clock.runFor(81_000) // 言い直し3回
    await d.page.locator('.done').waitFor()
    await d.page.locator('.done .primary').click()
  } else {
    await d.page.clock.runFor(5_000)
    await d.page.getByRole('button', { name: '終了' }).click()
  }
  await d.page.locator('.log li').first().waitFor()
  const dots = await d.page.locator('.log li').first().locator('.dot.on').count()
  assert.equal(dots, reach, `${label}: 到達工程が違う`)
  return d
}

/* --- 1台目: 最後まで通す（到達5）。完了時に自動で同期される --- */

const a = await device('A', { reach: 5 })
await a.page.waitForFunction(() => !document.body.innerText.includes('同期中'))
assert.ok(gist.files['qa-drill-data.json'], '自分のファイル名で置かれていない')
const stored = JSON.parse(gist.files['qa-drill-data.json'].content)
assert.equal(stored.version, 1)
assert.equal(stored.records[0].reached, 5, '置き場に完了が届いていない')
assert.ok(stored.reviews.length >= 1, '持ち帰りが同期されていない')
assert.ok(!JSON.stringify(stored).includes(TOKEN), 'トークンが置き場に漏れている')
assert.ok(!JSON.stringify(stored).includes('apiKey'), 'APIキーが置き場に漏れている')
await a.close()

/* --- 同居している別アプリのファイルは触らない --- */

gist.files['sunkan-data.json'] = { content: '{"other":"app"}' }

/* --- 2台目: 途中で止める（到達3）。合流しても1台目の完了が勝つ --- */

const b = await device('B', { reach: 3 })
await b.page.getByRole('button', { name: /同期/ }).click()
await b.page.waitForFunction(() => {
  const row = document.querySelector('.log li')
  return row && row.querySelectorAll('.dot.on').length === 5
}, null, { timeout: 10_000 })

assert.equal(
  await b.page.locator('.log li').first().locator('.dot.on').count(),
  5,
  '同期で完了が取り込まれていない',
)
assert.match(await b.text('.log li'), /完了/)

const after = JSON.parse(gist.files['qa-drill-data.json'].content)
assert.equal(after.records[0].reached, 5, '途中で止めた端末が、完了の記録を巻き戻した')
assert.equal(gist.files['sunkan-data.json'].content, '{"other":"app"}', '同居アプリのファイルを壊した')
assert.ok(seen.get > 0 && seen.patch > 0, '読み書きが片方しか起きていない')
assert.deepEqual([...seen.auth], [`token ${TOKEN}`], '認証ヘッダが想定と違う')
await b.shot('s1-synced')
await b.close()

console.log('sync: all assertions passed')

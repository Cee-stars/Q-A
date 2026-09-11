// 6分15秒のセッションを、時計を偽装して一気に通す。
// 検証するのは「仕様どおりの時間で工程が進み、途中で止めても記録が残る」こと。
import { chromium } from 'playwright'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { readFile } from 'node:fs/promises'
import { extname, join, normalize } from 'node:path'
import { existsSync, readdirSync } from 'node:fs'

const SHOTS = process.env.SHOTS ?? 'test/shots'
const ROOT = 'dist'
const TYPES = {
  '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css',
  '.png': 'image/png', '.webmanifest': 'application/manifest+json',
}

// dist を GitHub Pages と同じ /Q-A/ 配下で配る。
const server = createServer(async (req, res) => {
  const path = decodeURIComponent(new URL(req.url, 'http://x').pathname).replace(/^\/Q-A/, '')
  const safe = normalize(path).replace(/^(\.\.[/\\])+/, '')
  const file = safe.endsWith('/') || safe === '' ? join(ROOT, safe, 'index.html') : join(ROOT, safe)
  try {
    const body = await readFile(file)
    res.writeHead(200, { 'content-type': TYPES[extname(file)] ?? 'application/octet-stream' })
    res.end(body)
  } catch {
    res.writeHead(404).end('not found')
  }
})

await new Promise((resolve) => server.listen(0, resolve))
const BASE = `http://localhost:${server.address().port}/Q-A/`

// この環境の Chromium は PLAYWRIGHT_BROWSERS_PATH 配下にある。
// Playwright のリビジョンと一致しないことがあるので、実体を探して渡す。
function findChromium() {
  if (process.env.CHROMIUM_PATH) return process.env.CHROMIUM_PATH
  const root = process.env.PLAYWRIGHT_BROWSERS_PATH
  if (!root || !existsSync(root)) return undefined
  for (const dir of readdirSync(root)) {
    if (!dir.startsWith('chromium-')) continue
    const bin = join(root, dir, 'chrome-linux', 'chrome')
    if (existsSync(bin)) return bin
  }
  return undefined
}

const browser = await chromium.launch({ executablePath: findChromium() })
const page = await browser.newPage({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2 })
page.on('pageerror', (e) => { console.error('PAGE ERROR:', e.message); process.exitCode = 1 })

await page.clock.install()
await page.goto(BASE)

const shot = (name) => page.screenshot({ path: `${SHOTS}/${name}.png` })
const text = (sel) => page.locator(sel).innerText()

// --- 待機画面 ---
await page.getByRole('button', { name: /開始/ }).waitFor()
assert.match(await text('.log h2'), /質問応答（Q10音読→3問回答→1問添削）/)
await shot('1-idle')

// --- 工程2: Q10音読 (60秒) ---
await page.getByRole('button', { name: /開始/ }).click()
await page.locator('.ten li').first().waitFor()
assert.equal(await page.locator('.ten li').count(), 10, '10問出ていない')
assert.equal(await text('.stage-head h2'), 'Q10音読')
const first = await text('.ten li.now')
await shot('2-read10')

await page.clock.runFor(6_200)
assert.notEqual(await text('.ten li.now'), first, '6秒でハイライトが進んでいない')

// --- 工程3: 3問回答 (45秒 x 3) ---
await page.clock.runFor(54_000)
assert.equal(await text('.stage-head h2'), '3問回答 1/3', '工程3へ進んでいない')
assert.equal(await page.locator('button:has-text("一時停止")').count(), 0, '一時停止ボタンが存在する')
await shot('3-answer')

const seen = [await text('.big-question')]
for (const round of [2, 3]) {
  await page.clock.runFor(45_000)
  assert.equal(await text('.stage-head h2'), `3問回答 ${round}/3`)
  seen.push(await text('.big-question'))
}
assert.equal(new Set(seen).size, 3, '同じ質問が繰り返されている')

// --- 工程4: 1問添削 (120秒) ---
await page.clock.runFor(45_000)
assert.equal(await text('.stage-head h2'), '1問添削')
assert.equal(await page.locator('.pick-item').count(), 3, '選択肢が3問ではない')
const picked = await page.locator('.pick-item').nth(1).innerText()
assert.ok(seen.includes(picked), '回答していない質問が候補に出ている')
await shot('4-pick')

await page.locator('.pick-item').nth(1).click()
await page.locator('textarea').waitFor()
assert.ok(await page.locator('.primary').isDisabled(), '空のまま先へ進めてしまう')
await page.locator('textarea').fill('I usually start the day by checking my messages. It takes about ten minutes.')
await shot('5-write')

// --- 工程5: 3回音読 (60秒) ---
await page.locator('.primary').click()
assert.equal(await text('.stage-head h2'), '3回音読')
assert.match(await text('.reps'), /1 \/ 3/)
await shot('6-shadow')
await page.clock.runFor(21_000)
assert.match(await text('.reps'), /2 \/ 3/, '20秒で2回目に進んでいない')

// --- 完了 ---
await page.clock.runFor(40_000)
await page.locator('.done').waitFor()
assert.equal(await page.locator('.done .dot.on').count(), 5, '5工程すべてが点灯していない')
await shot('7-done')

// --- 記録が残っているか（リロードしても） ---
await page.locator('.done .primary').click()
await page.reload()
await page.locator('.log li').first().waitFor()
assert.equal(await page.locator('.log li').first().locator('.dot.on').count(), 5, '記録が残っていない')
assert.match(await page.locator('.log li').first().innerText(), /完了/)
await shot('8-record')

// --- 途中で終了しても、そこまでが残るか ---
await page.evaluate(() => indexedDB.deleteDatabase('keyval-store'))
await page.reload()
await page.getByRole('button', { name: /開始/ }).click()
await page.clock.runFor(60_500)
assert.equal(await text('.stage-head h2'), '3問回答 1/3')
await page.getByRole('button', { name: '終了' }).click()
await page.locator('.log li').first().waitFor()
assert.equal(await page.locator('.log li').first().locator('.dot.on').count(), 3, '中断時の到達工程が違う')
assert.match(await page.locator('.log li').first().innerText(), /3問回答まで/)

await browser.close()
server.close()
console.log('smoke: all assertions passed')

// dist を GitHub Pages と同じ /Q-A/ 配下で配り、iPhone 幅のページを1枚開く。
import { chromium } from 'playwright'
import { createServer } from 'node:http'
import { readFile } from 'node:fs/promises'
import { existsSync, readdirSync } from 'node:fs'
import { extname, join, normalize, resolve } from 'node:path'

const ROOT = 'dist'
const TYPES = {
  '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css',
  '.png': 'image/png', '.webmanifest': 'application/manifest+json',
}

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

export async function launch({ time, fakeAudio } = {}) {
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
  const base = `http://localhost:${server.address().port}/Q-A/`

  // 偽のマイクを挿す。実際の音を流し込めるので、測定の配線まで確かめられる。
  const args = fakeAudio
    ? [
        '--use-fake-device-for-media-stream',
        '--use-fake-ui-for-media-stream',
        `--use-file-for-fake-audio-capture=${resolve(fakeAudio)}`,
        '--autoplay-policy=no-user-gesture-required',
      ]
    : []
  const browser = await chromium.launch({ executablePath: findChromium(), args })
  const context = await browser.newContext({
    viewport: { width: 390, height: 844 },
    deviceScaleFactor: 2,
    permissions: fakeAudio ? ['microphone'] : [],
  })
  const page = await context.newPage()
  page.on('pageerror', (e) => {
    console.error('PAGE ERROR:', e.message)
    process.exitCode = 1
  })
  if (time) await page.clock.install({ time: new Date(time) })

  /**
   * カード形式のセッションを最後まで流す。
   * stopAfter を渡すとその枚数で「終了」する。
   * 既定では各カードを時間切れまで置くので、答え方が出て復習に積まれる。
   */
  /**
   * カードを流す。holdMs だけ測ってからストップを押す。
   * 30秒以上にすると、その質問は到達済みになって待ち行列から消える。
   */
  const runSession = async ({ cards = 12, stopAfter = null, holdMs = 31_000, revealFirst = false } = {}) => {
    await page.getByRole('button', { name: /開始/ }).click()
    await page.locator('.card-body').waitFor()
    if (revealFirst) await page.getByRole('button', { name: '答え方を表示' }).click()
    for (let i = 1; i <= cards; i++) {
      if (stopAfter !== null && i > stopAfter) {
        await page.getByRole('button', { name: '終了' }).click()
        return
      }
      await page.clock.runFor(holdMs)
      await page.getByRole('button', { name: 'ストップ' }).click()
      if (await page.getByRole('button', { name: '次へ' }).count()) {
        await page.getByRole('button', { name: '次へ' }).click()
      }
      if (await page.getByRole('button', { name: /開始/ }).count()) return
    }
    await page.getByRole('button', { name: /開始/ }).waitFor()
  }

  return {
    page,
    base,
    runSession,
    text: (sel) => page.locator(sel).innerText(),
    shot: (name) => page.screenshot({ path: `${process.env.SHOTS ?? 'test/shots'}/${name}.png` }),
    close: async () => {
      await browser.close()
      server.close()
    },
  }
}

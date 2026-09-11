// dist を GitHub Pages と同じ /Q-A/ 配下で配り、iPhone 幅のページを1枚開く。
import { chromium } from 'playwright'
import { createServer } from 'node:http'
import { readFile } from 'node:fs/promises'
import { existsSync, readdirSync } from 'node:fs'
import { extname, join, normalize } from 'node:path'

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

export async function launch({ time } = {}) {
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

  const browser = await chromium.launch({ executablePath: findChromium() })
  const page = await browser.newPage({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2 })
  page.on('pageerror', (e) => {
    console.error('PAGE ERROR:', e.message)
    process.exitCode = 1
  })
  if (time) await page.clock.install({ time: new Date(time) })

  return {
    page,
    base,
    text: (sel) => page.locator(sel).innerText(),
    shot: (name) => page.screenshot({ path: `${process.env.SHOTS ?? 'test/shots'}/${name}.png` }),
    close: async () => {
      await browser.close()
      server.close()
    },
  }
}

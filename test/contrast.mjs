import { readFileSync } from 'node:fs'
const css = readFileSync('src/styles.css', 'utf8')
const vars = Object.fromEntries([...css.matchAll(/--([\w-]+):\s*(#[0-9a-f]{6})/gi)].map(m => [m[1], m[2]]))

const lin = (c) => { c /= 255; return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4 }
const lum = (hex) => {
  const [r, g, b] = [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16))
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b)
}
const ratio = (a, b) => {
  const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p)
  return (x + 0.05) / (y + 0.05)
}

// 用途ごとの最低基準: 小さい文字 4.5、大きい文字・図形 3.0
const checks = [
  ['本文 text / bg',            vars.text,      vars.bg,     4.5],
  ['補助文字 dim / bg',          vars.dim,       vars.bg,     4.5],
  ['補助文字 dim / surface',     vars.dim,       vars.surface, 4.5],
  ['本文 text / surface',        vars.text,      vars.surface, 4.5],
  ['ヒント accent-ink / bg',     vars['accent-ink'], vars.bg, 4.5],
  ['ストリーク ok / bg',         vars.ok,        vars.bg,     4.5],
  ['ボタン文字 on-accent/accent', vars['on-accent'], vars.accent, 4.5],
  ['リング・バー accent / bg',   vars.accent,    vars.bg,     3.0],
  ['枠線 line / bg',             vars.line,      vars.bg,     1.2],
]

let bad = 0
for (const [name, fg, bg, min] of checks) {
  const r = ratio(fg, bg)
  const ok = r >= min
  if (!ok) bad++
  console.log(`${ok ? 'OK  ' : 'FAIL'} ${r.toFixed(2).padStart(5)} (>=${min})  ${name}  ${fg} on ${bg}`)
}
process.exit(bad ? 1 : 0)

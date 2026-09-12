// 読み上げ。端末ごとの癖をこのファイルに閉じ込める。
//
// iOS Safari の Web Speech API には二つの罠がある:
//   1. 声の一覧が最初は空で、あとから voiceschanged で届く
//   2. 最初の発話は利用者の操作の中で起こさないと、以後ずっと黙る
// どちらも「鳴らない」という同じ症状になるので、原因を切り分けられるようにしておく。

let voices: SpeechSynthesisVoice[] = []
let unlocked = false

function synth(): SpeechSynthesis | null {
  return typeof window !== 'undefined' && 'speechSynthesis' in window ? window.speechSynthesis : null
}

export function supported(): boolean {
  return synth() !== null
}

function refreshVoices(): void {
  const s = synth()
  if (s) voices = s.getVoices()
}

if (synth()) {
  refreshVoices()
  synth()?.addEventListener('voiceschanged', refreshVoices)
}

/** 英語の声を選ぶ。無ければ既定の声に任せる（黙るよりはまし）。 */
function englishVoice(): SpeechSynthesisVoice | null {
  if (voices.length === 0) refreshVoices()
  return (
    voices.find((v) => v.lang === 'en-US' && v.localService) ??
    voices.find((v) => v.lang.startsWith('en') && v.localService) ??
    voices.find((v) => v.lang.startsWith('en')) ??
    null
  )
}

/**
 * 最初のタップの中で一度だけ呼ぶ。無音を1回喋らせて、以後の発話を許可させる。
 * 開始ボタンから呼ぶこと。
 */
export function unlockSpeech(): void {
  const s = synth()
  if (!s || unlocked) return
  unlocked = true
  refreshVoices()
  try {
    const warm = new SpeechSynthesisUtterance('')
    warm.volume = 0
    s.speak(warm)
  } catch {
    // 対応していない端末。読み上げ無しで練習は成立する。
  }
}

export interface SpeakOptions {
  /** 小声モードの日は読み上げない。 */
  quiet: boolean
  /** 設定で切ってあるときは何もしない。 */
  enabled: boolean
  rate?: number
}

/** 英文を読み上げる。前の発話は必ず止める（重なると聞き取れない）。 */
export function speak(text: string, { quiet, enabled, rate = 0.9 }: SpeakOptions): void {
  const s = synth()
  if (!s || !enabled || quiet || text.trim().length === 0) return
  try {
    s.cancel()
    const utterance = new SpeechSynthesisUtterance(text)
    const voice = englishVoice()
    if (voice) utterance.voice = voice
    utterance.lang = voice?.lang ?? 'en-US'
    // 手本を真似して言うための読み上げなので、やや遅くする。
    utterance.rate = rate
    s.speak(utterance)
  } catch {
    // 読み上げが落ちても練習は続ける。
  }
}

export function stopSpeaking(): void {
  try {
    synth()?.cancel()
  } catch {
    // 何もしない
  }
}

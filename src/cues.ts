// 工程の切り替えを音とバイブで伝える。喋っている間、画面は見ない。

let ctx: AudioContext | null = null

/** iOS は最初のタップの中でしか音を鳴らせるようにならない。開始ボタンから呼ぶ。 */
export function unlockAudio(): void {
  if (ctx) {
    void ctx.resume()
    return
  }
  const Ctor = window.AudioContext ?? (window as any).webkitAudioContext
  if (!Ctor) return
  ctx = new Ctor()
  const source = ctx.createBufferSource()
  source.buffer = ctx.createBuffer(1, 1, 22050)
  source.connect(ctx.destination)
  source.start(0)
}

function tone(freq: number, ms: number, delay = 0, gain = 0.18): void {
  if (!ctx || ctx.state !== 'running') return
  const start = ctx.currentTime + delay / 1000
  const osc = ctx.createOscillator()
  const amp = ctx.createGain()
  osc.type = 'sine'
  osc.frequency.value = freq
  // 立ち上がり・立ち下がりを丸めないと耳障りなクリック音が出る。
  amp.gain.setValueAtTime(0, start)
  amp.gain.linearRampToValueAtTime(gain, start + 0.012)
  amp.gain.exponentialRampToValueAtTime(0.0001, start + ms / 1000)
  osc.connect(amp).connect(ctx.destination)
  osc.start(start)
  osc.stop(start + ms / 1000 + 0.05)
}

function buzz(pattern: number | number[]): void {
  navigator.vibrate?.(pattern)
}

export interface CueOptions {
  /** 小声モード。周囲に人がいる日は音を消し、振動だけにする。 */
  quiet: boolean
}

/** 次の工程へ。 */
export function cueStage({ quiet }: CueOptions): void {
  if (!quiet) {
    tone(660, 140)
    tone(880, 180, 150)
  }
  buzz([60, 80, 60])
}

/** 工程3で次の質問へ。 */
export function cueNext({ quiet }: CueOptions): void {
  if (!quiet) tone(760, 120)
  buzz(50)
}

/** 工程5の音読1回ぶん。 */
export function cueRep({ quiet }: CueOptions): void {
  if (!quiet) tone(1040, 110)
  buzz(40)
}

/** セッション終了。 */
export function cueDone({ quiet }: CueOptions): void {
  if (!quiet) {
    tone(660, 160)
    tone(880, 160, 170)
    tone(1320, 320, 340)
  }
  buzz([80, 60, 80, 60, 160])
}

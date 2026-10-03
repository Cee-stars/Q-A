// 発話の立ち上がりを測る。
//
// 測るのは「英語が出た時刻」ではなく「口が動き始めた時刻」。
// 「あー」も声として数える。黙っている時間を減らすのが目的なので、それでよい。
//
// 判定の中身（しきい値・保持・ガード）は OnsetDetector に閉じ込めてある。
// マイクが要らないので、ここだけは実際の音を使わずに検証できる。

export interface OnsetOptions {
  /** 無音時の基準値。セッション開始時に測っておく。 */
  noiseFloor: number
  /** 基準値の何倍を超えたら声とみなすか。 */
  factor?: number
  /** 絶対的な下限。静かすぎる部屋で基準値が 0 に張り付くのを防ぐ。 */
  minLevel?: number
  /** これだけ続けて超えたら確定。机を叩く音のような単発では反応しない。 */
  holdMs?: number
  /** 開始直後のこの時間は無視する。読み上げの残響を自分の声と数えないため。 */
  guardMs?: number
}

const DEFAULTS = { factor: 3, minLevel: 0.012, holdMs: 60, guardMs: 120 }

export class OnsetDetector {
  private readonly threshold: number
  private readonly holdMs: number
  private readonly guardMs: number
  private runStart: number | null = null
  private onset: number | null = null

  constructor(options: OnsetOptions) {
    const { factor, minLevel, holdMs, guardMs } = { ...DEFAULTS, ...options }
    this.threshold = Math.max(options.noiseFloor * factor, minLevel)
    this.holdMs = holdMs
    this.guardMs = guardMs
  }

  /**
   * 音量を1つ食わせる。立ち上がりが確定したらその時刻を返す。
   * **返すのは確定した時刻ではなく、超え始めた時刻。** 確定までの保持時間ぶん
   * 遅く報告すると、測っている値そのものが保持時間だけ水増しされる。
   */
  feed(tMs: number, level: number): number | null {
    if (this.onset !== null) return this.onset
    if (tMs < this.guardMs) return null

    if (level > this.threshold) {
      if (this.runStart === null) this.runStart = tMs
      if (tMs - this.runStart >= this.holdMs) {
        this.onset = this.runStart
        return this.onset
      }
    } else {
      this.runStart = null
    }
    return null
  }

  get detected(): number | null {
    return this.onset
  }
}

/** 中央値。外れ値1回で目標が動かないよう、平均ではなく中央値を使う。 */
export function median(values: number[]): number | null {
  if (values.length === 0) return null
  const sorted = [...values].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid]
}

/* ---------- マイク ---------- */

export interface Mic {
  /** いまの音量（0〜1 くらい）。 */
  level(): number
  close(): void
}

export class MicError extends Error {}

/**
 * マイクを開く。
 * エコー除去を入れているのは、読み上げた質問を自分の声として拾わないため。
 * 自動ゲインは切る。音量が勝手に動くと、しきい値が意味を失う。
 */
export async function openMic(): Promise<Mic> {
  if (!navigator.mediaDevices?.getUserMedia) {
    throw new MicError('この端末ではマイクを使えません')
  }

  let stream: MediaStream
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: false },
    })
  } catch {
    throw new MicError('マイクの使用が許可されていません')
  }

  const Ctor = window.AudioContext ?? (window as any).webkitAudioContext
  const ctx: AudioContext = new Ctor()
  await ctx.resume()
  const source = ctx.createMediaStreamSource(stream)
  const analyser = ctx.createAnalyser()
  analyser.fftSize = 1024
  source.connect(analyser)
  const buffer = new Float32Array(analyser.fftSize)

  return {
    level() {
      analyser.getFloatTimeDomainData(buffer)
      let sum = 0
      for (const sample of buffer) sum += sample * sample
      return Math.sqrt(sum / buffer.length)
    },
    close() {
      try {
        source.disconnect()
        stream.getTracks().forEach((track) => track.stop())
        void ctx.close()
      } catch {
        // 閉じられなくても実害は無い
      }
    },
  }
}

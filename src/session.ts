// 1回のセッションの仕様。docs/PLAN.md の表がそのままここにある。
// 合計 375 秒 = 6分15秒。この数字を動かすときは計画書も直すこと。

export type Phase =
  | 'idle'
  | 'read10'
  | 'answer'
  | 'correct'
  | 'shadow'
  | 'done'

/** 記録に残る5工程。チェックリストのドットはこの順に対応する。 */
export const STAGES = [
  { id: 'prepare', label: '生成' },
  { id: 'read10', label: 'Q10音読' },
  { id: 'answer', label: '3問回答' },
  { id: 'correct', label: '1問添削' },
  { id: 'shadow', label: '3回音読' },
] as const

export const READ10_MS = 60_000
export const ANSWER_MS = 45_000
export const ANSWER_ROUNDS = 3
export const CORRECT_MS = 120_000
export const SHADOW_MS = 60_000
export const SHADOW_REPS = 3

/** 工程2で1問にかける時間。10問を60秒 = 6秒。「考えず口だけ動かす」速度。 */
export const READ10_PER_QUESTION_MS = READ10_MS / 10

export const TOTAL_MS =
  READ10_MS + ANSWER_MS * ANSWER_ROUNDS + CORRECT_MS + SHADOW_MS

/** 到達工程の番号（1..5）。記録のドットの数になる。 */
export function reachedFor(phase: Phase): number {
  switch (phase) {
    case 'idle':
      return 0
    case 'read10':
      return 2
    case 'answer':
      return 3
    case 'correct':
      return 4
    case 'shadow':
    case 'done':
      return 5
  }
}

export function formatClock(ms: number): string {
  const total = Math.max(0, Math.ceil(ms / 1000))
  const m = Math.floor(total / 60)
  const s = total % 60
  return `${m}:${String(s).padStart(2, '0')}`
}

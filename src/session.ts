// 1回のセッションの仕様。docs/PLAN.md の「なぜこの形なのか」と対で読むこと。
//
// 設計の根拠（詳細は計画書）:
//   工程2 分散検索  … 集中反復は直後だけ強く、すぐ忘れる。日をまたいで「思い出す」
//   工程3 4/3/2    … 流暢さは *同じ内容* を時間を縮めて繰り返すことで伸びる
//   工程4 即時明示  … 産出直後の明示的フィードバックが最も効く
//   工程5 暗唱を挟む … 読み返しは再学習。検索を1回入れる
//
// 合計 365 秒 = 6分5秒。

export type Phase = 'idle' | 'review' | 'answer' | 'correct' | 'settle' | 'done'

/** 記録に残る5工程。チェックリストのドットはこの順に対応する。 */
export const STAGES = [
  { id: 'prepare', label: '準備' },
  { id: 'review', label: '復習' },
  { id: 'answer', label: '3回回答' },
  { id: 'correct', label: '添削' },
  { id: 'settle', label: '定着' },
] as const

/** 工程2: 過去の添削文を思い出す。1枚20秒 × 4枚。 */
export const REVIEW_SLOTS = 4
export const REVIEW_CARD_MS = 20_000
export const REVIEW_MS = REVIEW_SLOTS * REVIEW_CARD_MS
/** 1枚のうち、質問だけ見て思い出す時間。残りは答えを見て読む時間。 */
export const REVIEW_RECALL_MS = 12_000
/** 復習カードが足りない日は、残り時間を質問の音読で埋める。1問6秒。 */
export const WARMUP_PER_QUESTION_MS = 6_000

/** 工程3: 同じ1問を、時間を縮めて3回。4/3/2 の比率。 */
export const ANSWER_ROUNDS_MS = [45_000, 35_000, 25_000]
export const ANSWER_MS = ANSWER_ROUNDS_MS.reduce((a, b) => a + b, 0)

/** 工程4: 3回目の答えを書き直して添削へ。 */
export const CORRECT_MS = 120_000

/** 工程5: 読む → 隠して暗唱 → 読む。真ん中が検索練習。 */
export const SETTLE_STEPS = [
  { kind: 'read', label: '声に出して読む' },
  { kind: 'recall', label: '見ずに言う' },
  { kind: 'read', label: 'もう一度読む' },
] as const
export const SETTLE_STEP_MS = 20_000
export const SETTLE_MS = SETTLE_STEPS.length * SETTLE_STEP_MS

export const TOTAL_MS = REVIEW_MS + ANSWER_MS + CORRECT_MS + SETTLE_MS

/** 到達工程の番号（1..5）。記録のドットの数になる。 */
export function reachedFor(phase: Phase): number {
  switch (phase) {
    case 'idle':
      return 0
    case 'review':
      return 2
    case 'answer':
      return 3
    case 'correct':
      return 4
    case 'settle':
    case 'done':
      return 5
  }
}

export function formatClock(ms: number): string {
  const total = Math.max(0, Math.ceil(ms / 1000))
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`
}

// 1回のセッションの仕様。docs/PLAN.md の「なぜこの形なのか」と対で読むこと。
//
// 設計の根拠（詳細は計画書）:
//   工程2 分散検索  … 集中反復は直後だけ強く、すぐ忘れる。日をまたいで「思い出す」
//   工程3 挑戦      … 事前テスト効果。10〜20秒の失敗試行で気づきは起きる。
//                      45秒は効果を増やさず士気だけ削るので 20 秒にした
//   工程4 手本      … 言い方を受け取る。ここが無いと、言えない人は沈黙で終わる
//   工程5 言い直し  … 足場を段階的に外して3回（worked-example fading）
//
// **45/35/25 を 4/3/2 の根拠で正当化しない。** 4/3/2 は「内容の検索が1回目で
// 済んでいること」が効果の源泉で、手本を挟んだ時点で回1と回2以降は別の内容になる。
// 本物の 4/3/2 が起きるのは工程2（復習）のほう —— 自分の文が既知になった翌日以降。
//
// 合計 240 秒 = 4分。

export type Phase = 'idle' | 'review' | 'attempt' | 'model' | 'respeak' | 'done'

/** 記録に残る5工程。チェックリストのドットはこの順に対応する。 */
export const STAGES = [
  { id: 'prepare', label: '準備' },
  { id: 'review', label: '復習' },
  { id: 'attempt', label: '挑戦' },
  { id: 'model', label: '手本' },
  { id: 'respeak', label: '言い直し' },
] as const

/** 工程2: 過去の添削文を思い出す。1枚20秒 × 4枚。 */
export const REVIEW_SLOTS = 4
export const REVIEW_CARD_MS = 20_000
export const REVIEW_MS = REVIEW_SLOTS * REVIEW_CARD_MS
/** 1枚のうち、質問だけ見て思い出す時間。残りは答えを見て読む時間。 */
export const REVIEW_RECALL_MS = 12_000
/** 復習カードが足りない日は、残り時間を質問の音読で埋める。1問6秒。 */
export const WARMUP_PER_QUESTION_MS = 6_000

/** 工程3: まず自力で20秒。言えなくてよい。日本語で言ってもよい。 */
export const ATTEMPT_MS = 20_000

/** 工程4: 手本を受け取る。読み上げも走るので、画面を見続けなくてよい。 */
export const MODEL_MS = 60_000

/**
 * 工程5: 同じ質問に、時間を縮めて3回。足場は急に外さず段階的に減らす。
 *   1回目 全表示 → 2回目 最初の3語だけ → 3回目 非表示
 */
export const RESPEAK_ROUNDS_MS = [35_000, 25_000, 20_000]
export const RESPEAK_MS = RESPEAK_ROUNDS_MS.reduce((a, b) => a + b, 0)

export type Scaffold = 'full' | 'partial' | 'none'
export const RESPEAK_SCAFFOLD: Scaffold[] = ['full', 'partial', 'none']
/** 部分表示で見せる語数。続きは自分で出す。 */
export const PARTIAL_WORDS = 3

export const TOTAL_MS = REVIEW_MS + ATTEMPT_MS + MODEL_MS + RESPEAK_MS

/** 到達工程の番号（1..5）。記録のドットの数になる。 */
export function reachedFor(phase: Phase): number {
  switch (phase) {
    case 'idle':
      return 0
    case 'review':
      return 2
    case 'attempt':
      return 3
    case 'model':
      return 4
    case 'respeak':
    case 'done':
      return 5
  }
}

export function formatClock(ms: number): string {
  const total = Math.max(0, Math.ceil(ms / 1000))
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`
}

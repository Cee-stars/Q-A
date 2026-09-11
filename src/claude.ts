// Claude API をブラウザから直接呼ぶ。利用者は本人1人なので、サーバーを立てない。
// キーは端末内にしか無く、リポジトリにも配信物にも含まれない。
// 誰かに配る段になったら、ここを薄いプロキシ越しに差し替える。
//
// SDK は動的 import にしてある。起動の速さが体験そのものなので、
// 初回描画のバンドルに API クライアントを含めない。

import type { Level, Question } from './questions'
import { DEFAULT_CORRECTION_PROMPT, DEFAULT_GENERATION_PROMPT, render } from './prompts'
import type { Settings } from './storage'

const MODEL = 'claude-opus-5'

export interface Correction {
  corrected: string
  fixes: { was: string; now: string; why: string }[]
}

async function client(apiKey: string) {
  const [{ default: Anthropic }, { z }, { zodOutputFormat }] = await Promise.all([
    import('@anthropic-ai/sdk'),
    import('zod'),
    import('@anthropic-ai/sdk/helpers/zod'),
  ])
  return {
    // 個人利用のブラウザアプリなので、ブラウザからの直接呼び出しを明示的に許可する。
    anthropic: new Anthropic({ apiKey, dangerouslyAllowBrowser: true }),
    z,
    zodOutputFormat,
  }
}

/**
 * 翌日ぶんの10問を生成する。セッションの終わりに走らせて先読みしておく。
 * 開いた瞬間に問題がある状態にするのが目的で、失敗しても種問題バンクで練習は成立する。
 */
export async function generateQuestions(
  settings: Settings,
  exclude: string[],
): Promise<Question[]> {
  const { anthropic, z, zodOutputFormat } = await client(settings.apiKey)

  const schema = z.object({
    questions: z
      .array(
        z.object({
          text: z.string(),
          level: z.enum(['easy', 'mid', 'hard']),
        }),
      )
      .length(10),
  })

  const response = await anthropic.messages.parse({
    model: MODEL,
    max_tokens: 2000,
    // 機械的な作業なので深く考えさせない。生成は待ち時間に直結しないが、安くはしておく。
    output_config: { effort: 'low', format: zodOutputFormat(schema) },
    messages: [
      {
        role: 'user',
        content: render(settings.generationPrompt || DEFAULT_GENERATION_PROMPT, {
          level: settings.level,
          goal: settings.goal,
          themes: settings.themes,
          exclude: exclude.length > 0 ? exclude.map((q) => `- ${q}`).join('\n') : '- (なし)',
        }),
      },
    ],
  })

  const parsed = response.parsed_output
  if (!parsed) throw new Error('生成結果を読み取れませんでした')

  return parsed.questions.map((q, i) => ({
    id: `g${i + 1}`,
    text: q.text,
    level: q.level as Level,
  }))
}

/** 工程4の添削。3回目の答えを、話し言葉として自然な英語に直す。 */
export async function correct(
  settings: Settings,
  question: string,
  answer: string,
): Promise<Correction> {
  const { anthropic, z, zodOutputFormat } = await client(settings.apiKey)

  const schema = z.object({
    corrected: z.string(),
    fixes: z
      .array(z.object({ was: z.string(), now: z.string(), why: z.string() }))
      .max(3),
  })

  const response = await anthropic.messages.parse({
    model: MODEL,
    // 直した文は2〜4文。上限は文面だけでなく物理でもかけておく。
    max_tokens: 1000,
    output_config: { effort: 'medium', format: zodOutputFormat(schema) },
    messages: [
      {
        role: 'user',
        content: render(settings.correctionPrompt || DEFAULT_CORRECTION_PROMPT, {
          question,
          answer,
        }),
      },
    ],
  })

  const parsed = response.parsed_output
  if (!parsed) throw new Error('添削結果を読み取れませんでした')
  return parsed
}

/** 失敗の理由を、練習中に読める長さの日本語にする。 */
export function describeError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error)
  if (/401|authentication/i.test(message)) return 'APIキーが正しくありません'
  if (/429|rate.?limit/i.test(message)) return '回数制限です。少し待ってから'
  if (/fetch|network|Failed to fetch/i.test(message)) return 'ネットにつながっていません'
  return message.slice(0, 80)
}

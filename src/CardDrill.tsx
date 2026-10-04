import { useCallback, useEffect, useRef, useState } from 'preact/hooks'
import type { Card } from './cards'
import { formatDuration, TARGET_MS } from './endurance'
import { speak, stopSpeaking, supported as speechSupported } from './speech'
import { cueNext } from './cues'

/**
 * カード1枚。
 *   質問が出た瞬間から測りはじめ、**ストップを押すまで止めない**。
 *   30秒は目標であって打ち切りではない。超えたぶんもそのまま記録する。
 */
export function CardDrill({
  card,
  position,
  total,
  best,
  quiet,
  speakEnabled,
  onDone,
  onStop,
}: {
  card: Card
  position: number
  total: number
  /** この質問のこれまでの最長。無ければ 0。 */
  best: number
  quiet: boolean
  speakEnabled: boolean
  /** ストップを押した時点の長さと、答え方を見たかどうか。 */
  onDone: (card: Card, durationMs: number, usedHelp: boolean) => void
  onStop: () => void
}) {
  const [showJa, setShowJa] = useState(false)
  const [showAnswer, setShowAnswer] = useState(false)
  const [elapsed, setElapsed] = useState(0)
  const [stopped, setStopped] = useState<number | null>(null)
  const startedAt = useRef(Date.now())
  const sawAnswer = useRef(false)
  const reachedCue = useRef(false)

  const voice = { quiet, enabled: speakEnabled }

  // カードが変わったら、伏せ直して測り直す。
  useEffect(() => {
    setShowJa(false)
    setShowAnswer(false)
    setElapsed(0)
    setStopped(null)
    startedAt.current = Date.now()
    sawAnswer.current = false
    reachedCue.current = false
    speak(card.question, voice)
    return () => stopSpeaking()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [card.key, position])

  useEffect(() => {
    if (stopped !== null) return
    const id = window.setInterval(() => {
      const now = Date.now() - startedAt.current
      setElapsed(now)
      // 30秒に届いた瞬間だけ知らせる。画面を見ていなくても分かるように。
      if (!reachedCue.current && now >= TARGET_MS) {
        reachedCue.current = true
        cueNext({ quiet })
      }
    }, 100)
    return () => window.clearInterval(id)
  }, [quiet, stopped, card.key, position])

  const stopTimer = useCallback(() => {
    const ms = Date.now() - startedAt.current
    setStopped(ms)
    setElapsed(ms)
    stopSpeaking()
  }, [])

  const next = useCallback(() => {
    onDone(card, stopped ?? Date.now() - startedAt.current, sawAnswer.current)
  }, [card, onDone, stopped])

  const shown = stopped ?? elapsed
  const reached = shown >= TARGET_MS
  const isReview = card.kind === 'review'

  return (
    <div class="stage card-drill">
      <header class="stage-head">
        <div
          class="bar"
          style={{ transform: `scaleX(${Math.min(1, shown / TARGET_MS)})` }}
        />
        <div class="stage-head-row">
          <div>
            <h2>
              {position} / {total}
            </h2>
            <p class="hint">
              {isReview ? `${card.since} の持ち帰り` : best > 0 ? `これまで ${formatDuration(best)}` : 'はじめて'}
            </p>
          </div>
          <button class="stop" onClick={onStop}>
            終了
          </button>
        </div>
      </header>

      <div class="timer-row">
        <strong class={reached ? 'timer reached' : 'timer'}>{formatDuration(shown)}</strong>
        <span class="timer-target">目標 {formatDuration(TARGET_MS)}</span>
      </div>

      <div class="card-body">
        <p class="big-question">{card.question}</p>

        {showJa ? (
          <p class="big-question-ja">{card.ja || '（日本語なし）'}</p>
        ) : (
          <button class="reveal" onClick={() => setShowJa(true)}>
            意味を表示
          </button>
        )}

        {showAnswer ? (
          <div class="answer-box">
            <p class="answer-label">{isReview ? '前回の自分の答え' : '答え方'}</p>
            <p class="answer-text">{card.answer}</p>
            {speechSupported() && (
              <button class="ghost small" onClick={() => speak(card.answer, voice)}>
                聞く
              </button>
            )}
          </div>
        ) : (
          <button
            class="reveal"
            onClick={() => {
              sawAnswer.current = true
              setShowAnswer(true)
            }}
          >
            答え方を表示
          </button>
        )}
      </div>

      {stopped === null ? (
        <button class="primary big" onClick={stopTimer}>
          ストップ
        </button>
      ) : (
        <div class="stopped">
          <p class={reached ? 'stopped-note reached' : 'stopped-note'}>
            {reached
              ? `30秒に到達。この質問はもう出ません`
              : `あと ${formatDuration(TARGET_MS - stopped)}`}
          </p>
          <button class="primary" onClick={next}>
            次へ
          </button>
        </div>
      )}
    </div>
  )
}

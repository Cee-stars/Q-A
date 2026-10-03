import { useCallback, useEffect, useRef, useState } from 'preact/hooks'
import type { Card } from './cards'
import { speak, stopSpeaking, supported as speechSupported } from './speech'
import { cueDone, cueNext } from './cues'

/**
 * カード形式のドリル。
 *   質問を見る → 答える → 詰まったら意味と答え方を出す
 *
 * **「答え方」は答える時間が終わるまで伏せておく。**
 * いつでも押せると、押して読むだけになり、産出の練習でなく音読になる。
 * 時間切れで自動的に出るので、詰まったまま放置されることはない。
 */
export function CardDrill({
  cards,
  windowMs,
  quiet,
  speakEnabled,
  onCardDone,
  onFinish,
  onStop,
}: {
  cards: Card[]
  windowMs: number
  quiet: boolean
  speakEnabled: boolean
  /**
   * 1枚終えるたびに呼ぶ。usedHelp は「答え方を見たか」。
   * 自力で言えたかどうかの唯一の手がかりなので、復習の間隔はここで決まる。
   */
  onCardDone: (card: Card, usedHelp: boolean, done: number) => void
  onFinish: () => void
  onStop: (done: number) => void
}) {
  const [index, setIndex] = useState(0)
  const [showJa, setShowJa] = useState(false)
  const [showAnswer, setShowAnswer] = useState(false)
  const [remaining, setRemaining] = useState(windowMs)
  const startedAt = useRef(Date.now())
  /** 時間切れで出たぶんも「見た」に数える。自力で言えたかが知りたいので。 */
  const sawAnswer = useRef(false)

  const card = cards[index]
  const voice = { quiet, enabled: speakEnabled }

  /**
   * 伏せ直しは、次へ進めるのと同じ更新でやる。
   * 効果の中でやると、新しいカードを一度描いたあとで伏せ直すことになり、
   * 前のカードの答えが一瞬だけ見える。
   */
  const reset = useCallback(() => {
    setShowJa(false)
    setShowAnswer(false)
    setRemaining(windowMs)
    startedAt.current = Date.now()
    sawAnswer.current = false
  }, [windowMs])

  // 読み上げだけは描いたあとで。
  useEffect(() => {
    if (card) speak(card.question, voice)
    return () => stopSpeaking()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [index])

  // 答える時間。尽きたら答え方をひとりでに出す。詰まったまま終わらせない。
  useEffect(() => {
    const id = window.setInterval(() => {
      const left = Math.max(0, windowMs - (Date.now() - startedAt.current))
      setRemaining(left)
      if (left === 0) {
        setShowAnswer((was) => {
          if (!was) cueNext({ quiet })
          return true
        })
        sawAnswer.current = true
      }
    }, 100)
    return () => window.clearInterval(id)
  }, [index, quiet, windowMs])

  const next = useCallback(() => {
    const done = index + 1
    onCardDone(card, sawAnswer.current, done)
    if (done >= cards.length) {
      cueDone({ quiet })
      onFinish()
    } else {
      reset()
      setIndex(done)
    }
  }, [card, cards.length, index, onCardDone, onFinish, quiet, reset])

  if (!card) return null

  const expired = remaining === 0
  const seconds = Math.ceil(remaining / 1000)

  return (
    <div class="stage card-drill">
      <header class="stage-head">
        <div
          class="bar"
          style={{ transform: `scaleX(${Math.min(1, Math.max(0, remaining / windowMs))})` }}
        />
        <div class="stage-head-row">
          <div>
            <h2>
              {index + 1} / {cards.length}
            </h2>
            <p class="hint">
              {card.kind === 'review' ? `${card.since} の持ち帰り` : expired ? '答え方を見る' : '声に出して答える'}
            </p>
          </div>
          <div class="stage-head-right">
            <span class={expired ? 'clock out' : 'clock'}>{expired ? '—' : seconds}</span>
            <button class="stop" onClick={() => onStop(index)}>
              終了
            </button>
          </div>
        </div>
      </header>

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
            <p class="answer-label">{card.kind === 'review' ? '前回の自分の答え' : '答え方'}</p>
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

      <button class="primary" onClick={next}>
        {index + 1 >= cards.length ? '終わる' : '次へ'}
      </button>
    </div>
  )
}

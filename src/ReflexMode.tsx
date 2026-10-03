import { useCallback, useEffect, useRef, useState } from 'preact/hooks'
import type { Question } from './questions'
import {
  CALIBRATE_MS,
  FEEDBACK_MS,
  FRAME,
  FRAME_JA,
  formatLatency,
  LISTEN_TIMEOUT_MS,
  missCount,
  REFLEX_QUESTIONS,
  sessionMedian,
  SUSPICIOUS_MS,
  type ReflexAttempt,
} from './reflex'
import { MicError, OnsetDetector, openMic, type Mic } from './vad'
import { speak, stopSpeaking } from './speech'
import { cueNext, cueRep } from './cues'
import type { Settings } from './storage'

type Phase = 'intro' | 'calibrating' | 'asking' | 'listening' | 'feedback' | 'done' | 'error'

/**
 * 反射モード。質問を聞いてから、声が出るまでの時間を測る。
 * **合否は出さない。** まず自分の現在値を知るための回。
 */
export function ReflexMode({
  questions,
  settings,
  onFinish,
  onClose,
}: {
  questions: Question[]
  settings: Settings
  onFinish: (attempts: ReflexAttempt[]) => void
  onClose: () => void
}) {
  const [phase, setPhase] = useState<Phase>('intro')
  const [index, setIndex] = useState(0)
  const [attempts, setAttempts] = useState<ReflexAttempt[]>([])
  const [error, setError] = useState<string | null>(null)
  const [last, setLast] = useState<ReflexAttempt | null>(null)

  const mic = useRef<Mic | null>(null)
  const noiseFloor = useRef(0)
  const timers = useRef<number[]>([])
  const raf = useRef(0)

  const list = questions.slice(0, REFLEX_QUESTIONS)
  const voice = { quiet: settings.quiet, enabled: settings.speak }

  const clearTimers = useCallback(() => {
    timers.current.forEach((id) => window.clearTimeout(id))
    timers.current = []
    if (raf.current) cancelAnimationFrame(raf.current)
    raf.current = 0
  }, [])

  const later = useCallback((fn: () => void, ms: number) => {
    timers.current.push(window.setTimeout(fn, ms))
  }, [])

  useEffect(
    () => () => {
      clearTimers()
      stopSpeaking()
      mic.current?.close()
    },
    [clearTimers],
  )

  /** 無音の基準を測る。ここを飛ばすと、部屋の騒音をそのまま声として数える。 */
  const calibrate = useCallback(async () => {
    setPhase('calibrating')
    try {
      mic.current = await openMic()
    } catch (e) {
      setError(e instanceof MicError ? e.message : 'マイクを開けませんでした')
      setPhase('error')
      return
    }
    const started = performance.now()
    let peak = 0
    const sample = () => {
      const level = mic.current?.level() ?? 0
      if (level > peak) peak = level
      if (performance.now() - started < CALIBRATE_MS) {
        raf.current = requestAnimationFrame(sample)
      } else {
        noiseFloor.current = peak
        setIndex(0)
        setPhase('asking')
      }
    }
    raf.current = requestAnimationFrame(sample)
  }, [])

  /** 1問ぶん。読み上げが終わった時刻を 0ms として、声が出るまでを測る。 */
  const runQuestion = useCallback(
    (i: number) => {
      const question = list[i]
      if (!question) return
      setPhase('asking')

      speak(question.text, {
        ...voice,
        onEnd: () => {
          setPhase('listening')
          cueNext({ quiet: settings.quiet })
          const detector = new OnsetDetector({ noiseFloor: noiseFloor.current })
          const started = performance.now()

          const finish = (latencyMs: number | null) => {
            clearTimers()
            const attempt: ReflexAttempt = {
              questionId: question.id,
              question: question.text,
              ja: question.ja,
              latencyMs,
              // 速すぎる値は、読み上げの残響を拾った疑いがある。集計から外す。
              suspicious: latencyMs !== null && latencyMs < SUSPICIOUS_MS,
            }
            setAttempts((current) => [...current, attempt])
            setLast(attempt)
            setPhase('feedback')
            cueRep({ quiet: settings.quiet })
            later(() => {
              if (i + 1 < list.length) {
                setIndex(i + 1)
                runQuestion(i + 1)
              } else {
                setPhase('done')
              }
            }, FEEDBACK_MS)
          }

          const poll = () => {
            const now = performance.now() - started
            const onset = detector.feed(now, mic.current?.level() ?? 0)
            if (onset !== null) {
              finish(Math.round(onset))
              return
            }
            if (now >= LISTEN_TIMEOUT_MS) {
              finish(null)
              return
            }
            raf.current = requestAnimationFrame(poll)
          }
          raf.current = requestAnimationFrame(poll)
        },
      })
    },
    [clearTimers, later, list, settings.quiet, voice],
  )

  useEffect(() => {
    if (phase === 'asking' && attempts.length === index) runQuestion(index)
    // 最初の1問だけここから始める。以降は runQuestion が自分で次を呼ぶ。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phase === 'asking' && index === 0])

  const stop = useCallback(() => {
    clearTimers()
    stopSpeaking()
    mic.current?.close()
    mic.current = null
    onClose()
  }, [clearTimers, onClose])

  /* ---------- 画面 ---------- */

  if (phase === 'intro') {
    return (
      <div class="reflex">
        <header class="idle-head">
          <div class="idle-title">
            <h1>反射</h1>
            <button class="stop" onClick={stop}>
              戻る
            </button>
          </div>
          <p class="sub">質問を聞いてから、声が出るまでの時間を測ります</p>
        </header>

        <div class="frame-card">
          <p class="frame-label">この型で答える</p>
          <p class="frame-text">{FRAME}</p>
          <p class="frame-ja">{FRAME_JA}</p>
        </div>

        <ul class="reflex-notes">
          <li>合否は出しません。まず自分が何秒かかっているかを知る回です。</li>
          <li>英語が出なければ「あー」でも構いません。測るのは黙っている時間です。</li>
          <li>始めに1秒、静かにしてください。部屋の音の大きさを測ります。</li>
        </ul>

        <button class="start" onClick={() => void calibrate()}>
          <span class="start-main">開始</span>
          <span class="start-sub">マイクの使用を許可してください</span>
        </button>
      </div>
    )
  }

  if (phase === 'error') {
    return (
      <div class="reflex">
        <header class="idle-head">
          <div class="idle-title">
            <h1>反射</h1>
            <button class="stop" onClick={stop}>
              戻る
            </button>
          </div>
        </header>
        <p class="error">{error}</p>
        <p class="note">
          マイクが使えないと時間を測れません。設定でこのページのマイクを許可してから、
          もう一度お試しください。
        </p>
      </div>
    )
  }

  if (phase === 'calibrating') {
    return (
      <div class="reflex center">
        <p class="big-hint">静かに…</p>
        <p class="note">部屋の音の大きさを測っています</p>
      </div>
    )
  }

  if (phase === 'done') {
    const ms = sessionMedian(attempts)
    const misses = missCount(attempts)
    return (
      <div class="reflex">
        <header class="idle-head">
          <div class="idle-title">
            <h1>おつかれさま</h1>
          </div>
        </header>

        <div class="frame-card">
          <p class="frame-label">今日の中央値</p>
          <p class="reflex-median">{formatLatency(ms)}</p>
          {misses > 0 && <p class="note">声が出なかった: {misses} 問</p>}
        </div>

        <ul class="reflex-list">
          {attempts.map((a, i) => (
            <li key={i}>
              <span>{a.question}</span>
              <b class={a.latencyMs === null ? 'miss' : ''}>{formatLatency(a.latencyMs)}</b>
            </li>
          ))}
        </ul>

        <button
          class="primary"
          onClick={() => {
            mic.current?.close()
            mic.current = null
            onFinish(attempts)
          }}
        >
          記録して閉じる
        </button>
      </div>
    )
  }

  const question = list[index]
  return (
    <div class="stage">
      <header class="stage-head">
        <div class="stage-head-row">
          <div>
            <h2>
              反射 {index + 1}/{list.length}
            </h2>
            <p class="hint">
              {phase === 'asking' ? '聞く' : phase === 'listening' ? 'すぐ言う' : '計測中'}
            </p>
          </div>
          <button class="stop" onClick={stop}>
            終了
          </button>
        </div>
      </header>

      <p class="big-question">{question?.text}</p>
      <p class="big-question-ja">{question?.ja}</p>

      {phase === 'feedback' && last ? (
        <div class="reflex-result">
          <strong class={last.latencyMs === null ? 'miss' : ''}>
            {formatLatency(last.latencyMs)}
          </strong>
          {last.suspicious && <span class="note">（速すぎ。残響の可能性）</span>}
        </div>
      ) : (
        <div class="reflex-result">
          <span class="frame-text">{FRAME}</span>
        </div>
      )}
    </div>
  )
}

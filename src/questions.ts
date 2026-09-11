// Phase 1 の種問題バンク。API なしで毎日の8分を開始するためのもの。
// Phase 2 で「前夜の先読み生成」に置き換わるが、オフライン時のフォールバックとして残る。
//
// 方針（計画書 5.1 と同じ制約）:
//   - 音読6秒に収まる長さ（15語以内）
//   - 抽象論ではなく、自分の経験を語らせる
//   - 1日の配分は easy 6 / mid 3 / hard 1。詰まる経験を1問だけ確実に混ぜる

export type Level = 'easy' | 'mid' | 'hard'

export interface Question {
  id: string
  text: string
  level: Level
}

export const DAILY_MIX: Record<Level, number> = { easy: 6, mid: 3, hard: 1 }
export const DAILY_COUNT = DAILY_MIX.easy + DAILY_MIX.mid + DAILY_MIX.hard

const EASY = [
  'What did you do first this morning?',
  'What did you eat for breakfast today?',
  'How did you get to work today?',
  'What is on your desk right now?',
  'Who did you talk to yesterday?',
  'What did you do last weekend?',
  'What is the weather like today?',
  'Which app do you open most often?',
  'What time did you wake up today?',
  'What did you watch or read last night?',
  'Where do you usually buy your coffee?',
  'What do you need to finish this week?',
  'How long is your commute?',
  'What did you have for dinner yesterday?',
  'What is your favourite place near your home?',
  'What do you do to relax after work?',
  'Who is the last person you called?',
  'What did you buy most recently?',
  'What music did you listen to today?',
  'How often do you cook at home?',
  'What is your plan for tomorrow?',
  'Which season do you like best, and why?',
  'What did you learn this week?',
  'Where would you take a friend visiting your city?',
  'What is the last photo on your phone?',
  'How do you usually spend Sunday morning?',
  'What do you always carry with you?',
  'What sport or exercise do you do?',
  'What was the last film you saw?',
  'How did you choose the place you live?',
]

const MID = [
  'Describe a problem you solved at work recently.',
  'Tell me about a time you changed your mind.',
  'What is the most useful thing you learned this year?',
  'How has your daily routine changed in five years?',
  'Describe someone who influenced how you work.',
  'What part of your job would you automate?',
  'Tell me about a trip that did not go as planned.',
  'What advice would you give someone starting your job?',
  'Describe a habit you tried to build and failed.',
  'What do people misunderstand about your work?',
  'Tell me about a decision you made without enough information.',
  'How do you decide what to do first?',
  'Describe explaining something difficult to someone.',
  'What would you do differently starting your career again?',
  'Tell me about a skill you want to learn.',
  'What has surprised you about living where you live?',
  'Describe a disagreement you handled well.',
  'How do you know when you have done well?',
  'Tell me about something you own and would never replace.',
  'What is a risk you took that worked out?',
]

const HARD = [
  'Does working remotely make people better or worse at work?',
  'Should companies be responsible for their employees health?',
  'Is it better to be a specialist or a generalist?',
  'How should cities balance tourism against residents lives?',
  'What do we owe people from other cultures?',
  'Is failure necessary for learning, or only common?',
  'Should education focus on skills or on thinking?',
  'How far should technology be allowed to shape habits?',
  'Can work and identity ever really be separated?',
  'What makes a piece of advice worth following?',
]

function build(level: Level, texts: string[]): Question[] {
  return texts.map((text, i) => ({ id: `${level[0]}${i + 1}`, text, level }))
}

export const BANK: Question[] = [
  ...build('easy', EASY),
  ...build('mid', MID),
  ...build('hard', HARD),
]

/** 日付から決まる疑似乱数。同じ日に開き直しても同じ10問が出る。 */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

function hash(s: string): number {
  let h = 2166136261
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = Math.imul(h, 16777619)
  }
  return h >>> 0
}

function pick(pool: Question[], n: number, rand: () => number): Question[] {
  const rest = [...pool]
  const out: Question[] = []
  while (out.length < n && rest.length > 0) {
    out.push(rest.splice(Math.floor(rand() * rest.length), 1)[0])
  }
  return out
}

/**
 * その日の10問を選ぶ。直近で出した問題は避けるが、避けきれないときは
 * 出題数を削らずに除外を諦める（10問出ることを優先する）。
 */
export function pickDaily(date: string, recentIds: string[] = []): Question[] {
  const rand = mulberry32(hash(date))
  const recent = new Set(recentIds)
  const out: Question[] = []

  for (const level of ['easy', 'mid', 'hard'] as const) {
    const all = BANK.filter((q) => q.level === level)
    const fresh = all.filter((q) => !recent.has(q.id))
    const need = DAILY_MIX[level]
    const chosen = pick(fresh.length >= need ? fresh : all, need, rand)
    out.push(...chosen)
  }

  // easy から順に並ぶと難易度が階段状になるので、出題順は混ぜる。
  return pick(out, out.length, rand)
}

/**
 * その日の1問。同じ問題を時間を縮めて3回答えるので、日ごとの1問だけを選ぶ。
 * 幅は1回のセッションではなく日をまたいで確保する。
 *
 * 難易度は mid を軸に回す。毎日 hard だと45秒×3が消耗になり、
 * 毎日 easy だと詰まる経験が無くなって伸びが止まる。
 */
const FOCUS_ROTATION: Level[] = ['mid', 'easy', 'mid', 'hard']

export function pickFocus(date: string, ten: Question[]): Question {
  const rand = mulberry32(hash(date + ':focus'))
  const level = FOCUS_ROTATION[hash(date) % FOCUS_ROTATION.length]
  const pool = ten.filter((q) => q.level === level)
  return pick(pool.length > 0 ? pool : ten, 1, rand)[0]
}

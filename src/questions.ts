// Phase 1 の種問題バンク。API なしで毎日の8分を開始するためのもの。
// Phase 2 で「前夜の先読み生成」に置き換わるが、オフライン時のフォールバックとして残る。
//
// 方針（計画書 5.1 と同じ制約）:
//   - 音読6秒に収まる長さ（15語以内）
//   - 抽象論ではなく、自分の経験を語らせる
//   - 1日の配分は easy 6 / mid 3 / hard 1。詰まる経験を1問だけ確実に混ぜる
//   - **日本語を必ず添える**。英語だけだと、答える前に意味が分からず止まる

export type Level = 'easy' | 'mid' | 'hard'

export interface Question {
  id: string
  text: string
  /** 日本語。意味が分からない質問には答えようがない。必ず付ける。 */
  ja: string
  level: Level
}

export const DAILY_MIX: Record<Level, number> = { easy: 6, mid: 3, hard: 1 }
export const DAILY_COUNT = DAILY_MIX.easy + DAILY_MIX.mid + DAILY_MIX.hard

const EASY: [string, string][] = [
  ['What did you do first this morning?', '今朝いちばん最初にしたことは？'],
  ['What did you eat for breakfast today?', '今日の朝ごはんは何を食べた？'],
  ['How did you get to work today?', '今日はどうやって職場まで行った？'],
  ['What is on your desk right now?', 'いま机の上に何がある？'],
  ['Who did you talk to yesterday?', '昨日は誰と話した？'],
  ['What did you do last weekend?', '先週末は何をした？'],
  ['What is the weather like today?', '今日の天気は？'],
  ['Which app do you open most often?', 'いちばんよく開くアプリは？'],
  ['What time did you wake up today?', '今日は何時に起きた？'],
  ['What did you watch or read last night?', '昨夜は何を見た、または読んだ？'],
  ['Where do you usually buy your coffee?', 'いつもどこでコーヒーを買う？'],
  ['What do you need to finish this week?', '今週中に終わらせないといけないことは？'],
  ['How long is your commute?', '通勤にどれくらいかかる？'],
  ['What did you have for dinner yesterday?', '昨日の夕食は何を食べた？'],
  ['What is your favourite place near your home?', '家の近くでいちばん好きな場所は？'],
  ['What do you do to relax after work?', '仕事のあと、どうやってくつろぐ？'],
  ['Who is the last person you called?', '最後に電話した相手は誰？'],
  ['What did you buy most recently?', 'いちばん最近買ったものは？'],
  ['What music did you listen to today?', '今日はどんな音楽を聴いた？'],
  ['How often do you cook at home?', 'どれくらいの頻度で家で料理する？'],
  ['What is your plan for tomorrow?', '明日の予定は？'],
  ['Which season do you like best, and why?', 'どの季節がいちばん好き？ 理由は？'],
  ['What did you learn this week?', '今週、何を学んだ？'],
  ['Where would you take a friend visiting your city?', '友達が街に来たら、どこへ連れて行く？'],
  ['What is the last photo on your phone?', 'スマホに入っている最後の写真は何？'],
  ['How do you usually spend Sunday morning?', '日曜の朝はたいてい何をして過ごす？'],
  ['What do you always carry with you?', 'いつも持ち歩いているものは？'],
  ['What sport or exercise do you do?', 'どんなスポーツや運動をしている？'],
  ['What was the last film you saw?', '最後に見た映画は？'],
  ['How did you choose the place you live?', '今住んでいる場所はどうやって選んだ？'],
]

const MID: [string, string][] = [
  ['Describe a problem you solved at work recently.', '最近、仕事で解決した問題について話して。'],
  ['Tell me about a time you changed your mind.', '考えを変えたときのことを話して。'],
  ['What is the most useful thing you learned this year?', '今年学んだことで、いちばん役に立ったものは？'],
  ['How has your daily routine changed in five years?', 'この5年で毎日の習慣はどう変わった？'],
  ['Describe someone who influenced how you work.', '自分の働き方に影響を与えた人について話して。'],
  ['What part of your job would you automate?', '仕事のどの部分を自動化したい？'],
  ['Tell me about a trip that did not go as planned.', '予定どおりにいかなかった旅行について話して。'],
  ['What advice would you give someone starting your job?', '自分と同じ仕事を始める人に、どんな助言をする？'],
  ['Describe a habit you tried to build and failed.', '身につけようとして失敗した習慣について話して。'],
  ['What do people misunderstand about your work?', '自分の仕事について、よく誤解されることは？'],
  ['Tell me about a decision you made without enough information.', '十分な情報がないまま決めたことについて話して。'],
  ['How do you decide what to do first?', '何から手をつけるかを、どうやって決める？'],
  ['Describe explaining something difficult to someone.', '難しいことを人に説明したときのことを話して。'],
  ['What would you do differently starting your career again?', '仕事を一からやり直せるなら、何を変える？'],
  ['Tell me about a skill you want to learn.', '身につけたい技能について話して。'],
  ['What has surprised you about living where you live?', '今の場所に住んでみて驚いたことは？'],
  ['Describe a disagreement you handled well.', 'うまく対処できた意見の食い違いについて話して。'],
  ['How do you know when you have done well?', '自分がうまくやれたと、どうやって分かる？'],
  ['Tell me about something you own and would never replace.', '絶対に買い替えない持ち物について話して。'],
  ['What is a risk you took that worked out?', '取ってみて、うまくいった賭けは？'],
]

const HARD: [string, string][] = [
  ['Does working remotely make people better or worse at work?', '在宅勤務は、人の仕事ぶりを良くする？ 悪くする？'],
  ['Should companies be responsible for their employees health?', '会社は社員の健康に責任を持つべき？'],
  ['Is it better to be a specialist or a generalist?', '専門家と何でも屋、どちらがいい？'],
  ['How should cities balance tourism against residents lives?', '街は観光と住民の生活を、どう両立させるべき？'],
  ['What do we owe people from other cultures?', '異なる文化の人に対して、私たちは何を負っている？'],
  ['Is failure necessary for learning, or only common?', '失敗は学びに必要？ それとも、ただよくあるだけ？'],
  ['Should education focus on skills or on thinking?', '教育は技能と思考、どちらを重視すべき？'],
  ['How far should technology be allowed to shape habits?', '技術が習慣を形づくることを、どこまで許すべき？'],
  ['Can work and identity ever really be separated?', '仕事と自分らしさは、本当に切り離せる？'],
  ['What makes a piece of advice worth following?', '従う価値のある助言とは、どういうもの？'],
]

function build(level: Level, rows: [string, string][]): Question[] {
  return rows.map(([text, ja], i) => ({ id: `${level[0]}${i + 1}`, text, ja, level }))
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

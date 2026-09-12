// Phase 1 の種問題バンク。API なしで毎日の8分を開始するためのもの。
// Phase 2 で「前夜の先読み生成」に置き換わるが、オフライン時のフォールバックとして残る。
//
// 方針（計画書 5.1 と同じ制約）:
//   - 音読6秒に収まる長さ（15語以内）
//   - 抽象論ではなく、自分の経験を語らせる
//   - 1日の配分は easy 6 / mid 3 / hard 1。詰まる経験を1問だけ確実に混ぜる
//   - **日本語を必ず添える**。英語だけだと、答える前に意味が分からず止まる
//   - **手本の答えを必ず添える**。2〜3文、平易な構文。真似して言える高さにする

export type Level = 'easy' | 'mid' | 'hard'

export interface Question {
  id: string
  text: string
  /** 日本語。意味が分からない質問には答えようがない。必ず付ける。 */
  ja: string
  /**
   * 手本の答え。工程4で渡す。
   * これが無いと、言えない人は45秒×3を沈黙で過ごすだけになる。
   * 難しい語を使わない。学習者がその場で真似できる高さに置く。
   */
  model: string
  level: Level
}

/**
 * 1日の難易度配分。当面 hard は 0 にしてある。
 * 基本文型で詰まる段階では、抽象的な問いは「内容の負荷」と「構文の負荷」を
 * 同時にかけるだけで、詰まる経験にならない。
 * 「言い切れた」日が続くようになったら hard を 1 に戻す。
 */
export const DAILY_MIX: Record<Level, number> = { easy: 7, mid: 3, hard: 0 }
export const DAILY_COUNT = DAILY_MIX.easy + DAILY_MIX.mid + DAILY_MIX.hard

type Row = [en: string, ja: string, model: string]

const EASY: Row[] = [
  ['What did you do first this morning?', '今朝いちばん最初にしたことは？', 'I checked my phone first. Then I made some coffee.'],
  ['What did you eat for breakfast today?', '今日の朝ごはんは何を食べた？', 'I had rice and miso soup. I also drank green tea.'],
  ['How did you get to work today?', '今日はどうやって職場まで行った？', 'I took the train. It took about forty minutes.'],
  ['What is on your desk right now?', 'いま机の上に何がある？', 'My laptop is on my desk. There\'s also a cup of coffee and a notebook.'],
  ['Who did you talk to yesterday?', '昨日は誰と話した？', 'I talked to my coworker about a project. We had lunch together too.'],
  ['What did you do last weekend?', '先週末は何をした？', 'I stayed home and cleaned my room. On Sunday I met a friend.'],
  ['What is the weather like today?', '今日の天気は？', 'It\'s cloudy and a little cold. I think it will rain later.'],
  ['Which app do you open most often?', 'いちばんよく開くアプリは？', 'I open LINE most often. I use it to talk to my family every day.'],
  ['What time did you wake up today?', '今日は何時に起きた？', 'I woke up at six thirty. I went to bed late, so I was tired.'],
  ['What did you watch or read last night?', '昨夜は何を見た、または読んだ？', 'I watched a drama on my phone. It was really interesting.'],
  ['Where do you usually buy your coffee?', 'いつもどこでコーヒーを買う？', 'I usually buy it at the store near my office. Sometimes I make it at home.'],
  ['What do you need to finish this week?', '今週中に終わらせないといけないことは？', 'I need to finish a report. I also have to answer some emails.'],
  ['How long is your commute?', '通勤にどれくらいかかる？', 'It takes about forty minutes each way. I usually read on the train.'],
  ['What did you have for dinner yesterday?', '昨日の夕食は何を食べた？', 'I had curry and rice. I cooked it myself.'],
  ['What is your favorite place near your home?', '家の近くでいちばん好きな場所は？', 'I like the park near my house. I go there to walk in the evening.'],
  ['What do you do to relax after work?', '仕事のあと、どうやってくつろぐ？', 'I take a hot bath. After that I watch videos for a while.'],
  ['Who is the last person you called?', '最後に電話した相手は誰？', 'I called my mother yesterday. We talked for about ten minutes.'],
  ['What did you buy most recently?', 'いちばん最近買ったものは？', 'I bought new shoes. They were on sale.'],
  ['What music did you listen to today?', '今日はどんな音楽を聴いた？', 'I listened to some pop songs. I always listen to music on the train.'],
  ['How often do you cook at home?', 'どれくらいの頻度で家で料理する？', 'I cook about three times a week. When I\'m busy, I just buy something at the store.'],
  ['What is your plan for tomorrow?', '明日の予定は？', 'I\'ll go to work in the morning. In the evening I want to exercise.'],
  ['Which season do you like best, and why?', 'どの季節がいちばん好き？ 理由は？', 'I like autumn best. It\'s not too hot, and the food is good.'],
  ['What did you learn this week?', '今週、何を学んだ？', 'I learned a new way to use a spreadsheet. It saves me a lot of time.'],
  ['Where would you take a friend visiting your city?', '友達が街に来たら、どこへ連れて行く？', 'I want to take them to the old temple. Then we can eat ramen together.'],
  ['What is the last photo on your phone?', 'スマホに入っている最後の写真は何？', 'It\'s a photo of my lunch. I took it yesterday.'],
  ['How do you usually spend Sunday morning?', '日曜の朝はたいてい何をして過ごす？', 'I sleep late and then do the laundry. Sometimes I go shopping.'],
  ['What do you always carry with you?', 'いつも持ち歩いているものは？', 'I always carry my phone and my wallet. I also carry a small umbrella.'],
  ['What sport or exercise do you do?', 'どんなスポーツや運動をしている？', 'I walk almost every day. I also go to the gym on weekends.'],
  ['What was the last movie you saw?', '最後に見た映画は？', 'I saw an action movie last month. It was fun, but a little too long.'],
  ['How did you choose the place you live?', '今住んでいる場所はどうやって選んだ？', 'I chose it because it\'s close to the station. The rent wasn\'t too high.'],
  ['What do you usually do on Monday morning at work?', '月曜の朝、職場でたいてい何をする？', 'I check my email first. Then I make a list for the week.'],
  ['What is one thing you want to buy this year?', '今年ひとつ買いたいものは？', 'I want to buy a new bag. My old one is getting dirty.'],
]

const MID: Row[] = [
  ['Tell me about a problem you solved at work recently.', '最近、仕事で解決した問題は？', 'We had too many meetings, so nobody had time to work. I changed the schedule, and now we meet only twice a week.'],
  ['Tell me about a time you changed your mind.', '考えを変えたときのことは？', 'At first I didn\'t want to move to a new city. But I visited it, and I liked it. So I changed my mind.'],
  ['What is the most useful thing you learned this year?', '今年学んだことで、いちばん役に立ったものは？', 'I learned how to say no politely. It gave me more time for my own work.'],
  ['How is your life different from five years ago?', 'この5年で、毎日の生活はどう変わった？', 'Five years ago I went to the office every day. Now I work from home twice a week. So I can sleep longer.'],
  ['Tell me about someone who changed the way you work.', '自分の働き方を変えた人は？', 'My first boss always answered emails quickly. So people trusted him. I try to do the same.'],
  ['What part of your job would you automate?', '仕事のどの部分を自動化したい？', 'I would automate my reports. I write almost the same thing every week.'],
  ['Tell me about a trip that did not go as planned.', '予定どおりにいかなかった旅行は？', 'I planned to go to the beach, but it rained all week. We stayed inside and played games instead.'],
  ['What advice would you give someone starting your job?', '自分と同じ仕事を始める人に、どんなアドバイスをする？', 'I would tell them to ask a lot of questions. In the first month, nobody knows everything.'],
  ['Tell me about a habit you tried to start but could not keep.', '始めようとしたけど続かなかった習慣は？', 'I tried to run every morning. I did it for two weeks, but then I got busy and stopped.'],
  ['What do people misunderstand about your work?', '自分の仕事について、よく誤解されることは？', 'People think I sit at a computer all day. But I talk with other teams a lot.'],
  ['Tell me about a time you decided something too quickly.', 'よく考えずに決めてしまったときのことは？', 'I chose my apartment after I saw it only once. It was OK, but the room was smaller than I thought.'],
  ['How do you decide what to do first?', '何から手をつけるか、どうやって決める？', 'I start with the closest deadline. If two things are urgent, I ask my boss.'],
  ['Tell me about a time you explained something difficult to someone.', '難しいことを誰かに説明したときのことは？', 'I had to explain our new system to a customer. I used a simple drawing, and then they understood it.'],
  ['If you could start your career again, what would you do differently?', '仕事を一からやり直せるなら、何を変える？', 'I would study English much earlier. Then I could get a better job.'],
  ['Tell me about a skill you want to learn.', '身につけたい技能は？', 'I want to learn how to speak in front of many people. I get nervous, so I need more practice.'],
  ['What surprised you about the place you live now?', '今の場所に住んでみて驚いたことは？', 'I was surprised that it\'s very quiet at night. I thought big cities are always noisy.'],
  ['Tell me about a time you did not agree with someone at work.', '職場で人と意見が合わなかったときのことは？', 'My coworker and I had different ideas. We talked about it, and we used a little of both.'],
  ['How do you know your work was good?', '自分の仕事がうまくいったって、どうやって分かる？', 'I finish on time, and nobody has to fix my work. Then I know it was good.'],
  ['Tell me about something you have and will never throw away.', 'ずっと持っていて、絶対に手放さないものは？', 'I have an old watch from my father. It\'s not expensive, but it means a lot to me.'],
  ['What is a risk you took that worked out?', '思い切ってやってみて、うまくいったことは？', 'I quit my job before I found a new one. It was scary, but I found a better company in two months.'],
]

const HARD: Row[] = [
  ['Which is better for you, working at home or at the office?', '家で働くのと職場で働くの、どっちがいい？', 'I like working at home because it\'s quiet. But I miss talking with my team. So I want to do both.'],
  ['Tell me about a mistake that taught you something.', '何かを学べた失敗は？', 'I sent an email to the wrong person. Now I always check the name twice before I send it.'],
  ['How much time do you spend on your phone? Is that a problem?', 'スマホにどれくらい時間を使ってる？ それは問題？', 'I use my phone about three hours a day. I think that\'s too much. I want to read more books instead.'],
  ['Whose advice do you listen to? Why that person?', '誰のアドバイスを聞く？ なぜその人？', 'I listen to my old boss. She has done the same job for twenty years. So she knows what really works.'],
  ['Is it better to be busy or to have free time?', '忙しいのと、時間に余裕があるの、どっちがいい？', 'I feel better when I\'m a little busy. But I need free time on weekends. Without it, I get tired.'],
  ['What would you change about your job if you could?', 'できるなら、仕事の何を変えたい？', 'I would change the number of meetings. We talk a lot, but we don\'t decide much.'],
  ['Do you think money or time is more important?', 'お金と時間、どっちが大事だと思う？', 'Time is more important to me now. I can make money again, but I can\'t get time back.'],
  ['What is one thing schools should teach but do not?', '学校が教えるべきなのに教えていないことは？', 'Schools should teach how to speak in front of people. Many adults are still afraid of it.'],
  ['Would you rather travel alone or with other people?', '一人旅と、誰かと行く旅、どっちがいい？', 'I would rather travel with one friend. Alone is quiet, but I like sharing good food with someone.'],
  ['What makes a good coworker?', 'いい同僚って、どういう人？', 'A good coworker answers you quickly. They also say when they don\'t know something.'],
]

function build(level: Level, rows: Row[]): Question[] {
  return rows.map(([text, ja, model], i) => ({ id: `${level[0]}${i + 1}`, text, ja, model, level }))
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
export function pickDaily(
  date: string,
  pool: Question[] = BANK,
  recentIds: string[] = [],
): Question[] {
  const rand = mulberry32(hash(date))
  const recent = new Set(recentIds)
  const out: Question[] = []

  // 自作の束はレベルが揃っていないことがある。足りない配分は後でまとめて埋める。
  for (const level of ['easy', 'mid', 'hard'] as const) {
    const all = pool.filter((q) => q.level === level)
    const fresh = all.filter((q) => !recent.has(q.id))
    const need = DAILY_MIX[level]
    const chosen = pick(fresh.length >= need ? fresh : all, need, rand)
    out.push(...chosen)
  }

  // レベルが偏った束でも、出せるだけは出す。
  if (out.length < DAILY_COUNT) {
    const used = new Set(out.map((q) => q.id))
    const rest = pool.filter((q) => !used.has(q.id))
    const freshRest = rest.filter((q) => !recent.has(q.id))
    out.push(...pick(freshRest.length > 0 ? freshRest : rest, DAILY_COUNT - out.length, rand))
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
// hard を選ぶと、その日の言い直し3回が丸ごと潰れる。当面は入れない。
const FOCUS_ROTATION: Level[] = ['easy', 'mid', 'easy', 'easy']

export function pickFocus(date: string, ten: Question[]): Question {
  const rand = mulberry32(hash(date + ':focus'))
  const level = FOCUS_ROTATION[hash(date) % FOCUS_ROTATION.length]
  const pool = ten.filter((q) => q.level === level)
  return pick(pool.length > 0 ? pool : ten, 1, rand)[0]
}

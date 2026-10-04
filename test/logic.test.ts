import assert from 'node:assert/strict'
import { BANK, DAILY_COUNT, DAILY_MIX, pickDaily, pickFocus } from '../src/questions'
import { recentQuestionIds, streak, today, SessionRecord } from '../src/storage'
import { buildCards, dropMastered } from '../src/cards'
import {
  bestOf,
  DAILY_QUESTION_POOL,
  isMastered,
  MAX_CARDS_PER_DAY,
  masteryOf,
  orderByBest,
  record as recordProgress,
  TARGET_MS,
  type QuestionProgress,
} from '../src/endurance'
import {
  addQuestionTo,
  allPlaylists,
  findPlaylist,
  isUsable,
  moveQuestion,
  newPlaylist,
  newQuestion,
  removeQuestionFrom,
  resolvePool,
  seedPlaylist,
} from '../src/playlists'
import { emptySnapshot, mergeSnapshots, type Snapshot } from '../src/sync'
import { median, OnsetDetector } from '../src/vad'
import {
  formatLatency,
  missCount,
  sessionMedian,
  trend,
  usableLatencies,
  type ReflexAttempt,
} from '../src/reflex'
import {
  advance,
  createItem,
  dueCount,
  dueElsewhere,
  homeOf,
  INTERVALS,
  isGraduated,
  ReviewItem,
} from '../src/review'

/* --- 仕様の数字 --- */

/* --- 30秒の目標 --- */

assert.equal(TARGET_MS, 30_000, '目標は30秒')
assert.ok(MAX_CARDS_PER_DAY > 0 && MAX_CARDS_PER_DAY <= 20, '1日の枚数が極端')
// 種類より枚数が多くないと、同じ質問に戻れず30秒に届かない
assert.ok(MAX_CARDS_PER_DAY > DAILY_QUESTION_POOL, '1日のうちに同じ質問へ戻れない')

/* --- 問題バンク --- */

for (const q of BANK) {
  const words = q.text.split(/\s+/).length
  assert.ok(words <= 15, `長すぎる: ${q.text} (${words}語)`)
  // 質問文か Describe/Tell me 型の指示文。どちらも句読点で終わる。
  assert.ok(/[?.]$/.test(q.text), `文末の句読点がない: ${q.text}`)
  // 日本語が無いと、答える前に意味が分からず止まる。全問に必ず付ける。
  assert.ok(q.ja && q.ja.trim().length > 0, `日本語が無い: ${q.text}`)
  // 手本が無いと、言えない日に渡すものが無くなる。全問に必ず付ける。
  assert.ok(q.model && q.model.trim().length > 0, `手本が無い: ${q.text}`)
  // 手本は2文以上。1文だと「2文目は自分のことで」が成立しない。
  assert.ok(
    (q.model.match(/[.!?]/g) ?? []).length >= 2,
    `手本が1文しかない: ${q.text} → ${q.model}`,
  )
  // 真似して言える高さに置く。1文が長いと、読んだそばから落ちる。
  for (const sentence of q.model.split(/(?<=[.!?])\s+/).filter((x) => x.trim())) {
    const n = sentence.trim().split(/\s+/).length
    assert.ok(n <= 14, `手本の1文が長すぎる (${n}語): ${sentence}`)
  }
  assert.ok(/[ぁ-んァ-ン一-龥]/.test(q.ja), `日本語になっていない: ${q.text} → ${q.ja}`)
  assert.notEqual(q.ja, q.text, `日本語が英語のまま: ${q.text}`)
}
assert.equal(new Set(BANK.map((q) => q.ja)).size, BANK.length, '日本語が重複している')
assert.equal(new Set(BANK.map((q) => q.id)).size, BANK.length, 'id が重複している')

const ten = pickDaily('2026-09-11')
assert.equal(ten.length, DAILY_COUNT)
assert.equal(new Set(ten.map((q) => q.id)).size, 10, '同じ日の10問に重複がある')
for (const level of ['easy', 'mid', 'hard'] as const) {
  assert.equal(ten.filter((q) => q.level === level).length, DAILY_MIX[level], `${level} の数`)
}
// 基本文型で詰まる段階では hard を出さない
assert.equal(DAILY_MIX.hard, 0, '当面 hard は出さない')
assert.deepEqual(pickDaily('2026-09-11').map((q) => q.id), ten.map((q) => q.id), '同じ日は同じ10問')

const recent = pickDaily('2026-09-10').map((q) => q.id)
assert.equal(
  pickDaily('2026-09-11', BANK, recent).filter((q) => recent.includes(q.id)).length,
  0,
  '直近問題を除外できていない',
)
assert.equal(
  pickDaily('2026-09-11', BANK, BANK.map((q) => q.id)).length,
  10,
  '除外過多で問題数が減った',
)

// 自作の束でも出題できる。レベルが偏っていても止まらない。
const custom = newPlaylist('自分の束')
for (let i = 0; i < 12; i++) {
  custom.questions.push(
    newQuestion(custom, { text: `Q${i}?`, ja: `質問${i}`, model: 'I did it. It was fine.', level: 'easy' }),
  )
}
const customTen = pickDaily('2026-09-11', custom.questions)
assert.equal(customTen.length, 10, '自作の束から10問出ない')
assert.equal(new Set(customTen.map((q) => q.id)).size, 10, '自作の束で重複した')
assert.equal(new Set(custom.questions.map((q) => q.id)).size, 12, '追加した質問の id が重複している')

// 空の束を選んでいても、出題は止まらない（種問題に落ちる）
{
  const empty = newPlaylist('オンライン英会話')
  assert.equal(isUsable(empty), false)
  const pool = resolvePool([empty], empty.id)
  assert.ok(pool.fellBack, '空の束なのに落ちていない')
  assert.equal(pool.name, 'オンライン英会話', '落ちても選んだ束の名前は残す')
  assert.ok(pool.questions.length > 0, '空の束で出題が空になった')

  // ここが空だと、その日の1問が undefined になってセッションが壊れる
  const tenFromEmpty = pickDaily('2026-09-20', pool.questions)
  assert.ok(tenFromEmpty.length > 0, '空の束から10問が組めない')
  assert.ok(pickFocus('2026-09-20', tenFromEmpty), 'その日の1問が決まらない')
}

// 中身のある束を選んでいれば、そのまま使う
{
  const pool = resolvePool([custom], custom.id)
  assert.equal(pool.fellBack, false)
  assert.equal(pool.questions.length, custom.questions.length)
}

// 束が少なくても、あるだけ出す
const tiny = newPlaylist('少ない束')
tiny.questions.push(newQuestion(tiny, { text: 'Only one?', ja: '1問だけ', model: 'Yes. I think so.', level: 'easy' }))
assert.equal(pickDaily('2026-09-11', tiny.questions).length, 1, '少ない束で落ちる')

// 組み込みは消せず、選択中が消えていても種問題に落ちる
assert.equal(seedPlaylist().questions.length, BANK.length)
assert.equal(allPlaylists([custom]).length, 2)
assert.equal(findPlaylist([custom], 'missing').id, 'seed', '無い束を選んだら種問題に落ちるはず')
assert.equal(findPlaylist([custom], custom.id).id, custom.id)

// その日の1問は10問の中から選ばれ、日によって変わり、難易度が偏らない
const focus = pickFocus('2026-09-11', ten)
assert.ok(ten.some((q) => q.id === focus.id), '10問の外から選んでいる')
assert.equal(pickFocus('2026-09-11', ten).id, focus.id, '同じ日は同じ1問')
const levels = new Set(
  Array.from({ length: 30 }, (_, i) => {
    const date = `2026-10-${String(i + 1).padStart(2, '0')}`
    return pickFocus(date, pickDaily(date)).level
  }),
)
assert.ok(levels.size >= 2, '毎日同じ難易度ばかり出ている')

/* --- 復習スケジュール --- */

const item = createItem('What did you do?', '何をした？', 'I went to the gym.', '2026-09-11')
assert.equal(item.questionJa, '何をした？', '復習項目に日本語が入っていない')
assert.equal(item.due, '2026-09-12', '最初の復習は翌日')
assert.equal(item.reviews, 0)
assert.ok(!isGraduated(item))

// 間隔どおりに伸び、規定回数で卒業する
let cursor = item
const dues = ['2026-09-12']
for (let i = 0; i < INTERVALS.length; i++) {
  cursor = advance(cursor, cursor.due)
  dues.push(cursor.due)
}
assert.equal(cursor.reviews, INTERVALS.length)
assert.ok(isGraduated(cursor), '規定回数を終えても卒業しない')
assert.deepEqual(dues.slice(0, 4), ['2026-09-12', '2026-09-15', '2026-09-22', '2026-10-13'])
// 卒業後に間隔が壊れない
assert.equal(advance(cursor, '2026-10-13').due, cursor.due)

const mk = (id: string, due: string, reviews = 0, playlistId?: string): ReviewItem => ({
  id, question: `Q${id}`, sentence: `S${id}`, createdAt: due, reviews, due, playlistId,
})

// 束ごとの数え方。他の束のぶんは黙って消さず、別に数える。
{
  const mixed = [
    mk('own1', '2026-09-10', 0, 'pl-online'),
    mk('own2', '2026-09-11', 0, 'pl-online'),
    mk('other', '2026-09-09', 0, 'pl-chat'),
    mk('legacy', '2026-09-08'),
  ]
  assert.equal(homeOf(mixed[3]), 'seed', '印の無い項目の扱いが違う')
  assert.equal(homeOf(mixed[0]), 'pl-online')
  assert.equal(dueCount(mixed, '2026-09-11', 'pl-online'), 2)
  assert.equal(dueCount(mixed, '2026-09-11'), 4, '全体の数が合わない')
  assert.equal(dueElsewhere(mixed, '2026-09-11', 'pl-online'), 2, '他の束の残りを数えていない')
  assert.equal(dueElsewhere(mixed, '2026-09-11', 'seed'), 3)
}

// 新しい持ち帰りには、出どころの束が刻まれる
{
  const tagged = createItem('Q?', '質問', 'A. B.', '2026-09-20', 'pl-online')
  assert.equal(tagged.playlistId, 'pl-online')
  assert.equal(homeOf(tagged), 'pl-online')
  // 省いたら種問題
  assert.equal(homeOf(createItem('Q?', '質問', 'A. B.', '2026-09-20')), 'seed')
}

// 1日1項目増える定常状態で、枠が需要に足りているか
// 1日1項目increaseするとして、1項目あたり INTERVALS.length 回。
// カードの枚数がそれを下回ると、復習が永久に溜まる。
assert.ok(MAX_CARDS_PER_DAY >= INTERVALS.length, '復習の需要にカード枚数が足りない')

/* --- 記録 --- */

const day = (offset: number) => {
  const d = new Date('2026-09-11T09:00:00')
  d.setDate(d.getDate() + offset)
  return today(d)
}
const rec = (date: string, reached: number): SessionRecord => ({
  date, reached, questionIds: [], answeredIds: [], pickedId: null,
  rewrite: '', reviewed: 0, quiet: false, updatedAt: 0,
})
const from = new Date('2026-09-11T09:00:00')
assert.equal(streak([rec(day(-1), 5), rec(day(-2), 5)], from), 2, '昨日まで続いている')
assert.equal(streak([rec(day(0), 5), rec(day(-1), 5)], from), 2, '今日も完了')
assert.equal(streak([rec(day(0), 3), rec(day(-1), 5)], from), 1, '今日は途中')
assert.equal(streak([rec(day(-2), 5)], from), 0, '一昨日で途切れている')
assert.equal(streak([], from), 0)

const many = [rec(day(0), 5), rec(day(-1), 5), rec(day(-2), 5), rec(day(-3), 5)]
many[0].questionIds = ['a']; many[3].questionIds = ['z']
const ids = recentQuestionIds(many)
assert.ok(ids.includes('a') && !ids.includes('z'), '直近3回ぶんに絞れていない')

/* --- 質問の移動 --- */

const draftOf = (n: number) => ({
  text: `Question ${n}?`,
  ja: `質問${n}`,
  model: `I did it. It was number ${n}.`,
  level: 'easy' as const,
})

{
  // 2つの束を用意し、片方に3問入れる
  let lists = [newPlaylist('雑談'), newPlaylist('オンライン英会話')]
  const [chat, online] = lists
  for (const n of [1, 2, 3]) lists = addQuestionTo(lists, chat.id, draftOf(n))
  assert.equal(lists[0].questions.length, 3)

  // 足した束だけでなく、時刻も進んでいる（同期で古いほうに負けないため）
  assert.ok((lists[0].updatedAt ?? 0) >= (chat.updatedAt ?? 0), '追加で時刻が進んでいない')

  // 真ん中の1問を移す
  const moving = lists[0].questions[1]
  lists = moveQuestion(lists, chat.id, online.id, moving.id)

  assert.equal(lists[0].questions.length, 2, '移動元から消えていない')
  assert.equal(lists[1].questions.length, 1, '移動先に入っていない')
  assert.equal(lists[1].questions[0].text, moving.text, '移動で中身が変わった')
  assert.equal(lists[1].questions[0].ja, moving.ja)
  assert.equal(lists[1].questions[0].model, moving.model)
  assert.ok(!lists[0].questions.some((q) => q.text === moving.text), '移動元に残っている')

  // **両方の束の時刻が進んでいること。** 片方だけだと合流で移動が取り消される。
  assert.ok((lists[0].updatedAt ?? 0) > 0 && (lists[1].updatedAt ?? 0) > 0, '移動で時刻が進んでいない')
}

{
  // 移動先に同じ id の質問があっても、既存のものを潰さない
  let lists = [newPlaylist('A'), newPlaylist('B')]
  const [a, b] = lists
  lists = addQuestionTo(lists, a.id, draftOf(1))
  lists = addQuestionTo(lists, b.id, draftOf(9))
  assert.equal(lists[0].questions[0].id, lists[1].questions[0].id, '前提: id がぶつかっている')

  const moving = lists[0].questions[0]
  lists = moveQuestion(lists, a.id, b.id, moving.id)

  assert.equal(lists[1].questions.length, 2, 'id の衝突で既存の質問が消えた')
  assert.equal(new Set(lists[1].questions.map((q) => q.id)).size, 2, '移動先で id が重複している')
  assert.ok(lists[1].questions.some((q) => q.text === 'Question 9?'), '元からあった質問が失われた')
  assert.ok(lists[1].questions.some((q) => q.text === 'Question 1?'), '移動した質問が入っていない')
}

{
  // おかしな指定では何も壊さない
  let lists = [newPlaylist('A'), newPlaylist('B')]
  const [a, b] = lists
  lists = addQuestionTo(lists, a.id, draftOf(1))
  const id = lists[0].questions[0].id

  assert.deepEqual(moveQuestion(lists, a.id, a.id, id), lists, '同じ束への移動で書き換わった')
  assert.deepEqual(moveQuestion(lists, a.id, 'missing', id), lists, '無い束への移動で書き換わった')
  assert.deepEqual(moveQuestion(lists, a.id, b.id, 'missing'), lists, '無い質問の移動で書き換わった')

  // 削除は指定した束からだけ
  const after = removeQuestionFrom(lists, a.id, id)
  assert.equal(after[0].questions.length, 0)
  assert.equal(after[1].questions.length, 0)
}

/* --- 同期の合流 --- */

const snap = (over: Partial<Snapshot> = {}): Snapshot => ({ ...emptySnapshot(), ...over })

// 記録は「到達した工程が多いほう」を残す。後から同期した端末で巻き戻らないこと。
{
  const local = snap({ records: [{ ...rec('2026-09-11', 5), updatedAt: 100 }] })
  const remote = snap({ records: [{ ...rec('2026-09-11', 3), updatedAt: 999 }] })
  const merged = mergeSnapshots(local, remote)
  assert.equal(merged.records.length, 1, '同じ日が二重に残った')
  assert.equal(merged.records[0].reached, 5, '進んだ記録が巻き戻った')
}

// 到達が並んだら、後から書いたほうを採る
{
  const merged = mergeSnapshots(
    snap({ records: [{ ...rec('2026-09-11', 3), updatedAt: 100, rewrite: 'old' }] }),
    snap({ records: [{ ...rec('2026-09-11', 3), updatedAt: 200, rewrite: 'new' }] }),
  )
  assert.equal(merged.records[0].rewrite, 'new')
}

// 別々の日は両方残る
{
  const merged = mergeSnapshots(
    snap({ records: [rec('2026-09-11', 5)] }),
    snap({ records: [rec('2026-09-10', 5)] }),
  )
  assert.equal(merged.records.length, 2)
  assert.equal(merged.records[0].date, '2026-09-11', '新しい日が先頭に来ていない')
}

// 復習項目は「復習回数が多いほう」を残す。巻き戻すと同じ日に二度出る。
{
  const ahead = { ...mk('x', '2026-09-20', 2) }
  const behind = { ...mk('x', '2026-09-12', 1) }
  const merged = mergeSnapshots(snap({ reviews: [behind] }), snap({ reviews: [ahead] }))
  assert.equal(merged.reviews.length, 1, '同じ項目が二重に残った')
  assert.equal(merged.reviews[0].reviews, 2, '復習の進みが巻き戻った')
  assert.equal(merged.reviews[0].due, '2026-09-20')
}

// 片方にしか無い項目は消さない
{
  const merged = mergeSnapshots(snap({ reviews: [mk('a', '2026-09-12')] }), snap({ reviews: [mk('b', '2026-09-13')] }))
  assert.equal(merged.reviews.length, 2, '片方にしか無い項目が消えた')
}

// プレイリストは編集が新しいほうを丸ごと残す
{
  const older = { ...newPlaylist('束'), id: 'p1', updatedAt: 100, questions: [] }
  const newer = { ...newPlaylist('束'), id: 'p1', updatedAt: 200, questions: custom.questions.slice(0, 2) }
  const merged = mergeSnapshots(snap({ playlists: [older] }), snap({ playlists: [newer] }))
  assert.equal(merged.playlists.length, 1)
  assert.equal(merged.playlists[0].questions.length, 2, '新しい編集が古いほうに負けた')
}

// 出題済みは両方を合わせ、重複を落として末尾30件
{
  const merged = mergeSnapshots(snap({ asked: ['a', 'b'] }), snap({ asked: ['b', 'c'] }))
  assert.equal(new Set(merged.asked).size, merged.asked.length, '出題済みが重複している')
  assert.ok(['a', 'b', 'c'].every((x) => merged.asked.includes(x)), '片方の出題済みが消えた')
  const many = Array.from({ length: 40 }, (_, i) => `q${i}`)
  assert.equal(mergeSnapshots(snap({ asked: many }), snap()).asked.length, 30, '上限を超えて溜まる')
}

// 合流は順番を入れ替えても同じ結果になる
{
  const a = snap({ records: [rec('2026-09-11', 5)], reviews: [mk('x', '2026-09-20', 2)] })
  const b = snap({ records: [rec('2026-09-11', 3)], reviews: [mk('x', '2026-09-12', 1)] })
  const ab = mergeSnapshots(a, b)
  const ba = mergeSnapshots(b, a)
  assert.deepEqual(ab.records, ba.records, '合流の向きで記録が変わる')
  assert.deepEqual(ab.reviews, ba.reviews, '合流の向きで復習が変わる')
}

/* --- 発話の立ち上がり検出 --- */

/** 一定間隔で音量を食わせて、報告された立ち上がり時刻を返す。 */
const run = (levels: number[], noiseFloor: number, stepMs = 16): number | null => {
  const d = new OnsetDetector({ noiseFloor })
  for (let i = 0; i < levels.length; i++) {
    const at = d.feed(i * stepMs, levels[i])
    if (at !== null) return at
  }
  return null
}

const quiet = (n: number) => Array(n).fill(0.002)
const loud = (n: number) => Array(n).fill(0.2)

{
  // 静かなまま続けば、何も検出しない
  assert.equal(run(quiet(100), 0.002), null, '無音で誤検出した')

  // 声が出たら、**超え始めた時刻**を返す（確定までの保持ぶん遅らせない）
  const at = run([...quiet(30), ...loud(30)], 0.002)
  assert.equal(at, 30 * 16, '立ち上がりの時刻が保持時間ぶんずれている')

  // 単発のノイズでは反応しない（机を叩く音など）
  assert.equal(
    run([...quiet(30), 0.5, ...quiet(60)], 0.002),
    null,
    '単発のノイズで誤検出した',
  )

  // 開始直後は無視する（読み上げの残響を自分の声と数えない）
  assert.equal(run(loud(4), 0.002), null, 'ガード時間中に検出した')
  assert.ok((run(loud(40), 0.002) ?? 0) >= 120, 'ガード時間より前の時刻を返した')

  // うるさい部屋では、基準が上がってしきい値も上がる
  assert.equal(run(Array(100).fill(0.05), 0.05), null, '騒音をそのまま声として数えた')
  assert.ok(run([...Array(30).fill(0.05), ...Array(30).fill(0.4)], 0.05) !== null, '騒音下で声を拾えない')

  // 一度決まったら動かない
  const d = new OnsetDetector({ noiseFloor: 0.002 })
  for (let i = 0; i < 40; i++) d.feed(i * 16, 0.2)
  const first = d.detected
  d.feed(2000, 0.9)
  assert.equal(d.detected, first, '検出後に時刻が上書きされた')
}

/* --- 反射モードの集計 --- */

function attempt(latencyMs: number | null, suspicious = false): ReflexAttempt {
  return { questionId: 'q', question: 'Q?', ja: '質問', latencyMs, suspicious }
}

{
  assert.equal(median([]), null)
  assert.equal(median([300]), 300)
  assert.equal(median([300, 100, 200]), 200, '中央値が違う')
  assert.equal(median([400, 100, 200, 300]), 250, '偶数個の中央値が違う')

  // 声が出なかった試行は集計から外す。0秒として混ぜると中央値が嘘になる。
  const mixed = [attempt(800), attempt(null), attempt(400), attempt(600)]
  assert.deepEqual(usableLatencies(mixed), [800, 400, 600])
  assert.equal(sessionMedian(mixed), 600)
  assert.equal(missCount(mixed), 1)

  // 残響の疑いがあるものも外す
  const withEcho = [attempt(900), attempt(80, true), attempt(700)]
  assert.deepEqual(usableLatencies(withEcho), [900, 700], '疑わしい値を集計に入れている')
  assert.equal(sessionMedian(withEcho), 800)

  // 全部だめなら null。0 と区別する。
  assert.equal(sessionMedian([attempt(null), attempt(null)]), null)
  assert.equal(formatLatency(null), '—')
  assert.equal(formatLatency(1234), '1.23秒')
}

{
  // 推移は、測れた日だけを新しい順に
  const rec = (date: string, attempts: ReflexAttempt[]) => ({
    date, playlistId: 'seed', attempts, updatedAt: 0,
  })
  const got = trend([
    rec('2026-10-03', [attempt(900), attempt(1100)]),
    rec('2026-10-02', [attempt(null)]),
    rec('2026-10-01', [attempt(1500)]),
  ])
  assert.deepEqual(got, [
    { date: '2026-10-03', ms: 1000 },
    { date: '2026-10-01', ms: 1500 },
  ], '測れなかった日を混ぜている')
}

/* --- 到達時間の記録 --- */

const q = (text: string) => ({ id: text, text, ja: `${text}の意味`, model: 'A. B.', level: 'easy' as const })

{
  let p: QuestionProgress[] = []
  p = recordProgress(p, 'seed', 'A?', 12_000, '2026-10-01')
  assert.equal(bestOf(p, 'seed', 'A?')?.bestMs, 12_000)
  assert.equal(bestOf(p, 'seed', 'A?')?.attempts, 1)

  // **最長だけを残す。** 短い回で上書きすると、到達済みが出題に戻る。
  p = recordProgress(p, 'seed', 'A?', 5_000, '2026-10-02')
  assert.equal(bestOf(p, 'seed', 'A?')?.bestMs, 12_000, '短い記録で上書きした')
  assert.equal(bestOf(p, 'seed', 'A?')?.attempts, 2)

  p = recordProgress(p, 'seed', 'A?', 31_000, '2026-10-03')
  assert.ok(isMastered(bestOf(p, 'seed', 'A?')), '30秒を超えても卒業しない')

  // 束が違えば別の記録
  p = recordProgress(p, 'pl-online', 'A?', 3_000, '2026-10-03')
  assert.equal(bestOf(p, 'seed', 'A?')?.bestMs, 31_000, '束をまたいで混ざった')
  assert.equal(bestOf(p, 'pl-online', 'A?')?.bestMs, 3_000)

  assert.equal(isMastered(undefined), false, '記録の無い質問を卒業扱いにした')
}

/* --- 出題順: 30秒に届いていないものを、長い順に --- */

{
  const questions = [q('A?'), q('B?'), q('C?'), q('D?')]
  let p: QuestionProgress[] = []
  p = recordProgress(p, 'seed', 'A?', 5_000, '2026-10-01')
  p = recordProgress(p, 'seed', 'B?', 25_000, '2026-10-01')
  p = recordProgress(p, 'seed', 'C?', 30_000, '2026-10-01') // 卒業
  // D? は未挑戦

  const ordered = orderByBest(questions, p, 'seed')
  assert.deepEqual(
    ordered.map((x) => x.text),
    ['B?', 'A?', 'D?'],
    '長い順になっていない / 卒業済みが残っている',
  )

  assert.deepEqual(masteryOf(questions, p, 'seed'), { mastered: 1, total: 4 })

  // 全部が30秒に届いたら、出すものが無くなる
  let all = p
  for (const text of ['A?', 'B?', 'D?']) all = recordProgress(all, 'seed', text, 30_000, '2026-10-02')
  assert.deepEqual(orderByBest(questions, all, 'seed'), [], '全部到達しても出題が残る')
  assert.deepEqual(masteryOf(questions, all, 'seed'), { mastered: 4, total: 4 })
}

/* --- カードの組み立て --- */

{
  const questions = [q('A?'), q('B?'), q('C?')]
  let p: QuestionProgress[] = []
  p = recordProgress(p, 'seed', 'A?', 5_000, '2026-10-01')
  p = recordProgress(p, 'seed', 'B?', 20_000, '2026-10-01')

  // 期限の来た復習が先。残りは長い順。
  const due = [mk('r1', '2026-09-30', 0, 'seed')]
  const cards = buildCards(questions, due, p, '2026-10-03', 'seed')
  assert.equal(cards.length, MAX_CARDS_PER_DAY, '枚数が違う')
  assert.equal(cards[0].kind, 'review', '復習が先頭に来ていない')
  assert.deepEqual(
    cards.slice(1, 4).map((c) => c.question),
    ['B?', 'A?', 'C?'],
    '長い順に並んでいない',
  )

  // 枠が余ったら同じ並びを繰り返す（全部が30秒に届くまで出し続ける）
  assert.deepEqual(cards.slice(4, 7).map((c) => c.question), ['B?', 'A?', 'C?'], '繰り返していない')

  // 質問が多い日でも、扱う種類は絞って繰り返す
  const many = Array.from({ length: 12 }, (_, i) => q(`M${i}?`))
  const packed = buildCards(many, [], [], '2026-10-03', 'seed')
  assert.equal(packed.length, MAX_CARDS_PER_DAY)
  assert.equal(
    new Set(packed.map((c) => c.question)).size,
    DAILY_QUESTION_POOL,
    '1日に触る種類を絞っていない',
  )

  // 1問を連続で叩かない
  for (let i = 1; i < cards.length; i++) {
    assert.notEqual(cards[i].question, cards[i - 1].question, '同じ質問が連続した')
  }

  // 30秒に届いた質問は、先に残っていても落ちる
  const trimmed = dropMastered(cards, 'B?')
  assert.ok(!trimmed.some((c) => c.kind === 'question' && c.question === 'B?'), '到達後も残っている')
  assert.ok(trimmed.some((c) => c.question === 'A?'), '関係ない質問まで落とした')
  assert.equal(trimmed.filter((c) => c.kind === 'review').length, 1, '復習まで落とした')

  // 全部到達していれば、復習だけが残る
  let allDone = p
  for (const text of ['A?', 'B?', 'C?']) allDone = recordProgress(allDone, 'seed', text, 30_000, '2026-10-02')
  const onlyReviews = buildCards(questions, due, allDone, '2026-10-03', 'seed')
  assert.ok(onlyReviews.every((c) => c.kind === 'review'), '到達済みを出題した')

  // 届いていない質問は翌日も残る（記録が消えないこと）
  assert.equal(bestOf(p, 'seed', 'A?')?.bestMs, 5_000, '翌日に記録が引き継がれない')
  assert.deepEqual(orderByBest(questions, p, 'seed').map((x) => x.text), ['B?', 'A?', 'C?'])

  // 束が空でも落ちない
  assert.deepEqual(buildCards([], [], p, '2026-10-03', 'seed'), [])
}

console.log('logic: all assertions passed')

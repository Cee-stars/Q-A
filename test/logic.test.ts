import assert from 'node:assert/strict'
import { BANK, DAILY_COUNT, DAILY_MIX, pickDaily, pickFocus } from '../src/questions'
import { recentQuestionIds, streak, today, SessionRecord } from '../src/storage'
import {
  ATTEMPT_MS,
  MODEL_MS,
  PARTIAL_WORDS,
  RESPEAK_ROUNDS_MS,
  RESPEAK_SCAFFOLD,
  REVIEW_MS,
  REVIEW_SLOTS,
  TOTAL_MS,
  reachedFor,
} from '../src/session'
import {
  allPlaylists,
  findPlaylist,
  isUsable,
  newPlaylist,
  newQuestion,
  resolvePool,
  seedPlaylist,
} from '../src/playlists'
import { emptySnapshot, mergeSnapshots, type Snapshot } from '../src/sync'
import {
  advance,
  createItem,
  dueCount,
  INTERVALS,
  isGraduated,
  ReviewItem,
  selectForReview,
} from '../src/review'

/* --- 仕様の数字 --- */

assert.equal(TOTAL_MS, 240_000, '合計は4分でなければならない')
assert.ok(TOTAL_MS <= 480_000, '8分を超えている')
assert.equal(REVIEW_MS, REVIEW_SLOTS * 20_000)
assert.equal(reachedFor('idle'), 0)
assert.equal(reachedFor('done'), 5)

// 挑戦は短く。45秒の沈黙は効果を増やさず士気だけ削る。
assert.ok(ATTEMPT_MS <= 20_000, '挑戦が長すぎる')
assert.ok(MODEL_MS >= ATTEMPT_MS, '手本を受け取る時間が挑戦より短い')

// 言い直しは回を追うごとに短くなり、足場は段階的に外れる
assert.equal(RESPEAK_ROUNDS_MS.length, 3)
for (let i = 1; i < RESPEAK_ROUNDS_MS.length; i++) {
  assert.ok(RESPEAK_ROUNDS_MS[i] < RESPEAK_ROUNDS_MS[i - 1], '回を追うごとに短くなっていない')
}
assert.deepEqual(RESPEAK_SCAFFOLD, ['full', 'partial', 'none'], '足場の外し方が段階的でない')
assert.equal(RESPEAK_SCAFFOLD.length, RESPEAK_ROUNDS_MS.length, '回数と足場の数が合っていない')
assert.ok(PARTIAL_WORDS > 0 && PARTIAL_WORDS < 6, '部分表示の語数が極端')

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

const mk = (id: string, due: string, reviews = 0): ReviewItem => ({
  id, question: `Q${id}`, sentence: `S${id}`, createdAt: due, reviews, due,
})

// 期限が来たものを、遅れている順に取る
const pool = [mk('a', '2026-09-11'), mk('b', '2026-09-09'), mk('c', '2026-09-10'), mk('d', '2026-09-20')]
const picked = selectForReview(pool, '2026-09-11', 4)
assert.deepEqual(picked.map((i) => i.id), ['b', 'c', 'a'], '遅れている順になっていない')
assert.ok(!picked.some((i) => i.id === 'd'), '未来の項目を出している')
assert.equal(dueCount(pool, '2026-09-11'), 3)

// 枠に上限がある
assert.equal(selectForReview(pool, '2026-09-11', 2).length, 2)

// 期限が足りなければ卒業済みで埋め、枠を遊ばせない
const withGrads = [...pool, mk('g1', '2026-08-01', INTERVALS.length), mk('g2', '2026-08-05', INTERVALS.length)]
const filled = selectForReview(withGrads, '2026-09-11', 4)
assert.equal(filled.length, 4, '枠が埋まっていない')
assert.equal(filled[3].id, 'g1', '卒業済みは古い順に入れる')
// 同じ項目を二度出さない
assert.equal(new Set(filled.map((i) => i.id)).size, filled.length, '同じ項目が重複している')

// 履歴が無い日でも落ちない
assert.deepEqual(selectForReview([], '2026-09-11', 4), [])

// 1日1項目増える定常状態で、枠が需要に足りているか
assert.equal(INTERVALS.length, REVIEW_SLOTS, '1日あたりの復習需要と枠数が釣り合っていない')

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

console.log('logic: all assertions passed')

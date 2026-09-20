// 質問プレイリスト。瞬間英作文アプリの「⑥ 使える文型 60」と同じ考え方で、
// その日どの束から出題するかを選べるようにする。
//
// 種問題バンクは消せない組み込みの1本。自分で作った束はここに足していく。

import { BANK, type Level, type Question } from './questions'

export interface Playlist {
  id: string
  name: string
  questions: Question[]
  /** 合流のとき、新しいほうを残すための印。 */
  updatedAt?: number
}

export const SEED_PLAYLIST_ID = 'seed'

export function seedPlaylist(): Playlist {
  return { id: SEED_PLAYLIST_ID, name: '種問題 60', questions: BANK }
}

export function isSeed(playlist: Playlist): boolean {
  return playlist.id === SEED_PLAYLIST_ID
}

/** 組み込み＋自作。選択中の束が消えていても種問題に落ちるので、出題は止まらない。 */
export function allPlaylists(custom: Playlist[]): Playlist[] {
  return [seedPlaylist(), ...custom]
}

export function findPlaylist(custom: Playlist[], id: string): Playlist {
  return allPlaylists(custom).find((p) => p.id === id) ?? seedPlaylist()
}

export function newPlaylist(name: string): Playlist {
  return {
    id: `pl-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
    name,
    questions: [],
    updatedAt: Date.now(),
  }
}

/** 中身をいじったら必ず通す。これを忘れると、同期で古いほうが勝つ。 */
export function touch(playlist: Playlist): Playlist {
  return { ...playlist, updatedAt: Date.now() }
}

export interface QuestionDraft {
  text: string
  ja: string
  model: string
  level: Level
}

/** その束の中で、まだ使われていない id。束をまたぐとぶつかるので必ず取り直す。 */
function freeId(playlist: Playlist): string {
  const used = new Set(playlist.questions.map((q) => q.id))
  let n = playlist.questions.length + 1
  while (used.has(`u${n}`)) n++
  return `u${n}`
}

/** 自分で足した質問。id は束の中で一意であればよい。 */
export function newQuestion(playlist: Playlist, draft: QuestionDraft): Question {
  return {
    id: freeId(playlist),
    text: draft.text.trim(),
    ja: draft.ja.trim(),
    model: draft.model.trim(),
    level: draft.level,
  }
}

/* ---------- 束の書き換え ----------
 * 中身をいじる操作はすべてここを通す。触った束に必ず touch が掛かるので、
 * 同期の合流で古いほうが勝つ事故を、呼び出し側が気をつけなくてよくなる。
 */

export function addQuestionTo(
  playlists: Playlist[],
  playlistId: string,
  draft: QuestionDraft,
): Playlist[] {
  return playlists.map((p) =>
    p.id === playlistId ? touch({ ...p, questions: [...p.questions, newQuestion(p, draft)] }) : p,
  )
}

export function removeQuestionFrom(
  playlists: Playlist[],
  playlistId: string,
  questionId: string,
): Playlist[] {
  return playlists.map((p) =>
    p.id === playlistId
      ? touch({ ...p, questions: p.questions.filter((q) => q.id !== questionId) })
      : p,
  )
}

/**
 * 質問を別の束へ移す。間違えた束に入れてしまったときに、
 * 消して書き直さずに済ませるためのもの。
 *
 * **移動元と移動先の両方に touch を掛ける。** 片方だけだと、同期の合流で
 * 移動元の古い版が勝ち、同じ質問が両方の束に残る。
 */
export function moveQuestion(
  playlists: Playlist[],
  fromId: string,
  toId: string,
  questionId: string,
): Playlist[] {
  if (fromId === toId) return playlists
  const from = playlists.find((p) => p.id === fromId)
  const to = playlists.find((p) => p.id === toId)
  const question = from?.questions.find((q) => q.id === questionId)
  if (!from || !to || !question) return playlists

  // id は束の中でしか一意でないので、移動先で取り直す。
  // ぶつかったまま入れると、既にある質問が置き換わって消える。
  const moved = { ...question, id: freeId(to) }

  return playlists.map((p) => {
    if (p.id === fromId) {
      return touch({ ...p, questions: p.questions.filter((q) => q.id !== questionId) })
    }
    if (p.id === toId) return touch({ ...p, questions: [...p.questions, moved] })
    return p
  })
}

/** 出題に使える最低限を満たしているか。空の束からは1問も出せない。 */
export function isUsable(playlist: Playlist): boolean {
  return playlist.questions.length > 0
}

export interface Pool {
  /** 実際に出題に使う問題。空にはならない。 */
  questions: Question[]
  /** 選ばれている束の名前。 */
  name: string
  /** 選ばれた束が空で、種問題に落ちたか。 */
  fellBack: boolean
}

/**
 * 出題に使う問題を決める。
 * **空の束が選ばれていても、必ず1問以上を返す。**
 * ここで空を返すと、その日の1問が undefined になってセッションが開始直後に壊れる。
 */
export function resolvePool(custom: Playlist[], id: string): Pool {
  const chosen = findPlaylist(custom, id)
  if (isUsable(chosen)) return { questions: chosen.questions, name: chosen.name, fellBack: false }
  const seed = seedPlaylist()
  return { questions: seed.questions, name: chosen.name, fellBack: true }
}

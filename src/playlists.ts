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

/** 自分で足した質問。id は束の中で一意であればよい。 */
export function newQuestion(playlist: Playlist, draft: QuestionDraft): Question {
  const used = new Set(playlist.questions.map((q) => q.id))
  let n = playlist.questions.length + 1
  while (used.has(`u${n}`)) n++
  return {
    id: `u${n}`,
    text: draft.text.trim(),
    ja: draft.ja.trim(),
    model: draft.model.trim(),
    level: draft.level,
  }
}

/** 出題に使える最低限を満たしているか。手本が無い質問は工程4で渡すものが無い。 */
export function isUsable(playlist: Playlist): boolean {
  return playlist.questions.length > 0
}

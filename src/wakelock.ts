// これが無いと音読中に画面が消える。計画書の「忘れると必ず事故る2点」の1つ。

let lock: WakeLockSentinel | null = null
let wanted = false

async function request(): Promise<void> {
  if (!wanted || lock || !('wakeLock' in navigator)) return
  try {
    lock = await navigator.wakeLock.request('screen')
    lock.addEventListener('release', () => {
      lock = null
    })
  } catch {
    // 権限拒否・非対応・バッテリー節約モード。練習は続行する。
  }
}

// タブに戻ったときロックは失われている。取り直す。
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') void request()
})

export function keepAwake(): void {
  wanted = true
  void request()
}

export function releaseAwake(): void {
  wanted = false
  void lock?.release()
  lock = null
}

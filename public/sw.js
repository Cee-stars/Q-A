// 最小限のオフライン対応。ネットが無くても種問題バンクで練習は成立する。
const CACHE = 'qa-drill-v1'

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE).then((cache) => cache.addAll(['./', './manifest.webmanifest'])),
  )
  self.skipWaiting()
})

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  )
})

self.addEventListener('fetch', (event) => {
  const { request } = event
  if (request.method !== 'GET' || new URL(request.url).origin !== self.location.origin) return

  // 画面遷移はネット優先。デプロイ直後に古い画面が出続けるのを避ける。
  if (request.mode === 'navigate') {
    event.respondWith(
      fetch(request)
        .then((response) => {
          const copy = response.clone()
          void caches.open(CACHE).then((cache) => cache.put('./', copy))
          return response
        })
        .catch(() => caches.match('./').then((hit) => hit ?? Response.error())),
    )
    return
  }

  // ビルド済みアセットはハッシュ付き。キャッシュ優先で問題ない。
  event.respondWith(
    caches.match(request).then(
      (hit) =>
        hit ??
        fetch(request).then((response) => {
          const copy = response.clone()
          if (response.ok) void caches.open(CACHE).then((cache) => cache.put(request, copy))
          return response
        }),
    ),
  )
})

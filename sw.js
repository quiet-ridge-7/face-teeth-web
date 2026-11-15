const CACHE_NAME = "face-teeth-web-v2";
const HEAVY_CACHE = "face-teeth-web-heavy-v1";   // 大きな物を入れる、別の箱

const FILES = ["./", "index.html", "app.js", "manifest.webmanifest", "icon-192.png", "icon-512.png","guide.mjs","mediapipe_setup.mjs","licenses.txt"];

async function cacheFirst(request) {
  const cached = await caches.match(request);
  if (cached) return cached;                         // 箱にあれば、それを返す
  const response = await fetch(request);             // なければ、ネットで取る
  if (response.ok) {                                 // 正しく取れた時だけ
    const cache = await caches.open(HEAVY_CACHE);
    cache.put(request, response.clone());                        // 箱に入れる(コピーを入れる)
  }
  return response;                                   // ページには、本物を返す
}

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(FILES))   // 覚えるファイルの一覧
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      //Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k)))
      Promise.all(keys.filter((k) =>  (k !== CACHE_NAME && k !== HEAVY_CACHE) ).map((k) => caches.delete(k)))
  )
  );
});

self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);
  if (event.request.method !== "GET" || url.origin !== location.origin) return;   // 外のサイト、GET 以外は、触らない
  const isHeavy = url.pathname.includes("/lib/") || url.pathname.includes("/models/");   // 大きな物か
  event.respondWith(isHeavy ? cacheFirst(event.request) : fetch(event.request).catch(() => caches.match(event.request)));
});
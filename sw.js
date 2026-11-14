const CACHE_NAME = "face-teeth-web-v1";
const FILES = ["./", "index.html", "app.js", "manifest.webmanifest", "icon-192.png", "icon-512.png"];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(FILES))   // 覚えるファイルの一覧
  );
});

self.addEventListener("fetch", (event) => {
  event.respondWith(
    fetch(event.request).catch(() => caches.match(event.request))   // ネットが失敗したら、箱を見る
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k)))
    )
  );
});
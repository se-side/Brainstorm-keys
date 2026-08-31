// オフラインでも起動できるようにする。
// 開発中に古い版を掴まないよう network-first（通信できた時は必ず最新）。
const VERSION = 'bk-v1';
const SHELL = [
  './',
  './index.html',
  './manifest.webmanifest',
  './src/main.js',
  './src/audio.js',
  './src/speech.js',
  './src/buffer.js',
  './src/gemini.js',
  './src/keys.js',
  './src/prompts.js',
  './src/log.js',
  './icons/icon-180.png',
  './icons/icon-192.png',
  './icons/icon-512.png',
];

self.addEventListener('install', (e) => {
  e.waitUntil(
    caches.open(VERSION)
      .then((c) => c.addAll(SHELL))
      .then(() => self.skipWaiting())
      .catch(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((names) => Promise.all(names.filter((n) => n !== VERSION).map((n) => caches.delete(n))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  // Gemini API はキャッシュに関与させない
  if (new URL(req.url).origin !== self.location.origin) return;

  e.respondWith(
    fetch(req)
      .then((res) => {
        const copy = res.clone();
        caches.open(VERSION).then((c) => c.put(req, copy)).catch(() => {});
        return res;
      })
      .catch(() => caches.match(req).then((hit) => hit || caches.match('./index.html')))
  );
});

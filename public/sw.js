/* Service Worker：静态资源网络优先 + 离线兜底。
 * 注意：不拦截 /socket.io（WebSocket/轮询必须走网络）。 */
'use strict';
var CACHE = 'gdg-v2';
var PRECACHE = [
  '/', '/index.html',
  '/css/style.css',
  '/js/main.js', '/js/ui.js', '/js/sound.js', '/js/game-shared.js',
  '/logo.png', '/manifest.webmanifest'
];

self.addEventListener('install', function (e) {
  e.waitUntil(
    caches.open(CACHE).then(function (c) { return c.addAll(PRECACHE); })
      .then(function () { return self.skipWaiting(); })
  );
});

self.addEventListener('activate', function (e) {
  e.waitUntil(
    caches.keys().then(function (keys) {
      return Promise.all(keys.filter(function (k) { return k !== CACHE; })
        .map(function (k) { return caches.delete(k); }));
    }).then(function () { return self.clients.claim(); })
  );
});

self.addEventListener('fetch', function (e) {
  var req = e.request;
  if (req.method !== 'GET') return;
  var url = new URL(req.url);
  if (url.origin !== location.origin) return;
  if (url.pathname.indexOf('/socket.io') === 0) return;

  e.respondWith(
    fetch(req).then(function (res) {
      if (res && res.ok) {
        var clone = res.clone();
        caches.open(CACHE).then(function (c) { c.put(req, clone); });
      }
      return res;
    }).catch(function () {
      // 离线：静态资源走缓存；页面导航兜底到 /
      return caches.match(req).then(function (m) {
        if (m) return m;
        if (req.mode === 'navigate') return caches.match('/');
        return Response.error();
      });
    })
  );
});

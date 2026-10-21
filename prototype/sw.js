/* sw.js — minimal service worker so the client can be installed as a web app (no address bar).
 * Network first, cache as a fallback, same-origin GETs only. The game socket never goes through here.
 * Registered only on secure origins (https or localhost); elsewhere the browser refuses it anyway.
 */
var CACHE = 'mystica-v2'; // bump to purge any stale shell a flaky phone may have been serving itself
var SHELL = ['./', 'index.html', 'main.js', 'sim.js', 'net.js', 'shaders.js', 'manifest.webmanifest', 'icon-192.png', 'icon-512.png'];
self.addEventListener('install', function (ev) {
  ev.waitUntil(caches.open(CACHE).then(function (c) { return c.addAll(SHELL).catch(function () {}); }).then(function () { return self.skipWaiting(); }));
});
self.addEventListener('activate', function (ev) {
  ev.waitUntil(caches.keys().then(function (keys) { return Promise.all(keys.filter(function (k) { return k !== CACHE; }).map(function (k) { return caches.delete(k); })); }).then(function () { return self.clients.claim(); }));
});
self.addEventListener('fetch', function (ev) {
  var req = ev.request;
  if (req.method !== 'GET' || new URL(req.url).origin !== location.origin) return;
  ev.respondWith(fetch(req).then(function (res) {
    var copy = res.clone(); caches.open(CACHE).then(function (c) { c.put(req, copy); });
    return res;
  }).catch(function () { return caches.match(req); }));
});

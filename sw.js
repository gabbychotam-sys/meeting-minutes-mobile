var CACHE_PREFIX = 'meeting-minutes-mobile-';
var CACHE_NAME = CACHE_PREFIX + 'v2.1.1';
var APP_SHELL = [
  './',
  './index.html',
  './record.html',
  './dictate.html',
  './manifest.json',
  './icon.svg',
  './recordings-store.js',
  './app.js'
];

self.addEventListener('install', function (event) {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then(function (cache) {
        return cache.addAll(APP_SHELL.map(function (path) {
          return new Request(path, { cache: 'reload' });
        }));
      })
      .then(function () { return self.skipWaiting(); })
  );
});

self.addEventListener('activate', function (event) {
  event.waitUntil(
    caches.keys()
      .then(function (keys) {
        return Promise.all(keys.map(function (key) {
          if (key.indexOf(CACHE_PREFIX) === 0 && key !== CACHE_NAME) return caches.delete(key);
        }));
      })
      .then(function () { return self.clients.claim(); })
  );
});

self.addEventListener('fetch', function (event) {
  if (event.request.method !== 'GET') return;
  var requestUrl = new URL(event.request.url);
  if (requestUrl.origin !== self.location.origin) return;
  var shellUrls = APP_SHELL.map(function (path) {
    return new URL(path, self.registration.scope).href;
  });
  var cleanRequestUrl = requestUrl.origin + requestUrl.pathname;
  var isShellRequest = shellUrls.some(function (url) {
    var shellUrl = new URL(url);
    return shellUrl.origin + shellUrl.pathname === cleanRequestUrl;
  });
  if (!isShellRequest && event.request.mode !== 'navigate') return;
  event.respondWith(
    fetch(event.request, { cache: 'no-store' }).then(function (response) {
      if (response && response.ok) {
        var copy = response.clone();
        return caches.open(CACHE_NAME)
          .then(function (cache) { return cache.put(event.request, copy); })
          .then(function () { return response; });
      }
      return response;
    }).catch(function () {
      return caches.match(event.request).then(function (cached) {
        if (cached) return cached;
        if (event.request.mode === 'navigate') return caches.match('./index.html');
        return Response.error();
      });
    })
  );
});

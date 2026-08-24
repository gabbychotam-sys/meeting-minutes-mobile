// Minimal service worker — enables "Add to Home Screen" install prompt.
// No offline caching: always load the current GitHub Pages version.
self.addEventListener('install', function(e) { self.skipWaiting(); });
self.addEventListener('activate', function(e) { self.clients.claim(); });
self.addEventListener('fetch', function(e) {});

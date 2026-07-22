// Minimal service worker — enables "Add to Home Screen" install prompt.
// No offline caching: the app always needs network for speech recognition + Firebase sync.
self.addEventListener('install', function(e) { self.skipWaiting(); });
self.addEventListener('activate', function(e) { self.clients.claim(); });
self.addEventListener('fetch', function(e) {});

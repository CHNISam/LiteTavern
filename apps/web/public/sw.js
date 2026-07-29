const CACHE = 'litetavern-shell-v0.1.0';
const SHELL = ['/', '/manifest.webmanifest', '/litetavern.svg'];
self.addEventListener('install', (event) => event.waitUntil(caches.open(CACHE).then((cache) => cache.addAll(SHELL))));
self.addEventListener('activate', (event) => event.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((key) => key !== CACHE).map((key) => caches.delete(key))))));
self.addEventListener('fetch', (event) => {
  const request = event.request;
  const url = new URL(request.url);
  if (request.method !== 'GET' || url.origin !== self.location.origin || url.pathname.startsWith('/v1/')) return;
  event.respondWith(fetch(request).then((response) => {
    if (!response.ok || response.type !== 'basic') return response;
    const copy = response.clone();
    void caches.open(CACHE).then((cache) => cache.put(request, copy));
    return response;
  }).catch(() => caches.match(request).then((cached) => cached || caches.match('/'))));
});

const CACHE_NAME = 'copilot-uplink-v1';
const SHELL_URLS = ['/', '/index.html', '/style.css'];

self.addEventListener('install', (event: any) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then(cache => cache.addAll(SHELL_URLS))
  );
});

self.addEventListener('fetch', (event: any) => {
  if (event.request.method !== 'GET' || event.request.url.includes('/ws')) return;

  event.respondWith(
    fetch(event.request)
      .then(response => {
        if (response && response.ok) {
          const responseClone = response.clone();
          caches.open(CACHE_NAME).then(cache => cache.put(event.request, responseClone));
        }
        return response;
      })
      .catch(() => caches.match(event.request))
  );
});

self.addEventListener('activate', (event: any) => {
  event.waitUntil(
    caches.keys().then(keys =>
      Promise.all(
        keys.filter(key => key !== CACHE_NAME).map(key => caches.delete(key))
      )
    ).then(() => (self as any).clients.claim())
  );
});

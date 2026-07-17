/* PonsWarp app update service worker.
 * Scope: navigation/document only. Does NOT intercept StreamSaver downloads
 * (those use public/sw.js under mitm scope). Goal: bust stale HTML shells on
 * mobile after deploys without freezing in-flight transfers.
 */
const APP_SW_VERSION = 'ponswarp-app-sw-v1';
const SHELL_CACHE = `${APP_SW_VERSION}-shell`;

self.addEventListener('install', event => {
  // Activate immediately so the next navigation can claim clients.
  event.waitUntil(self.skipWaiting());
});

self.addEventListener('activate', event => {
  event.waitUntil(
    (async () => {
      const keys = await caches.keys();
      await Promise.all(
        keys
          .filter(key => key.startsWith('ponswarp-app-sw-') && key !== SHELL_CACHE)
          .map(key => caches.delete(key))
      );
      await self.clients.claim();
    })()
  );
});

self.addEventListener('message', event => {
  const data = event.data || {};
  if (data.type === 'SKIP_WAITING') {
    self.skipWaiting();
  }
  if (data.type === 'CLEAR_SHELL_CACHE') {
    event.waitUntil(caches.delete(SHELL_CACHE));
  }
});

function isNavigationRequest(request) {
  if (request.mode === 'navigate') return true;
  // Some mobile browsers use cors for document loads.
  return (
    request.destination === 'document' ||
    (request.headers.get('accept') || '').includes('text/html')
  );
}

self.addEventListener('fetch', event => {
  const { request } = event;
  if (request.method !== 'GET') return;
  if (!isNavigationRequest(request)) return;

  const url = new URL(request.url);
  // Never intercept StreamSaver / mitm download worker traffic.
  if (url.pathname.endsWith('/sw.js') || url.pathname.endsWith('/mitm.html')) {
    return;
  }
  if (url.pathname.endsWith('/app-sw.js')) return;

  event.respondWith(
    (async () => {
      try {
        // Network-first for HTML shells so deploys invalidate quickly.
        const networkResponse = await fetch(request, { cache: 'no-store' });
        if (networkResponse && networkResponse.ok) {
          const cache = await caches.open(SHELL_CACHE);
          // Clone before consuming.
          void cache.put(request, networkResponse.clone());
        }
        return networkResponse;
      } catch {
        const cache = await caches.open(SHELL_CACHE);
        const cached = await cache.match(request);
        if (cached) return cached;
        // Final fallback: try any cached index.
        const index = await cache.match('/') || await cache.match('/index.html');
        if (index) return index;
        return new Response('Offline and no cached shell', {
          status: 503,
          headers: { 'Content-Type': 'text/plain; charset=utf-8' },
        });
      }
    })()
  );
});

/**
 * Service worker — installability and a shell for the check-in PWA.
 *
 * THE CACHING STRATEGY IS THE WHOLE DESIGN HERE, and getting it wrong on this product is worse
 * than having no service worker at all.
 *
 * A cache-first worker will happily serve a previously-rendered page from cache. On this app
 * those pages carry a queue position, a room number and a "Live" indicator — so an applicant
 * could open their status page and be shown a position from an hour ago, presented as current.
 * That is precisely what NFR-AVAIL-005 forbids ("no surface shall present cached data in a
 * manner indistinguishable from live data") and what design principle 2 exists to prevent.
 *
 * So the rules are:
 *
 *   /api/*        NEVER touched. Offline mutations are handled by IndexedDB replay with
 *                 idempotency keys (Phase 5), not by a cache that would return a stale answer.
 *   navigations   NETWORK FIRST. Cache is a last-resort fallback only when the network has
 *                 genuinely failed, and the app's own connection indicator then tells the user
 *                 the data is not live.
 *   build assets  Cache first. Next.js build output under /_next/static is content-hashed and
 *                 therefore immutable — a stale one cannot exist.
 *
 * Refs: NFR-AVAIL-003, NFR-AVAIL-005, NFR-COMP-003, rules.md R-026
 */

const CACHE_NAME = 'sophep-shell-v2'

/** Immutable or near-immutable assets. Safe to serve from cache indefinitely. */
const PRECACHE = ['/manifest.webmanifest', '/icon-192.png', '/icon-512.png']

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE_NAME).then((cache) => cache.addAll(PRECACHE)))
  self.skipWaiting()
})

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((names) =>
        Promise.all(names.filter((n) => n !== CACHE_NAME).map((n) => caches.delete(n))),
      ),
  )
  self.clients.claim()
})

/** Content-hashed build output — the filename changes when the content does. */
function isImmutableAsset(url) {
  return url.pathname.startsWith('/_next/static/') || PRECACHE.includes(url.pathname)
}

self.addEventListener('fetch', (event) => {
  const request = event.request
  const url = new URL(request.url)

  if (url.origin !== self.location.origin) return
  if (request.method !== 'GET') return

  // Never intercept the API. A cached check-in result or queue position served as current
  // would be a lie the user has no way to detect.
  if (url.pathname.startsWith('/api/')) return

  if (isImmutableAsset(url)) {
    event.respondWith(
      caches.match(request).then(
        (cached) =>
          cached ||
          fetch(request).then((response) => {
            if (response.ok) {
              const copy = response.clone()
              caches.open(CACHE_NAME).then((cache) => cache.put(request, copy))
            }
            return response
          }),
      ),
    )
    return
  }

  // Everything else — including every server-rendered page — is NETWORK FIRST.
  //
  // The cached copy is only reached when the network has actually failed, which is the one
  // situation where showing something beats showing nothing. The page's own connection
  // indicator then reports "Offline · last updated HH:MM", so the staleness is visible rather
  // than hidden (NFR-AVAIL-004).
  event.respondWith(
    fetch(request)
      .then((response) => {
        if (response.ok && request.mode === 'navigate') {
          const copy = response.clone()
          caches.open(CACHE_NAME).then((cache) => cache.put(request, copy))
        }
        return response
      })
      .catch(async () => {
        const cached = await caches.match(request)
        if (cached) return cached

        // No cached copy either. Fail honestly rather than inventing a page.
        return new Response(
          '<!doctype html><meta charset="utf-8"><title>Offline</title>' +
            '<body style="font-family:system-ui;padding:2rem">' +
            '<h1>You are offline</h1>' +
            '<p>This page could not be loaded. Reconnect and try again.</p>',
          { status: 503, headers: { 'Content-Type': 'text/html; charset=utf-8' } },
        )
      }),
  )
})

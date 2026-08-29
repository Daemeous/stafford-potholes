/* ============================================================================
   sw.js — Offline support for the Stafford Pothole Watch app.

   Forked from ../Leaflet App/sw.js. Same three-tier caching split (OSM
   tiles + CDN libs are cache-first since their URLs bake in a version;
   Google Sheets/Apps Script/auth endpoints are never cached; the app's own
   files are network-first so a real edit is never masked by a stale cache).

   One difference from the Leaflet App's version: there, core.js/styles.css
   are loaded cross-origin from a shared repo (daemeous.github.io), so that
   version has a special case for treating a cross-origin URL as "this app's
   own code" for the network-first rule. Here, index.html/core.js/api.js/
   styles.css are all local files in this same folder/origin — the generic
   "same-origin HTML/JS/CSS always tries network first" rule below already
   covers all of them, no cross-origin special case needed.
   ============================================================================ */

const CACHE_VERSION = "v1";
const SHELL_CACHE = `potholewatch-shell-${CACHE_VERSION}`;
const LIB_CACHE   = `potholewatch-libs-${CACHE_VERSION}`;
const TILE_CACHE  = `potholewatch-tiles-${CACHE_VERSION}`;
const TILE_CACHE_MAX = 1000;

const SHELL_ASSETS = ["./", "./index.html"];

self.addEventListener("install", event => {
  event.waitUntil(
    caches.open(SHELL_CACHE)
      .then(cache => cache.addAll(SHELL_ASSETS))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", event => {
  const keep = new Set([SHELL_CACHE, LIB_CACHE, TILE_CACHE]);
  event.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => !keep.has(k)).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

function isTileRequest(url) {
  return /(^|\.)tile\.openstreetmap\.org$/.test(new URL(url).hostname);
}
function isCdnLibRequest(url) {
  return /^(cdnjs\.cloudflare\.com|cdn\.jsdelivr\.net|fonts\.googleapis\.com|fonts\.gstatic\.com)$/
    .test(new URL(url).hostname);
}
function isAppDataRequest(url) {
  // Sheets CSV (fetched by api.js), Apps Script, and Google auth — always
  // network, never cached. Same rule as the leafletting map's service
  // worker, and for the same reason: a stale cached response here would
  // silently hide new/updated pothole reports or auth state.
  return /(^|\.)google\.com$|(^|\.)googleapis\.com$/.test(new URL(url).hostname);
}

async function trimCache(cacheName, maxEntries) {
  const cache = await caches.open(cacheName);
  const keys = await cache.keys();
  while (keys.length > maxEntries) {
    await cache.delete(keys.shift());
  }
}

self.addEventListener("fetch", event => {
  const { request } = event;
  if (request.method !== "GET") return; // never intercept report-submit/status-update POSTs

  const url = request.url;
  if (isAppDataRequest(url)) return; // let the browser handle it directly

  if (isTileRequest(url)) {
    event.respondWith((async () => {
      const cache = await caches.open(TILE_CACHE);
      const cached = await cache.match(request);
      if (cached) return cached;
      try {
        const resp = await fetch(request);
        if (resp.ok || resp.type === "opaque") {
          cache.put(request, resp.clone());
          trimCache(TILE_CACHE, TILE_CACHE_MAX);
        }
        return resp;
      } catch (e) {
        return cached || Response.error();
      }
    })());
    return;
  }

  if (isCdnLibRequest(url)) {
    event.respondWith((async () => {
      const cache = await caches.open(LIB_CACHE);
      const cached = await cache.match(request);
      if (cached) return cached;
      try {
        const resp = await fetch(request);
        if (resp.ok || resp.type === "opaque") cache.put(request, resp.clone());
        return resp;
      } catch (e) {
        return cached || Response.error();
      }
    })());
    return;
  }

  // This app's own code (index.html/core.js/api.js/styles.css) and any
  // other same-origin navigation: always try the network first, bypassing
  // HTTP cache too, so a real deploy is never masked by a stale cache —
  // only fall back to the last-cached copy when truly offline.
  if (request.mode === "navigate" || new URL(url).origin === self.location.origin) {
    event.respondWith((async () => {
      const cache = await caches.open(SHELL_CACHE);
      try {
        const resp = await fetch(request, { cache: "no-store" });
        if (resp.ok || resp.type === "opaque") cache.put(request, resp.clone());
        return resp;
      } catch (e) {
        const cached = await cache.match(request);
        return cached || Response.error();
      }
    })());
    return;
  }

  // Anything else: stale-while-revalidate.
  event.respondWith((async () => {
    const cache = await caches.open(SHELL_CACHE);
    const cached = await cache.match(request);
    const network = fetch(request)
      .then(resp => { if (resp.ok) cache.put(request, resp.clone()); return resp; })
      .catch(() => cached);
    return cached || network;
  })());
});

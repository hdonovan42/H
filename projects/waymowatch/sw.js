/* WaymoNet tile persistence worker.
   Cache-first for vector tiles, glyphs, sprites and CDN libraries;
   stale-while-revalidate for the style JSON so style updates still
   arrive. Visited areas of London load instantly on repeat visits
   and survive offline. */

const VERSION = "waymonet-v1";
const TILE_HOST = "tiles.openfreemap.org";
const STATIC_HOSTS = ["unpkg.com", "fonts.googleapis.com", "fonts.gstatic.com"];
const MAX_ENTRIES = 6000;

self.addEventListener("install", () => self.skipWaiting());

self.addEventListener("activate", (e) => {
  e.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter(k => k !== VERSION).map(k => caches.delete(k)));
    await self.clients.claim();
  })());
});

async function trim(cache) {
  const keys = await cache.keys();
  if (keys.length > MAX_ENTRIES) {
    await Promise.all(keys.slice(0, 500).map(k => cache.delete(k)));
  }
}

async function store(cache, req, res) {
  if (res && (res.ok || res.type === "opaque")) {
    await cache.put(req, res.clone());
    if (Math.random() < 0.01) trim(cache);
  }
  return res;
}

async function cacheFirst(req) {
  const cache = await caches.open(VERSION);
  const hit = await cache.match(req);
  if (hit) return hit;
  try {
    return await store(cache, req, await fetch(req));
  } catch (err) {
    return Response.error();
  }
}

async function staleWhileRevalidate(req) {
  const cache = await caches.open(VERSION);
  const hit = await cache.match(req);
  const net = fetch(req)
    .then(res => store(cache, req, res))
    .catch(() => hit);
  return hit || net;
}

self.addEventListener("fetch", (e) => {
  if (e.request.method !== "GET") return;
  const url = new URL(e.request.url);
  if (url.host === TILE_HOST) {
    e.respondWith(
      url.pathname.startsWith("/styles")
        ? staleWhileRevalidate(e.request)
        : cacheFirst(e.request)
    );
  } else if (STATIC_HOSTS.includes(url.host)) {
    e.respondWith(cacheFirst(e.request));
  }
});

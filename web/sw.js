/**
 * CHOKÍ — Emergency Offline Resilience Service Worker
 * Caches app shell, WebGL engine assets, satellite/basemap tiles, and critical API GET telemetry
 * so firefighters and dispatchers retain situational awareness even when connectivity drops.
 */

const SHELL_CACHE = "choki-shell-v80";
const BASEMAP_CACHE = "choki-basemap-perm-v1";
const CLOUD_TILE_CACHE = "choki-clouds-v1";
const API_CACHE = "choki-api-v1";
const MAX_BASEMAP_TILES = 1000;
const MAX_CLOUD_TILES = 200;
let lastTrimTs = 0;

const PRECACHE_URLS = [
  "./",
  "./index.html",
  "./css/styles.css",
  "./vendor/react.production.min.js",
  "./vendor/react-dom.production.min.js",
  "./js/choki-react.js",
  "./js/app.js",
  "./assets/logo/project-logo.svg",
  "https://unpkg.com/maplibre-gl@5.8.0/dist/maplibre-gl.css",
  "https://unpkg.com/maplibre-gl@5.8.0/dist/maplibre-gl.js",
];

async function prewarmGlobalBasemapTiles() {
  try {
    const cache = await caches.open(BASEMAP_CACHE);
    const urls = [];
    for (let z = 0; z <= 2; z++) {
      const dim = 1 << z;
      for (let y = 0; y < dim; y++) {
        for (let x = 0; x < dim; x++) {
          urls.push(
            `https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/${z}/${y}/${x}`
          );
        }
      }
    }
    await Promise.allSettled(
      urls.map(async (u) => {
        const existing = await cache.match(u);
        if (!existing) {
          const res = await fetch(u, { mode: "cors" });
          if (res && res.ok) await cache.put(u, res);
        }
      })
    );
  } catch (_) {}
}

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches
      .open(SHELL_CACHE)
      .then(async (cache) => {
        await Promise.allSettled(
          PRECACHE_URLS.map((url) =>
            cache.add(new Request(url, { mode: url.startsWith("http") ? "cors" : "same-origin" }))
          )
        );
        await prewarmGlobalBasemapTiles();
      })
      .then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (event) => {
  const keep = new Set([SHELL_CACHE, BASEMAP_CACHE, CLOUD_TILE_CACHE, API_CACHE]);
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => !keep.has(k)).map((k) => caches.delete(k))))
      .then(() => prewarmGlobalBasemapTiles())
      .then(() => self.clients.claim())
  );
});

async function trimCache(cacheName, maxEntries) {
  const now = Date.now();
  if (now - lastTrimTs < 30000) return;
  lastTrimTs = now;
  const cache = await caches.open(cacheName);
  const keys = await cache.keys();
  if (keys.length > maxEntries) {
    const excess = keys.length - maxEntries;
    for (let i = 0; i < excess; i++) {
      await cache.delete(keys[i]);
    }
  }
}

function isBasemapTileRequest(url) {
  return (
    url.hostname.includes("arcgisonline.com") ||
    url.hostname.includes("cartocdn.com") ||
    url.hostname.includes("tile.openstreetmap.org")
  );
}

function isCloudTileRequest(url) {
  return url.hostname.includes("gibs.earthdata.nasa.gov");
}

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;

  const url = new URL(req.url);

  // 1a. Permanent Basemap Tiles: Strict Cache-First (pre-warmed global globe + up to 1,000 high-zoom regional tiles)
  if (isBasemapTileRequest(url)) {
    event.respondWith(
      caches.open(BASEMAP_CACHE).then(async (cache) => {
        const cached = await cache.match(req);
        if (cached) return cached;

        try {
          const netRes = await fetch(req);
          if (netRes && (netRes.ok || netRes.type === "opaque")) {
            cache.put(req, netRes.clone());
            trimCache(BASEMAP_CACHE, MAX_BASEMAP_TILES).catch(() => {});
          }
          return netRes;
        } catch (_) {
          return new Response("", { status: 503, statusText: "Offline Tile Unavailable" });
        }
      })
    );
    return;
  }

  // 1b. NASA GIBS Cloud Tiles: Cache-First with separate bounded cache so clouds never evict base Earth tiles
  if (isCloudTileRequest(url)) {
    event.respondWith(
      caches.open(CLOUD_TILE_CACHE).then(async (cache) => {
        const cached = await cache.match(req);
        if (cached) return cached;

        try {
          const netRes = await fetch(req);
          if (netRes && (netRes.ok || netRes.type === "opaque")) {
            cache.put(req, netRes.clone());
            trimCache(CLOUD_TILE_CACHE, MAX_CLOUD_TILES).catch(() => {});
          }
          return netRes;
        } catch (_) {
          return new Response("", { status: 503, statusText: "Offline Cloud Tile Unavailable" });
        }
      })
    );
    return;
  }

  // 2. Same-origin API GET requests: Network-First with Cache Fallback
  if (url.origin === self.location.origin && url.pathname.startsWith("/api/")) {
    event.respondWith(
      caches.open(API_CACHE).then(async (cache) => {
        try {
          const netRes = await fetch(req);
          if (netRes && netRes.ok) {
            cache.put(req, netRes.clone());
          }
          return netRes;
        } catch (_) {
          const cached = await cache.match(req);
          if (cached) return cached;
          return new Response(JSON.stringify({ offline: true, error: "Network offline and no cached response." }), {
            status: 503,
            headers: { "Content-Type": "application/json" },
          });
        }
      })
    );
    return;
  }

  // 3. App Shell & MapLibre CDN assets: Stale-While-Revalidate for instant boot & offline availability
  const isAppShell =
    url.origin === self.location.origin ||
    url.hostname.includes("unpkg.com");

  if (isAppShell) {
    event.respondWith(
      caches.open(SHELL_CACHE).then(async (cache) => {
        const cached = await cache.match(req);
        const fetchPromise = fetch(req)
          .then((res) => {
            if (res && res.ok) {
              cache.put(req, res.clone());
            }
            return res;
          })
          .catch(() => null);

        if (cached) {
          event.waitUntil(fetchPromise);
          return cached;
        }
        const netRes = await fetchPromise;
        if (netRes) return netRes;
        if (req.mode === "navigate") {
          const fallback = await cache.match("/index.html");
          if (fallback) return fallback;
        }
        return new Response("Offline", { status: 503 });
      })
    );
  }
});

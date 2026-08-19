/**
 * Service Worker para SismoGranada PWA
 * =====================================
 * Proporciona soporte offline para activos estáticos (HTML, CSS, JS, Iconos).
 */

const CACHE_NAME = "sismogranada-v8";
const STATIC_ASSETS = [
  "./",
  "./index.html",
  "./styles.css",
  "./app.js",
  "./manifest.json",
  "./config.json",
  "./icons/icon.svg",
  "./icons/icon-192.png",
  "./icons/icon-512.png"
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => {
      console.log("[SW] Pre-cacheados activos estáticos");
      return cache.addAll(STATIC_ASSETS).catch((err) => console.warn("[SW] Cache add warning:", err));
    })
  );
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) => {
      return Promise.all(
        keys.map((key) => {
          if (key !== CACHE_NAME) {
            console.log("[SW] Eliminando caché antigua:", key);
            return caches.delete(key);
          }
        })
      );
    })
  );
  self.clients.claim();
});

self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);

  // No cachear llamadas a APIs dinámicas (GitHub, IGN, CallMeBot, proxies)
  if (
    url.hostname.includes("github.com") ||
    url.hostname.includes("ign.es") ||
    url.hostname.includes("callmebot.com") ||
    url.hostname.includes("seismicportal.eu") ||
    url.hostname.includes("allorigins") ||
    url.hostname.includes("corsproxy")
  ) {
    event.respondWith(fetch(event.request));
    return;
  }

  // Estrategia Network First con fallback a caché para activos estáticos
  event.respondWith(
    fetch(event.request)
      .then((response) => {
        if (response.status === 200) {
          const responseClone = response.clone();
          caches.open(CACHE_NAME).then((cache) => {
            cache.put(event.request, responseClone);
          });
        }
        return response;
      })
      .catch(() => caches.match(event.request))
  );
});

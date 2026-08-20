/**
 * Service Worker para SismoGranada PWA con Soporte de Push Notifications (iOS 16.4+ & Android)
 * ==============================================================================================
 */

const CACHE_NAME = "sismogranada-v11";
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

  // No cachear llamadas a APIs dinámicas (GitHub, IGN, CallMeBot, proxies, websockets, ntfy)
  if (
    url.hostname.includes("github.com") ||
    url.hostname.includes("ign.es") ||
    url.hostname.includes("callmebot.com") ||
    url.hostname.includes("seismicportal.eu") ||
    url.hostname.includes("allorigins") ||
    url.hostname.includes("corsproxy") ||
    url.hostname.includes("ntfy.sh")
  ) {
    event.respondWith(fetch(event.request));
    return;
  }

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

// =============================================================================
// GESTIÓN DE NOTIFICACIONES PUSH NATIVAS (iOS 16.4+, macOS, Android)
// =============================================================================
self.addEventListener("push", (event) => {
  let title = "🚨 Alerta Sísmica Granada";
  let body = "Nuevo sismo registrado en el área de Granada.";
  let dataUrl = "./";

  if (event.data) {
    try {
      const data = event.data.json();
      title = data.title || title;
      body = data.body || body;
      if (data.url) dataUrl = data.url;
    } catch (e) {
      body = event.data.text() || body;
    }
  }

  const options = {
    body: body,
    icon: "./icons/icon-192.png",
    badge: "./icons/icon-192.png",
    vibrate: [200, 100, 200, 100, 300],
    tag: "sismo-granada-alert",
    renotify: true,
    requireInteraction: true,
    data: { url: dataUrl }
  };

  event.waitUntil(
    self.registration.showNotification(title, options)
  );
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();

  const targetUrl = event.notification.data?.url || "./";

  event.waitUntil(
    clients.matchAll({ type: "window", includeUncontrolled: true }).then((clientList) => {
      for (const client of clientList) {
        if (client.url.includes("sismo-granada") && "focus" in client) {
          return client.focus();
        }
      }
      if (clients.openWindow) {
        return clients.openWindow(targetUrl);
      }
    })
  );
});

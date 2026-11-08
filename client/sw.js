"use strict";

// Pre-Flight service worker.
//
// Its jobs are narrow: make the installed app open reliably, and never
// interfere with the checks. API calls and the share-target POST always
// go to the network untouched. Static shell files are cached on install
// and refreshed network-first, so a deploy is picked up on the next load
// and the cached copy is only a fallback when the network is gone.

const CACHE = "preflight-shell-v1";
const SHELL = [
  "/",
  "/styles.css",
  "/app.js",
  "/manifest.webmanifest",
  "/icon-192.png",
  "/icon-512.png",
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches
      .open(CACHE)
      .then((cache) => cache.addAll(SHELL))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(keys.filter((key) => key !== CACHE).map((key) => caches.delete(key)))
      )
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (event) => {
  const { request } = event;
  if (request.method !== "GET") return; // share target and API posts: untouched
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;
  if (url.pathname.startsWith("/api/")) return; // checks are always live

  event.respondWith(
    fetch(request)
      .then((response) => {
        if (response && response.ok && SHELL.includes(url.pathname)) {
          const copy = response.clone();
          caches.open(CACHE).then((cache) => cache.put(request, copy));
        }
        return response;
      })
      .catch(() =>
        caches.match(request).then((cached) => {
          if (cached) return cached;
          if (request.mode === "navigate") return caches.match("/");
          throw new Error("Offline and not cached.");
        })
      )
  );
});

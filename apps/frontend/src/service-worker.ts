/// <reference types="@sveltejs/kit" />
/// <reference lib="webworker" />

/**
 * The app shell cache and the Web Push handlers. The shell is the hashed
 * build assets plus the landing page; API and media requests always go to the
 * network, so data is never served stale.
 */

import { immutable } from "$app/manifest";
import { version } from "$app/env";

const sw = self as unknown as ServiceWorkerGlobalScope;
const CACHE = `shell-${version}`;

// $app/manifest's `immutable` entries are {path} objects relative to the base.
const shell = immutable.map(({ path }) => `/${path}`);

sw.addEventListener("install", (event) => {
  event.waitUntil(
    caches
      .open(CACHE)
      .then((cache) => cache.addAll(["/", ...shell]))
      .then(() => sw.skipWaiting()),
  );
});

sw.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      const names = await caches.keys();
      await Promise.all(
        names
          .filter((name) => name !== CACHE)
          .map((name) => caches.delete(name)),
      );
      await sw.clients.claim();
    })(),
  );
});

sw.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);
  if (event.request.method !== "GET" || url.origin !== location.origin) return;
  if (url.pathname.startsWith("/api/") || url.pathname.startsWith("/media/")) {
    return;
  }

  // Pages load from the network and are never cached: a page's HTML can carry
  // a signed-in user's data, which must not replay for the next person on a
  // shared phone. Offline navigations get the public landing page.
  if (event.request.mode === "navigate") {
    event.respondWith(
      fetch(event.request).catch(
        async () => (await caches.match("/")) ?? Response.error(),
      ),
    );
    return;
  }

  // Build assets are content-hashed; a cache hit is exactly what was deployed.
  if (shell.includes(url.pathname)) {
    event.respondWith(
      caches.match(event.request).then(async (cached) => {
        if (cached) return cached;
        const response = await fetch(event.request);
        const cache = await caches.open(CACHE);
        await cache.put(event.request, response.clone());
        return response;
      }),
    );
  }
});

sw.addEventListener("push", (event) => {
  const data = event.data?.json() ?? {};
  event.waitUntil(
    sw.registration.showNotification(data.title ?? "VendeYa", {
      body: data.body ?? "",
      icon: "/icons/icon-192.png",
      data: { url: data.url ?? "/" },
    }),
  );
});

sw.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const url = event.notification.data?.url ?? "/";
  event.waitUntil(
    (async () => {
      const clients = await sw.clients.matchAll({
        type: "window",
        includeUncontrolled: true,
      });
      for (const client of clients) {
        await client.focus();
        return client.navigate(url);
      }
      return sw.clients.openWindow(url);
    })(),
  );
});

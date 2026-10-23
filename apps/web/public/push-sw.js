/* This worker handles notifications only; app requests always go to the network. */
self.addEventListener("install", () => self.skipWaiting());

function notificationUrl(value) {
  try {
    const url = new URL(typeof value === "string" ? value : "/", self.location.origin);
    if (
      (url.origin === self.location.origin ||
        (url.protocol === "https:" && /^https:\/\//i.test(value))) &&
      !url.username &&
      !url.password
    )
      return url;
  } catch {
    // Malformed payloads still lead back to the app.
  }
  return new URL("/", self.location.origin);
}

self.addEventListener("push", (event) => {
  event.waitUntil(
    (async () => {
      let payload;
      try {
        payload = event.data?.json();
      } catch {
        payload = null;
      }
      // Safari requires every push to display a notification, including with an open client.
      await self.registration.showNotification(payload?.title ?? "T3 Code", {
        body: payload?.body ?? "A thread needs your attention.",
        tag: payload?.tag ?? "t3-code",
        icon: "/apple-touch-icon.png",
        silent: payload?.silent === true,
        data: { url: notificationUrl(payload?.url).href },
      });
    })(),
  );
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  event.waitUntil(
    (async () => {
      const url = notificationUrl(event.notification.data?.url);
      if (url.origin !== self.location.origin) {
        await self.clients.openWindow(url.href);
        return;
      }
      const windows = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
      const existing = windows.find((client) => new URL(client.url).origin === url.origin);
      if (existing) {
        const navigated = await existing.navigate(url.href);
        await (navigated ?? existing).focus();
      } else await self.clients.openWindow(url.href);
    })(),
  );
});

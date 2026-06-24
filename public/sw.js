// Service worker — Web Push уведомления (звонки и сообщения)
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (e) => e.waitUntil(self.clients.claim()));

self.addEventListener("push", (event) => {
  let data = {};
  try { data = event.data.json(); } catch {}
  const isCall = data.kind === "call";
  const title = data.title || "Dialog";
  const opts = {
    body: data.body || "",
    icon: "/icon.svg",
    badge: "/icon.svg",
    tag: (isCall ? "call:" : "msg:") + (data.room || ""),
    renotify: true,
    requireInteraction: isCall,
    vibrate: isCall ? [300, 150, 300, 150, 300] : [120],
    data: { room: data.room || "", kind: data.kind || "msg" },
  };
  event.waitUntil(self.registration.showNotification(title, opts));
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const room = event.notification.data && event.notification.data.room;
  event.waitUntil((async () => {
    const all = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
    for (const c of all) {
      if ("focus" in c) { c.postMessage({ type: "open-room", room }); return c.focus(); }
    }
    if (self.clients.openWindow) return self.clients.openWindow("/" + (room ? "?room=" + encodeURIComponent(room) : ""));
  })());
});

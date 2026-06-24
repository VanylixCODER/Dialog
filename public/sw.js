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
    silent: false,
    vibrate: isCall ? [400, 200, 400, 200, 400, 200, 400] : [120],
    actions: isCall
      ? [{ action: "accept", title: "✅ Принять" }, { action: "decline", title: "✖ Отклонить" }]
      : [],
    data: { room: data.room || "", kind: data.kind || "msg" },
  };
  event.waitUntil((async () => {
    // если приложение открыто и видно — не дублируем (in-app поп-ап сам покажет)
    const cls = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
    if (!isCall && cls.some((c) => c.focused || c.visibilityState === "visible")) return;
    return self.registration.showNotification(title, opts);
  })());
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const data = event.notification.data || {};
  if (event.action === "decline") return; // просто закрыть
  const room = data.room || "";
  const autojoin = data.kind === "call";
  event.waitUntil((async () => {
    const all = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
    for (const c of all) {
      if ("focus" in c) { c.postMessage({ type: "open-room", room, autojoin }); return c.focus(); }
    }
    if (self.clients.openWindow) {
      const url = "/?room=" + encodeURIComponent(room) + (autojoin ? "&autojoin=1" : "");
      return self.clients.openWindow(url);
    }
  })());
});

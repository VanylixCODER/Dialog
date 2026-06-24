// Service worker — Web Push (звонки и сообщения), даже при закрытом приложении.
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (e) => e.waitUntil(self.clients.claim()));

self.addEventListener("push", (event) => {
  let data = {}; try { data = event.data.json(); } catch {}
  const isCall = data.kind === "call";
  const opts = {
    body: data.body || "", icon: "/icon.svg", badge: "/icon.svg",
    tag: (isCall ? "call:" : "msg:") + (data.room || ""), renotify: true,
    requireInteraction: isCall, vibrate: isCall ? [400, 200, 400, 200, 400] : [120],
    actions: isCall ? [{ action: "accept", title: "✅ Принять" }, { action: "decline", title: "✖ Отклонить" }] : [],
    data: { room: data.room || "", kind: data.kind || "msg" },
  };
  event.waitUntil((async () => {
    const cls = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
    if (!isCall && cls.some((c) => c.focused || c.visibilityState === "visible")) return; // не дублируем в фокусе
    return self.registration.showNotification(data.title || "Dialog", opts);
  })());
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  if (event.action === "decline") return;
  const d = event.notification.data || {}, autojoin = d.kind === "call";
  event.waitUntil((async () => {
    const all = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
    for (const c of all) if ("focus" in c) { c.postMessage({ type: "open-room", room: d.room, autojoin }); return c.focus(); }
    if (self.clients.openWindow) return self.clients.openWindow("/?room=" + encodeURIComponent(d.room || "") + (autojoin ? "&autojoin=1" : ""));
  })());
});

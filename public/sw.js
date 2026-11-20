// Service worker — Web Push (звонки и сообщения), даже при закрытом приложении.
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (e) => e.waitUntil(self.clients.claim()));

self.addEventListener("push", (event) => {
  let data = {}; try { data = event.data.json(); } catch {}
  const isCall = data.kind === "call";
  const opts = {
    body: data.body || "", icon: data.icon || "/src/lil_dialog.webp", badge: "/src/lil_dialog.webp",
    tag: (isCall ? "call:" : data.kind === "msg" || !data.kind ? "msg:" : data.kind + ":") + (data.room || data.title || ""), renotify: true,
    requireInteraction: isCall, vibrate: isCall ? [400, 200, 400, 200, 400] : [120],
    actions: isCall ? (/^ru/i.test(self.navigator.language || "") ? [{ action: "accept", title: "Принять" }, { action: "decline", title: "Отклонить" }] : [{ action: "accept", title: "Answer" }, { action: "decline", title: "Decline" }]) : [],
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
  const d = event.notification.data || {}, autojoin = d.kind === "call";
  if (event.action === "decline") { event.waitUntil(fetch("/api/call/decline", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ room: d.room }) }).catch(() => {})); return; }
  event.waitUntil((async () => {
    const all = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
    for (const c of all) if ("focus" in c) { c.postMessage({ type: "open-room", room: d.room, autojoin }); return c.focus(); }
    if (self.clients.openWindow) return self.clients.openWindow("/app?room=" + encodeURIComponent(d.room || "") + (autojoin ? "&autojoin=1" : ""));
  })());
});

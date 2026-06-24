import "dotenv/config";
import express from "express";
import { createServer as createHttp } from "http";
import { createServer as createHttps } from "https";
import { Server } from "socket.io";
import { fileURLToPath } from "url";
import { dirname, join } from "path";
import { readFileSync, existsSync } from "fs";
import { networkInterfaces } from "os";
import webpush from "web-push";
import { AccessToken } from "livekit-server-sdk";
import * as auth from "./auth.js";
import {
  initSchema, waitForDb, saveMessage, recentMessages, deleteMessage, editMessage, toggleReaction,
  createGroup, getUserGroups, isGroupMember, getGroupMembers, getGroup, leaveGroup,
  updateProfile, getAvatar, getProfileCard, getStatus, getUser,
  setRelation, removeRelation, getRelationsFull, getFriendLogins, areFriends, shareGroup, isBlockedBy,
  sendFriendRequest, acceptFriend, declineFriend, removeFriend,
  savePushSub, getPushSubs, deletePushSub,
} from "./db.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const HISTORY_LIMIT = 100;

// ---------- Web Push ----------
const VAPID_PUBLIC = process.env.VAPID_PUBLIC || "";
const VAPID_PRIVATE = process.env.VAPID_PRIVATE || "";
const pushOn = !!(VAPID_PUBLIC && VAPID_PRIVATE);
if (pushOn) webpush.setVapidDetails(process.env.VAPID_SUBJECT || "mailto:admin@dialog.app", VAPID_PUBLIC, VAPID_PRIVATE);
async function sendPush(login, payload) {
  if (!pushOn) return;
  try { // «не беспокоить» — не шлём уведомления
    const st = userStatus.has(login) ? userStatus.get(login) : await getStatus(login);
    if (st === "dnd") return;
  } catch {}
  let subs = [];
  try { subs = await getPushSubs(login); } catch { return; }
  const body = JSON.stringify(payload);
  await Promise.all(subs.map((s) =>
    webpush.sendNotification(s, body).catch((e) => { if (e.statusCode === 404 || e.statusCode === 410) deletePushSub(s.endpoint).catch(() => {}); })
  ));
}

// ---------- Express ----------
const app = express();
app.set("trust proxy", 1);
app.use(express.json({ limit: "30mb" }));

const keyPath = join(__dirname, "certs", "key.pem");
const certPath = join(__dirname, "certs", "cert.pem");
const useHttps = existsSync(keyPath) && existsSync(certPath);
const httpServer = useHttps
  ? createHttps({ key: readFileSync(keyPath), cert: readFileSync(certPath) }, app)
  : createHttp(app);

const io = new Server(httpServer, { maxHttpBufferSize: 30e6 });

// Digital Asset Links для TWA (express.static не отдаёт dotfiles по умолчанию)
app.get("/.well-known/assetlinks.json", (req, res) =>
  res.sendFile(join(__dirname, "public", ".well-known", "assetlinks.json"), (e) => { if (e) res.status(404).json([]); }));
app.use(express.static(join(__dirname, "public")));

const bearer = (req) => (req.headers.authorization || "").replace(/^Bearer\s+/i, "");
async function authUser(req) { return auth.userByToken(bearer(req)); }

// ---------- REST: аутентификация ----------
app.post("/api/register", async (req, res) => {
  try { const { login, name, password } = req.body; res.json(await auth.register(login, name, password)); }
  catch (e) { res.status(400).json({ error: e.message }); }
});
app.post("/api/login", async (req, res) => {
  try { const { login, password } = req.body; res.json(await auth.login(login, password)); }
  catch (e) { res.status(400).json({ error: e.message }); }
});
app.get("/api/me", async (req, res) => {
  const me = await authUser(req);
  if (!me) return res.status(401).json({ error: "unauth" });
  res.json({ profile: me });
});
app.post("/api/logout", async (req, res) => { await auth.logout(bearer(req)); res.json({ ok: true }); });

// ---------- REST: профиль ----------
app.post("/api/profile", async (req, res) => {
  try {
    const me = await authUser(req);
    if (!me) return res.status(401).json({ error: "unauth" });
    const { name, avatar, description, status } = req.body || {};
    const patch = {};
    if (typeof name === "string" && name.trim()) patch.name = name.trim().slice(0, 64);
    if (typeof avatar === "string") patch.avatar = avatar.slice(0, 3_000_000);
    if (typeof description === "string") patch.description = description.slice(0, 280);
    if (["online", "dnd", "invisible"].includes(status)) patch.status = status;
    await updateProfile(me.login, patch);
    if (patch.status) { userStatus.set(me.login, patch.status); broadcastPresence(me.login); }
    for (const tk of await import("./db.js").then((m) => m.tokensForLogin(me.login))) await import("./cache.js").then((c) => c.cacheDel("sess:" + tk));
    const card = await getProfileCard(me.login);
    res.json({ profile: { ...me, ...patch, ...card } });
  } catch (e) { console.error(e); res.status(500).json({ error: "server error" }); }
});
app.get("/api/profile/:login", async (req, res) => {
  const card = await getProfileCard(req.params.login.toLowerCase());
  if (!card) return res.status(404).json({ error: "not found" });
  res.json({ ...card, status: effectiveStatus(card.login) });
});
app.get("/api/avatar/:login", async (req, res) => {
  try {
    const dataUrl = await getAvatar(req.params.login.toLowerCase());
    if (!dataUrl) return res.status(404).end();
    const m = /^data:(.+?);base64,(.*)$/.exec(dataUrl);
    if (!m) return res.status(404).end();
    res.set("Content-Type", m[1]); res.set("Cache-Control", "public, max-age=60");
    res.send(Buffer.from(m[2], "base64"));
  } catch { res.status(500).end(); }
});
app.get("/api/user/:login", async (req, res) => {
  const u = await getUser(req.params.login.toLowerCase());
  if (!u) return res.status(404).json({ error: "not found" });
  res.json({ login: u.login, name: u.name });
});

// ---------- REST: группы ----------
app.get("/api/groups", async (req, res) => {
  const me = await authUser(req); if (!me) return res.status(401).json({ error: "unauth" });
  res.json({ groups: await getUserGroups(me.login) });
});
app.post("/api/groups", async (req, res) => {
  const me = await authUser(req); if (!me) return res.status(401).json({ error: "unauth" });
  const name = String(req.body.name || "").trim().slice(0, 64);
  if (!name) return res.status(400).json({ error: "no name" });
  const members = [];
  for (const raw of String(req.body.members || "").split(",")) {
    const l = raw.trim().toLowerCase(); if (l && (await getUser(l))) members.push(l);
  }
  const id = await createGroup(name, me.login, members);
  res.json({ id, name });
});
app.post("/api/groups/:id/leave", async (req, res) => {
  const me = await authUser(req); if (!me) return res.status(401).json({ error: "unauth" });
  await leaveGroup(req.params.id, me.login); res.json({ ok: true });
});

// ---------- REST: друзья / блокировки ----------
app.get("/api/relations", async (req, res) => {
  const me = await authUser(req); if (!me) return res.status(401).json({ error: "unauth" });
  res.json(await getRelationsFull(me.login));
});
app.post("/api/relations", async (req, res) => {
  const me = await authUser(req); if (!me) return res.status(401).json({ error: "unauth" });
  const target = String(req.body.target || "").toLowerCase();
  const action = req.body.action;
  if (!target || target === me.login) return res.status(400).json({ error: "bad target" });
  if (action === "block") { await setRelation(me.login, target, "block"); await removeFriend(me.login, target); }
  else if (action === "unblock") await removeRelation(me.login, target, "block");
  else return res.status(400).json({ error: "bad action" });
  res.json({ ok: true });
});
app.post("/api/friend", async (req, res) => {
  const me = await authUser(req); if (!me) return res.status(401).json({ error: "unauth" });
  const target = String(req.body.target || "").toLowerCase();
  const action = req.body.action;
  if (!target || target === me.login) return res.status(400).json({ error: "bad target" });
  if (action === "request") { if (!(await getUser(target))) return res.status(404).json({ error: "not found" }); await sendFriendRequest(me.login, target); }
  else if (action === "accept") await acceptFriend(me.login, target);
  else if (action === "decline") await declineFriend(me.login, target);
  else if (action === "remove") await removeFriend(me.login, target);
  else return res.status(400).json({ error: "bad action" });
  notifyUser(target, "relations-changed", {}); notifyUser(me.login, "relations-changed", {});
  res.json({ ok: true });
});

// ---------- REST: присутствие (батч) ----------
app.post("/api/presence", async (req, res) => {
  const me = await authUser(req); if (!me) return res.status(401).json({ error: "unauth" });
  const logins = Array.isArray(req.body.logins) ? req.body.logins.slice(0, 200) : [];
  const out = {};
  for (const l of logins) out[String(l).toLowerCase()] = effectiveStatus(String(l).toLowerCase());
  res.json(out);
});

// ---------- REST: ICE (STUN + TURN от Metered) ----------
let cachedIce = null, iceExp = 0;
app.get("/api/ice", async (req, res) => {
  if (cachedIce && Date.now() < iceExp) return res.json(cachedIce);
  let servers = [];
  const mk = process.env.METERED_API_KEY;
  if (mk) {
    try {
      const r = await fetch(`https://dialogs.metered.live/api/v1/turn/credentials?apiKey=${mk}`);
      const creds = await r.json();
      if (Array.isArray(creds)) {
        const stun = creds.find((c) => c.urls?.startsWith("stun:"));
        const udp = creds.find((c) => c.urls?.startsWith("turn:") && !c.urls.includes("transport=tcp"));
        const tls = creds.find((c) => c.urls?.startsWith("turns:"));
        [stun, udp, tls].forEach((c) => c && servers.push(c));
      }
    } catch (e) { console.error("metered", e.message); }
  }
  if (!servers.length) {
    servers = [{ urls: "stun:stun.l.google.com:19302" }];
    if (process.env.TURN_URL) servers.push({ urls: process.env.TURN_URL, username: process.env.TURN_USER || "", credential: process.env.TURN_PASS || "" });
  }
  cachedIce = { iceServers: servers }; iceExp = Date.now() + 3600e3;
  res.json(cachedIce);
});

// ---------- REST: GIPHY-прокси ----------
app.get("/api/gif", async (req, res) => {
  try {
    const me = await authUser(req); if (!me) return res.status(401).json({ error: "unauth" });
    const key = process.env.GIPHY_KEY || "";
    if (!key) return res.json({ results: [], nokey: true });
    const q = String(req.query.q || "").slice(0, 80);
    const offset = parseInt(req.query.offset) || 0;
    const url = q
      ? `https://api.giphy.com/v1/gifs/search?api_key=${key}&q=${encodeURIComponent(q)}&limit=24&offset=${offset}&rating=pg-13`
      : `https://api.giphy.com/v1/gifs/trending?api_key=${key}&limit=24&offset=${offset}&rating=pg-13`;
    const d = await (await fetch(url)).json();
    const results = (d.data || []).map((g) => ({ preview: g.images?.fixed_width_small?.url, url: g.images?.original?.url })).filter((x) => x.url && x.preview);
    res.json({ results });
  } catch (e) { console.error("gif", e.message); res.json({ results: [], error: true }); }
});

// ---------- REST: LiveKit (SFU) токен ----------
const LK_URL = process.env.LIVEKIT_URL || "";
const LK_KEY = process.env.LIVEKIT_API_KEY || "";
const LK_SECRET = process.env.LIVEKIT_API_SECRET || "";
const lkOn = !!(LK_URL && LK_KEY && LK_SECRET);
const lkRoom = (room) => "d_" + Buffer.from(room).toString("base64url"); // валидное имя комнаты для LiveKit
async function lkToken(login, name, room) {
  const at = new AccessToken(LK_KEY, LK_SECRET, { identity: login, name, ttl: "2h" });
  at.addGrant({ roomJoin: true, room: lkRoom(room), canPublish: true, canSubscribe: true });
  return at.toJwt();
}
app.get("/api/livekit/token", async (req, res) => {
  try {
    const me = await authUser(req); if (!me) return res.status(401).json({ error: "unauth" });
    if (!lkOn) return res.json({ enabled: false });
    const room = String(req.query.room || "");
    // доступ к приватным комнатам — как в join
    if (room.startsWith("@dm:")) { if (!room.slice(4).split("~").includes(me.login)) return res.status(403).json({ error: "no access" }); }
    else if (room.startsWith("@grp:")) { const g = room.slice(5); if (!/^\d+$/.test(g) || !(await isGroupMember(g, me.login))) return res.status(403).json({ error: "no access" }); }
    else return res.status(400).json({ error: "bad room" });
    res.json({ enabled: true, url: LK_URL, token: await lkToken(me.login, me.name, room) });
  } catch (e) { console.error("lk token", e.message); res.status(500).json({ error: "server error" }); }
});

// ---------- REST: Web Push ----------
app.get("/api/push/key", (req, res) => res.json({ key: pushOn ? VAPID_PUBLIC : "" }));
app.post("/api/push/subscribe", async (req, res) => {
  try {
    const me = await authUser(req); if (!me) return res.status(401).json({ error: "unauth" });
    if (!req.body || !req.body.endpoint) return res.status(400).json({ error: "bad sub" });
    await savePushSub(me.login, req.body); res.json({ ok: true });
  } catch (e) { console.error("push sub", e.message); res.status(500).json({ error: "server error" }); }
});

// ====================== Socket.IO ======================
const rooms = new Map();        // room -> Map(socketId -> {name, login})
const userSockets = new Map();  // login -> Set(socketId)
const socketRoom = new Map();   // socketId -> room
const userStatus = new Map();   // login -> 'online'|'dnd'|'invisible'
const callRooms = new Map();    // room -> Map(socketId -> {name, login}) — кто СЕЙЧАС в звонке
const getCall = (room) => { if (!callRooms.has(room)) callRooms.set(room, new Map()); return callRooms.get(room); };

const getPeers = (room) => { if (!rooms.has(room)) rooms.set(room, new Map()); return rooms.get(room); };
function addUserSocket(login, id) { if (!userSockets.has(login)) userSockets.set(login, new Set()); userSockets.get(login).add(id); }
function removeUserSocket(login, id) { const s = userSockets.get(login); if (s) { s.delete(id); if (!s.size) userSockets.delete(login); } }
function isUserInRoom(login, room) { const ids = userSockets.get(login); if (!ids) return false; for (const id of ids) if (socketRoom.get(id) === room) return true; return false; }
function notifyUser(login, event, data) { const ids = userSockets.get(login); if (ids) for (const id of ids) io.to(id).emit(event, data); }
function dmPartner(room, me) { if (!room.startsWith("@dm:")) return null; return room.slice(4).split("~").find((p) => p !== me) || null; }

function effectiveStatus(login) {
  if (!userSockets.has(login)) return "offline";
  const s = userStatus.get(login) || "online";
  return s === "invisible" ? "offline" : s;
}
async function broadcastPresence(login) {
  const status = effectiveStatus(login);
  let friends = []; try { friends = await getFriendLogins(login); } catch {}
  for (const f of friends) notifyUser(f, "presence", { login, status });
}

io.on("connection", (socket) => {
  let currentRoom = null, userLogin = null, userName = null;

  socket.on("identify", async ({ token }) => {
    const p = await auth.userByToken(token); if (!p) return;
    userLogin = p.login; userName = p.name;
    addUserSocket(userLogin, socket.id);
    if (!userStatus.has(userLogin)) { try { userStatus.set(userLogin, await getStatus(userLogin)); } catch {} }
    broadcastPresence(userLogin);
  });

  function doLeave() {
    if (!currentRoom) return;
    callLeave();
    const peers = rooms.get(currentRoom);
    if (peers) { peers.delete(socket.id); if (!peers.size) rooms.delete(currentRoom); }
    socket.leave(currentRoom);
    socket.to(currentRoom).emit("peer-left", { id: socket.id, name: userName });
    socketRoom.delete(socket.id);
    currentRoom = null;
  }

  socket.on("join", async ({ room, token }) => {
    const p = await auth.userByToken(token);
    if (!p) { socket.emit("auth-error", "Session expired"); return; }
    const newRoom = (room || "lobby").trim().slice(0, 64) || "lobby";
    // контроль доступа к приватным комнатам
    if (newRoom.startsWith("@dm:")) {
      if (!newRoom.slice(4).split("~").includes(p.login)) { socket.emit("auth-error", "No access"); return; }
    } else if (newRoom.startsWith("@grp:")) {
      const gid = newRoom.slice(5);
      if (!/^\d+$/.test(gid) || !(await isGroupMember(gid, p.login))) { socket.emit("auth-error", "No access"); return; }
    }
    if (currentRoom && currentRoom !== newRoom) doLeave();
    currentRoom = newRoom; socketRoom.set(socket.id, newRoom);
    userName = p.name; userLogin = p.login;
    addUserSocket(userLogin, socket.id);
    if (!userStatus.has(userLogin)) { try { userStatus.set(userLogin, await getStatus(userLogin)); } catch {} }

    const peers = getPeers(currentRoom);
    socket.join(currentRoom);
    peers.set(socket.id, { name: userName, login: userLogin });
    try { socket.emit("history", await recentMessages(currentRoom, HISTORY_LIMIT)); }
    catch (e) { console.error("history", e.message); socket.emit("history", []); }
    socket.emit("peers", [...peers.entries()].filter(([id]) => id !== socket.id).map(([id, v]) => ({ id, ...v })));
    socket.to(currentRoom).emit("peer-joined", { id: socket.id, name: userName, login: userLogin });
    broadcastPresence(userLogin);
  });

  socket.on("leave", () => doLeave());

  socket.on("message", async (msg) => {
    if (!currentRoom || !userLogin) return;
    const dmTo = dmPartner(currentRoom, userLogin);
    if (dmTo) { // гейтинг ЛС
      const allowed = (await areFriends(userLogin, dmTo)) || (await shareGroup(userLogin, dmTo));
      if (!allowed) {
        const status = await sendFriendRequest(userLogin, dmTo);
        socket.emit("dm-blocked", { partner: dmTo, status });
        notifyUser(dmTo, "relations-changed", {}); notifyUser(userLogin, "relations-changed", {});
        return;
      }
    }
    const payload = {
      from: socket.id, fromLogin: userLogin, name: userName, ts: Date.now(),
      type: msg.type, text: (msg.text || "").slice(0, 4000), media: msg.media || null, mediaName: (msg.mediaName || "").slice(0, 255),
    };
    try { payload.id = await saveMessage({ room: currentRoom, ...payload }); } catch (e) { console.error("saveMessage", e.message); }
    io.to(currentRoom).emit("message", payload);

    // ЛС-пинг + push (тем, кто не в этой комнате)
    let recips = [];
    if (dmTo) recips = [dmTo];
    else if (currentRoom.startsWith("@grp:")) { try { recips = await getGroupMembers(currentRoom.slice(5)); } catch {} }
    const preview = payload.type === "text" ? payload.text.slice(0, 120)
      : payload.type === "image" || payload.type === "gif" ? "🖼 Photo"
      : payload.type === "video" ? "🎬 Video" : payload.type === "audio" ? "🎤 Voice" : "Media";
    for (const login of recips) {
      if (login === userLogin) continue;
      notifyUser(login, "dm-ping", { room: currentRoom, fromLogin: userLogin, fromName: userName });
      if (!isUserInRoom(login, currentRoom)) sendPush(login, { kind: "msg", title: userName, body: preview, room: currentRoom });
    }
  });

  socket.on("typing", (isTyping) => { if (currentRoom) socket.to(currentRoom).emit("typing", { id: socket.id, name: userName, isTyping }); });

  socket.on("msg-delete", async ({ id }) => {
    if (!currentRoom || !userLogin) return;
    try { if (await deleteMessage(id, userLogin)) io.to(currentRoom).emit("msg-deleted", { id }); } catch (e) { console.error("del", e.message); }
  });
  socket.on("msg-edit", async ({ id, text }) => {
    if (!currentRoom || !userLogin) return;
    const t = String(text || "").trim().slice(0, 4000); if (!t) return;
    try { if (await editMessage(id, userLogin, t)) io.to(currentRoom).emit("msg-edited", { id, text: t }); } catch (e) { console.error("edit", e.message); }
  });
  socket.on("msg-react", async ({ id, emoji }) => {
    if (!currentRoom || !userLogin) return;
    const e = String(emoji || "").slice(0, 8); if (!e) return;
    try { const r = await toggleReaction(id, userLogin, e, currentRoom); if (r) io.to(currentRoom).emit("msg-reaction", { id, reactions: r.reactions }); } catch (err) { console.error("react", err.message); }
  });

  // ----- Звонок: только ringing (медиа — через LiveKit SFU) -----
  function callLeave() { if (!currentRoom) return; const c = callRooms.get(currentRoom); if (c) { c.delete(socket.id); if (!c.size) callRooms.delete(currentRoom); } }
  socket.on("call-join", async ({ title } = {}) => {
    if (!currentRoom || !userLogin) return;
    const c = getCall(currentRoom);
    const wasEmpty = c.size === 0;
    c.set(socket.id, { name: userName, login: userLogin });
    if (!wasEmpty) return; // звонок уже идёт — звонить не нужно
    const payload = { from: socket.id, name: userName, room: currentRoom, title: title || currentRoom };
    let recips = [];
    try {
      if (currentRoom.startsWith("@grp:")) recips = await getGroupMembers(currentRoom.slice(5));
      else if (currentRoom.startsWith("@dm:")) recips = currentRoom.slice(4).split("~");
    } catch {}
    for (const login of recips) {
      if (login === userLogin) continue;
      notifyUser(login, "call-ring", payload);
      sendPush(login, { kind: "call", title: "📞 " + userName, body: payload.title, room: currentRoom });
    }
  });
  socket.on("call-leave", () => callLeave());

  socket.on("set-status", async (status) => {
    if (!userLogin || !["online", "dnd", "invisible"].includes(status)) return;
    userStatus.set(userLogin, status);
    try { await updateProfile(userLogin, { status }); } catch {}
    broadcastPresence(userLogin);
  });

  socket.on("disconnect", () => {
    doLeave();
    if (userLogin) { removeUserSocket(userLogin, socket.id); if (!userSockets.has(userLogin)) broadcastPresence(userLogin); }
  });
});

// ---------- Старт ----------
async function start() {
  await waitForDb(); await initSchema(); console.log("MySQL подключён, схема готова");
  const PORT = Number(process.env.PORT || 3000);
  httpServer.listen(PORT, () => {
    console.log(`Dialog запущен (${useHttps ? "HTTPS" : "HTTP"})  порт ${PORT}`);
    const proto = useHttps ? "https" : "http";
    console.log(`  Локально: ${proto}://localhost:${PORT}`);
    for (const ifaces of Object.values(networkInterfaces()))
      for (const i of ifaces) if (i.family === "IPv4" && !i.internal) console.log(`  По сети:  ${proto}://${i.address}:${PORT}`);
  });
}
start().catch((e) => { console.error("Старт не удался:", e.message); process.exit(1); });

import "dotenv/config";
import express from "express";
import { createServer as createHttpServer } from "http";
import { createServer as createHttpsServer } from "https";
import { Server } from "socket.io";
import { fileURLToPath } from "url";
import { dirname, join } from "path";
import { readFileSync, existsSync } from "fs";
import { networkInterfaces } from "os";
import * as auth from "./auth.js";
import { initSchema, waitForDb, saveMessage, recentMessages, createGroup, getUserGroups, isGroupMember, getGroupMembers, updateProfile, getAvatar, tokensForLogin, setRelation, removeRelation, getRelations, getRelationsFull, areFriends, shareGroup, acceptFriend, declineFriend, removeFriend, sendFriendRequest, clearRequests, leaveGroup, getProfileCard, getStatus, getFriendLogins } from "./db.js";
import { cacheDel } from "./cache.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

const app = express();
app.set("trust proxy", 1); // за обратным прокси хостинга (Render и т.п.)
app.use(express.json({ limit: "1mb" }));

// HTTPS, если есть сертификаты (нужно для камеры/экрана по сети), иначе HTTP.
const keyPath = join(__dirname, "certs", "key.pem");
const certPath = join(__dirname, "certs", "cert.pem");
const useHttps = existsSync(keyPath) && existsSync(certPath);

const httpServer = useHttps
  ? createHttpsServer({ key: readFileSync(keyPath), cert: readFileSync(certPath) }, app)
  : createHttpServer(app);

// Поднимаем лимит payload: фото/видео/гифки летят как data-URL по сокету.
const io = new Server(httpServer, { maxHttpBufferSize: 25e6 });

app.use(express.static(join(__dirname, "public")));

// --- API аутентификации ---
app.post("/api/register", async (req, res) => {
  try {
    const result = await auth.register(req.body || {});
    res.status(result.error ? 400 : 200).json(result);
  } catch (e) { console.error(e); res.status(500).json({ error: "Ошибка сервера" }); }
});
app.post("/api/login", async (req, res) => {
  try {
    const result = await auth.login(req.body || {});
    res.status(result.error ? 401 : 200).json(result);
  } catch (e) { console.error(e); res.status(500).json({ error: "Ошибка сервера" }); }
});
app.get("/api/me", async (req, res) => {
  try {
    const token = (req.headers.authorization || "").replace(/^Bearer\s+/i, "");
    const profile = await auth.userByToken(token);
    if (!profile) return res.status(401).json({ error: "Не авторизован" });
    res.json({ profile });
  } catch (e) { console.error(e); res.status(500).json({ error: "Ошибка сервера" }); }
});

// Пользователь по token из заголовка
async function authUser(req) {
  const token = (req.headers.authorization || "").replace(/^Bearer\s+/i, "");
  return auth.userByToken(token);
}

// Поиск пользователя по нику (для ЛС)
app.get("/api/user/:login", async (req, res) => {
  try {
    const me = await authUser(req);
    if (!me) return res.status(401).json({ error: "unauth" });
    const u = await auth.getUserByLogin(req.params.login);
    if (!u) return res.status(404).json({ error: "not found" });
    res.json({ login: u.login, name: u.name });
  } catch (e) { console.error(e); res.status(500).json({ error: "server error" }); }
});

// Список моих групп
app.get("/api/groups", async (req, res) => {
  try {
    const me = await authUser(req);
    if (!me) return res.status(401).json({ error: "unauth" });
    res.json({ groups: await getUserGroups(me.login) });
  } catch (e) { console.error(e); res.status(500).json({ error: "server error" }); }
});

// Обновить профиль (ник и/или аватар; логин менять нельзя)
app.post("/api/profile", async (req, res) => {
  try {
    const me = await authUser(req);
    if (!me) return res.status(401).json({ error: "unauth" });
    const { name, avatar, description, status } = req.body || {};
    if (typeof avatar === "string" && avatar.length > 400000) return res.status(400).json({ error: "avatar too large" });
    await updateProfile(me.login, { name, avatar, description, status });
    if (typeof status === "string") userStatus.set(me.login, status), broadcastPresence(me.login);
    // сбрасываем кэш профиля (имя кэшируется в сессии)
    try { for (const tk of await tokensForLogin(me.login)) await cacheDel("sess:" + tk); } catch {}
    const updated = await auth.getUserByLogin(me.login);
    res.json({ profile: updated });
  } catch (e) { console.error(e); res.status(500).json({ error: "server error" }); }
});

// Мини-профиль пользователя (имя, логин, описание, дата регистрации, статус)
app.get("/api/profile/:login", async (req, res) => {
  try {
    const me = await authUser(req);
    if (!me) return res.status(401).json({ error: "unauth" });
    const card = await getProfileCard((req.params.login || "").toLowerCase());
    if (!card) return res.status(404).json({ error: "not found" });
    res.json({ login: card.login, name: card.name, description: card.description || "", createdAt: card.created_at, status: effectiveStatus(card.login) });
  } catch (e) { console.error(e); res.status(500).json({ error: "server error" }); }
});
// Батч-статусы присутствия
app.get("/api/presence", async (req, res) => {
  try {
    const me = await authUser(req);
    if (!me) return res.status(401).json({ error: "unauth" });
    const ids = String(req.query.ids || "").split(",").map((s) => s.trim().toLowerCase()).filter(Boolean).slice(0, 200);
    const out = {};
    for (const l of ids) out[l] = effectiveStatus(l);
    res.json(out);
  } catch (e) { res.status(500).json({ error: "server error" }); }
});

// ICE (STUN + TURN) — клиент получает конфиг при загрузке
// METERED_API_KEY — бесплатный ключ с metered.ca (500 MB/мес)
let cachedIce = null, iceExpiry = 0;
app.get("/api/ice", async (req, res) => {
  const now = Date.now();
  if (cachedIce && now < iceExpiry) return res.json(cachedIce);
  const meteredKey = process.env.METERED_API_KEY;
  const turnUrl = process.env.TURN_URL;
  const turnUser = process.env.TURN_USER;
  const turnPass = process.env.TURN_PASS;
  let servers = [];
  if (meteredKey) {
    try {
      const r = await fetch(`https://dialogs.metered.live/api/v1/turn/credentials?apiKey=${meteredKey}`);
      const creds = await r.json();
      if (Array.isArray(creds)) {
        const stun = creds.filter(c => c.urls?.startsWith("stun:"))[0];
        const turnTcp = creds.find(c => c.urls?.startsWith("turns:"));
        const turnUdp = creds.find(c => c.urls?.startsWith("turn:") && !c.urls.includes("transport=tcp"));
        if (stun) servers.push(stun);
        if (turnUdp) servers.push(turnUdp);
        if (turnTcp) servers.push(turnTcp);
      }
      console.log("Metered TURN:", servers.length, "servers");
    } catch (e) { console.error("metered", e.message); }
  }
  if (!servers.length) {
    servers.push({ urls: "stun:stun.l.google.com:19302" });
    if (turnUrl) {
      servers.push({ urls: turnUrl, username: turnUser || "", credential: turnPass || "" });
    }
  }
  cachedIce = { iceServers: servers };
  iceExpiry = now + 3600 * 1000;
  res.json(cachedIce);
});

// GIPHY — прокси (ключ на сервере, без CORS-проблем)
const GIPHY_KEY = process.env.GIPHY_KEY || "";
app.get("/api/gif", async (req, res) => {
  try {
    const me = await authUser(req);
    if (!me) return res.status(401).json({ error: "unauth" });
    if (!GIPHY_KEY) return res.json({ results: [], nokey: true });
    const q = String(req.query.q || "").slice(0, 80);
    const offset = parseInt(req.query.offset) || 0;
    const url = q
      ? `https://api.giphy.com/v1/gifs/search?api_key=${GIPHY_KEY}&q=${encodeURIComponent(q)}&limit=24&offset=${offset}&rating=pg-13&lang=en`
      : `https://api.giphy.com/v1/gifs/trending?api_key=${GIPHY_KEY}&limit=24&offset=${offset}&rating=pg-13`;
    const r = await fetch(url);
    const d = await r.json();
    const results = (d.data || []).map((g) => ({
      preview: g.images?.fixed_width_small?.url,
      url: g.images?.original?.url,
    })).filter((x) => x.url && x.preview);
    res.json({ results, next: offset + results.length });
  } catch (e) { console.error("gif", e.message); res.json({ results: [], error: true }); }
});

// Аватар пользователя (бинарно, чтобы работал <img src>)
app.get("/api/avatar/:login", async (req, res) => {
  try {
    const av = await getAvatar((req.params.login || "").toLowerCase());
    const m = av && /^data:(.+?);base64,(.+)$/.exec(av);
    if (!m) return res.status(404).end();
    res.set("Content-Type", m[1]);
    res.set("Cache-Control", "public, max-age=300");
    res.send(Buffer.from(m[2], "base64"));
  } catch (e) { res.status(500).end(); }
});

// Друзья / блокировки / заявки
app.get("/api/relations", async (req, res) => {
  try {
    const me = await authUser(req);
    if (!me) return res.status(401).json({ error: "unauth" });
    res.json(await getRelationsFull(me.login));
  } catch (e) { console.error(e); res.status(500).json({ error: "server error" }); }
});
// Заявки в друзья: request | accept | decline | remove
app.post("/api/friend", async (req, res) => {
  try {
    const me = await authUser(req);
    if (!me) return res.status(401).json({ error: "unauth" });
    const target = String(req.body.target || "").trim().toLowerCase();
    const action = req.body.action;
    if (!target || target === me.login) return res.status(400).json({ error: "bad target" });
    if (!(await auth.getUserByLogin(target))) return res.status(404).json({ error: "not found" });
    if (action === "request") await sendFriendRequest(me.login, target);
    else if (action === "accept") await acceptFriend(me.login, target);
    else if (action === "decline") await declineFriend(me.login, target);
    else if (action === "remove") await removeFriend(me.login, target);
    else return res.status(400).json({ error: "bad action" });
    notifyUser(target, "relations-changed", {}); // у собеседника обновятся заявки/друзья
    res.json(await getRelationsFull(me.login));
  } catch (e) { console.error(e); res.status(500).json({ error: "server error" }); }
});
// Блокировка
app.post("/api/relations", async (req, res) => {
  try {
    const me = await authUser(req);
    if (!me) return res.status(401).json({ error: "unauth" });
    const target = String(req.body.target || "").trim().toLowerCase();
    const action = req.body.action === "remove" ? "remove" : "add";
    if (!target || target === me.login) return res.status(400).json({ error: "bad target" });
    if (action === "add") { await setRelation(me.login, target, "block"); await removeFriend(me.login, target); await clearRequests(me.login, target); }
    else await removeRelation(me.login, target, "block");
    notifyUser(target, "relations-changed", {});
    res.json(await getRelationsFull(me.login));
  } catch (e) { console.error(e); res.status(500).json({ error: "server error" }); }
});
// Выйти из группы
app.post("/api/groups/:id/leave", async (req, res) => {
  try {
    const me = await authUser(req);
    if (!me) return res.status(401).json({ error: "unauth" });
    await leaveGroup(req.params.id, me.login);
    res.json({ ok: true });
  } catch (e) { console.error(e); res.status(500).json({ error: "server error" }); }
});

// Создать группу
app.post("/api/groups", async (req, res) => {
  try {
    const me = await authUser(req);
    if (!me) return res.status(401).json({ error: "unauth" });
    const name = (req.body.name || "").trim().slice(0, 64);
    const members = (req.body.members || []).map((s) => String(s).trim().toLowerCase()).filter(Boolean).slice(0, 50);
    if (!name) return res.status(400).json({ error: "Group name required" });
    const g = await createGroup(name, me.login, members);
    res.json(g);
  } catch (e) { console.error(e); res.status(500).json({ error: "server error" }); }
});

const HISTORY_LIMIT = 100;

// room -> Map(socketId -> { name }). Только онлайн-присутствие; история — в БД.
const rooms = new Map();
function getPeers(room) {
  if (!rooms.has(room)) rooms.set(room, new Map());
  return rooms.get(room);
}
function peersList(room) {
  const m = rooms.get(room);
  return m ? [...m.entries()].map(([id, info]) => ({ id, name: info.name, login: info.login })) : [];
}

// login -> Set(socketId): чтобы доставлять ЛС-пинги пользователю в любой комнате
const userSockets = new Map();
function addUserSocket(login, id) {
  if (!userSockets.has(login)) userSockets.set(login, new Set());
  userSockets.get(login).add(id);
}
function removeUserSocket(login, id) {
  const s = userSockets.get(login);
  if (s) { s.delete(id); if (s.size === 0) userSockets.delete(login); }
}
// Партнёр в ЛС-комнате вида "@dm:loginA~loginB"
function dmPartner(room, me) {
  if (!room.startsWith("@dm:")) return null;
  const parts = room.slice(4).split("~");
  return parts.find((p) => p !== me) || null;
}
// Отправить событие всем сокетам пользователя
function notifyUser(login, event, data) {
  const ids = userSockets.get(login);
  if (ids) for (const id of ids) io.to(id).emit(event, data);
}

// --- Присутствие (онлайн / dnd / offline) ---
const userStatus = new Map(); // login -> 'online'|'dnd'|'invisible' (предпочтение)
function effectiveStatus(login) {
  if (!userSockets.has(login)) return "offline";
  const s = userStatus.get(login) || "online";
  return s === "invisible" ? "offline" : s;
}
async function broadcastPresence(login) {
  const status = effectiveStatus(login);
  try {
    const friends = await getFriendLogins(login);
    for (const f of friends) notifyUser(f, "presence", { login, status });
  } catch {}
}

io.on("connection", (socket) => {
  let currentRoom = null;
  let userName = "Аноним";
  let userLogin = null;

  // Выход из текущей комнаты (с уведомлением остальных)
  function doLeave() {
    if (!currentRoom) return;
    const peers = rooms.get(currentRoom);
    if (peers) { peers.delete(socket.id); if (peers.size === 0) rooms.delete(currentRoom); }
    socket.leave(currentRoom);
    socket.to(currentRoom).emit("peer-left", { id: socket.id, name: userName });
    // системное «вышел из чата» убрано
    currentRoom = null;
  }

  socket.on("join", async ({ room, token }) => {
    const profile = await auth.userByToken(token);
    if (!profile) { socket.emit("auth-error", "Session expired, sign in again"); return; }

    const newRoom = (room || "lobby").trim().slice(0, 64) || "lobby";

    // Контроль доступа к приватным комнатам
    if (newRoom.startsWith("@dm:")) {
      const parts = newRoom.slice(4).split("~");
      if (!parts.includes(profile.login)) { socket.emit("auth-error", "No access to this DM"); return; }
    } else if (newRoom.startsWith("@grp:")) {
      const gid = newRoom.slice(5);
      if (!/^\d+$/.test(gid) || !(await isGroupMember(gid, profile.login))) {
        socket.emit("auth-error", "No access to this group"); return;
      }
    }

    if (currentRoom && currentRoom !== newRoom) doLeave(); // сменил комнату — выходим из старой

    currentRoom = newRoom;
    userName = profile.name; // имя берём из профиля — клиент не может его подделать
    userLogin = profile.login;
    addUserSocket(userLogin, socket.id);

    const peers = getPeers(currentRoom);
    socket.join(currentRoom);
    peers.set(socket.id, { name: userName, login: userLogin });

    try {
      socket.emit("history", await recentMessages(currentRoom, HISTORY_LIMIT));
    } catch (e) { console.error("history", e.message); socket.emit("history", []); }
    socket.emit("peers", peersList(currentRoom).filter((p) => p.id !== socket.id));

    socket.to(currentRoom).emit("peer-joined", { id: socket.id, name: userName, login: userLogin });
    // системное «вошёл в чат» убрано — не спамим при каждом открытии чата
  });

  // Регистрируем сокет глобально (по токену), чтобы звонки/пинги ловились
  // в любом месте приложения, даже если ни один чат ещё не открыт
  socket.on("identify", async ({ token }) => {
    const profile = await auth.userByToken(token);
    if (!profile) return;
    userLogin = profile.login;
    userName = profile.name;
    const wasOffline = !userSockets.has(userLogin);
    addUserSocket(userLogin, socket.id);
    if (!userStatus.has(userLogin)) { try { userStatus.set(userLogin, await getStatus(userLogin)); } catch {} }
    if (wasOffline) broadcastPresence(userLogin); // стал онлайн — сообщить друзьям
  });

  socket.on("set-status", async ({ status }) => {
    if (!userLogin || !["online", "dnd", "invisible"].includes(status)) return;
    userStatus.set(userLogin, status);
    try { await updateProfile(userLogin, { status }); } catch {}
    broadcastPresence(userLogin);
  });

  socket.on("leave", () => doLeave());

  socket.on("message", async (msg) => {
    if (!currentRoom || !userLogin) return;

    // Гейтинг ЛС: писать можно только друзьям или тем, с кем есть общая группа.
    // Иначе сообщение не идёт, а собеседнику уходит заявка в друзья.
    const dmTo = dmPartner(currentRoom, userLogin);
    if (dmTo) {
      const allowed = (await areFriends(userLogin, dmTo)) || (await shareGroup(userLogin, dmTo));
      if (!allowed) {
        const status = await sendFriendRequest(userLogin, dmTo);
        socket.emit("dm-blocked", { partner: dmTo, status });
        notifyUser(dmTo, "relations-changed", {});
        notifyUser(userLogin, "relations-changed", {});
        return;
      }
    }

    const payload = {
      from: socket.id,
      fromLogin: userLogin,
      name: userName,
      ts: Date.now(),
      type: msg.type,
      text: msg.text || "",
      media: msg.media || null,
      mediaName: msg.mediaName || "",
    };
    try {
      payload.id = await saveMessage({ room: currentRoom, ...payload });
    } catch (e) { console.error("saveMessage", e.message); }
    io.to(currentRoom).emit("message", payload);

    // ЛС: уведомляем партнёра, даже если он сейчас в другой комнате
    const partner = dmPartner(currentRoom, userLogin);
    if (partner) {
      const ids = userSockets.get(partner);
      if (ids) for (const id of ids) {
        if (id !== socket.id) io.to(id).emit("dm-ping", { room: currentRoom, fromLogin: userLogin, fromName: userName });
      }
    }
  });

  socket.on("typing", (isTyping) => {
    if (!currentRoom) return;
    socket.to(currentRoom).emit("typing", { id: socket.id, name: userName, isTyping });
  });

  // --- WebRTC сигналинг (mesh: всё адресно по socketId) ---
  socket.on("signal", ({ to, kind, data }) => {
    io.to(to).emit("signal", { from: socket.id, name: userName, kind, data });
  });
  // Демонстрация экрана: оповещаем комнату вкл/выкл (тайл-скрин у всех)
  socket.on("screen", ({ on }) => {
    if (currentRoom) socket.to(currentRoom).emit("screen", { from: socket.id, on: !!on });
  });
  socket.on("call-invite", async ({ title } = {}) => {
    if (!currentRoom) return;
    const payload = { from: socket.id, name: userName, room: currentRoom, title: title || currentRoom };
    // в самой комнате — для mesh-связи и тоста присутствующим
    socket.to(currentRoom).emit("call-invite", payload);
    // глобально — участникам группы / стороне ЛС, даже если они в другой комнате
    let recipients = [];
    try {
      if (currentRoom.startsWith("@grp:")) recipients = await getGroupMembers(currentRoom.slice(5));
      else if (currentRoom.startsWith("@dm:")) recipients = currentRoom.slice(4).split("~");
    } catch {}
    for (const login of recipients) {
      if (login === userLogin) continue;
      const ids = userSockets.get(login);
      if (ids) for (const id of ids) if (id !== socket.id) io.to(id).emit("call-ring", payload);
    }
  });

  socket.on("disconnect", () => {
    doLeave();
    if (userLogin) {
      removeUserSocket(userLogin, socket.id);
      if (!userSockets.has(userLogin)) broadcastPresence(userLogin); // ушёл оффлайн
    }
  });
});

const PORT = process.env.PORT || 3000;

async function start() {
  try {
    await waitForDb();
    await initSchema();
    console.log("MySQL подключён, схема готова");
  } catch (e) {
    console.error("Не удалось подключиться к MySQL:", e.message);
    console.error("Проверьте DATABASE_URL или запустите контейнер dialog-mysql.");
    process.exit(1);
  }

  httpServer.listen(PORT, "0.0.0.0", () => {
    const proto = useHttps ? "https" : "http";
    console.log(`Dialog запущен (${proto.toUpperCase()})`);
    console.log(`  Локально:  ${proto}://localhost:${PORT}`);
    for (const ifaces of Object.values(networkInterfaces())) {
      for (const i of ifaces || []) {
        if (i.family === "IPv4" && !i.internal) console.log(`  По сети:   ${proto}://${i.address}:${PORT}`);
      }
    }
    if (useHttps) console.log("  (самоподписанный сертификат — браузер предупредит, нажмите «всё равно перейти»)");
  });
}
start();

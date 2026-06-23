import express from "express";
import { createServer as createHttpServer } from "http";
import { createServer as createHttpsServer } from "https";
import { Server } from "socket.io";
import { fileURLToPath } from "url";
import { dirname, join } from "path";
import { readFileSync, existsSync } from "fs";
import { networkInterfaces } from "os";
import * as auth from "./auth.js";
import { initSchema, waitForDb, saveMessage, recentMessages } from "./db.js";

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
    io.to(currentRoom).emit("system", { key: "left", name: userName });
    currentRoom = null;
  }

  socket.on("join", async ({ room, token }) => {
    const profile = await auth.userByToken(token);
    if (!profile) { socket.emit("auth-error", "Session expired, sign in again"); return; }

    const newRoom = (room || "lobby").trim().slice(0, 32) || "lobby";
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
    io.to(currentRoom).emit("system", { key: "joined", name: userName });
  });

  socket.on("leave", () => doLeave());

  socket.on("message", async (msg) => {
    if (!currentRoom || !userLogin) return;
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
  socket.on("call-invite", () => {
    if (!currentRoom) return;
    socket.to(currentRoom).emit("call-invite", { from: socket.id, name: userName });
  });

  socket.on("disconnect", () => { doLeave(); if (userLogin) removeUserSocket(userLogin, socket.id); });
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

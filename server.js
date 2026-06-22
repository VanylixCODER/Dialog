import express from "express";
import { createServer as createHttpServer } from "http";
import { createServer as createHttpsServer } from "https";
import { Server } from "socket.io";
import { fileURLToPath } from "url";
import { dirname, join } from "path";
import { readFileSync, existsSync } from "fs";
import { networkInterfaces } from "os";
import * as auth from "./auth.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

const app = express();
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
app.post("/api/register", (req, res) => {
  const result = auth.register(req.body || {});
  res.status(result.error ? 400 : 200).json(result);
});
app.post("/api/login", (req, res) => {
  const result = auth.login(req.body || {});
  res.status(result.error ? 401 : 200).json(result);
});
app.get("/api/me", (req, res) => {
  const token = (req.headers.authorization || "").replace(/^Bearer\s+/i, "");
  const profile = auth.userByToken(token);
  if (!profile) return res.status(401).json({ error: "Не авторизован" });
  res.json({ profile });
});

// room -> { peers: Map(socketId -> {name}), history: [msg, ...] }
const rooms = new Map();
const HISTORY_LIMIT = 100;

function getRoom(room) {
  if (!rooms.has(room)) rooms.set(room, { peers: new Map(), history: [] });
  return rooms.get(room);
}
function peersList(room) {
  const r = rooms.get(room);
  if (!r) return [];
  return [...r.peers.entries()].map(([id, info]) => ({ id, name: info.name }));
}

io.on("connection", (socket) => {
  let currentRoom = null;
  let userName = "Аноним";

  socket.on("join", ({ room, token }) => {
    const profile = auth.userByToken(token);
    if (!profile) { socket.emit("auth-error", "Сессия истекла, войдите заново"); return; }

    currentRoom = (room || "lobby").trim().slice(0, 32) || "lobby";
    userName = profile.name; // имя берём из профиля — клиент не может его подделать

    const r = getRoom(currentRoom);
    socket.join(currentRoom);
    r.peers.set(socket.id, { name: userName });

    // Отдаём новичку историю переписки и список участников
    socket.emit("history", r.history);
    socket.emit("peers", peersList(currentRoom).filter((p) => p.id !== socket.id));

    socket.to(currentRoom).emit("peer-joined", { id: socket.id, name: userName });
    io.to(currentRoom).emit("system", `${userName} вошёл в чат`);
  });

  socket.on("message", (msg) => {
    if (!currentRoom) return;
    const payload = {
      id: crypto.randomUUID(),
      from: socket.id,
      name: userName,
      ts: Date.now(),
      type: msg.type,
      text: msg.text || "",
      media: msg.media || null,
      mediaName: msg.mediaName || "",
    };
    const r = getRoom(currentRoom);
    r.history.push(payload);
    if (r.history.length > HISTORY_LIMIT) r.history.shift();
    io.to(currentRoom).emit("message", payload);
  });

  socket.on("typing", (isTyping) => {
    if (!currentRoom) return;
    socket.to(currentRoom).emit("typing", { id: socket.id, name: userName, isTyping });
  });

  // --- WebRTC сигналинг (mesh: всё адресно по socketId) ---
  socket.on("signal", ({ to, kind, data }) => {
    io.to(to).emit("signal", { from: socket.id, name: userName, kind, data });
  });
  // Запрос на групповой звонок: оповещаем комнату, что звонок начат/идёт
  socket.on("call-invite", () => {
    if (!currentRoom) return;
    socket.to(currentRoom).emit("call-invite", { from: socket.id, name: userName });
  });

  socket.on("disconnect", () => {
    if (currentRoom && rooms.has(currentRoom)) {
      const r = rooms.get(currentRoom);
      r.peers.delete(socket.id);
      socket.to(currentRoom).emit("peer-left", { id: socket.id, name: userName });
      io.to(currentRoom).emit("system", `${userName} вышел из чата`);
      if (r.peers.size === 0) rooms.delete(currentRoom);
    }
  });
});

const PORT = process.env.PORT || 3000;
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

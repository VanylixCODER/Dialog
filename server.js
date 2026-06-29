// =====================================================================
// REQUIRED ENVIRONMENT VARIABLES (read this before deploying!)
// ---------------------------------------------------------------------
// When DB_HOST is set, you MUST also set DB_PORT — otherwise db.js silently
// defaults to port 4000 (its TiDB/Cloud-test fallback). With MySQL on 3306
// you will get ECONNREFUSED retries forever. Set DB_PORT=3306 explicitly.
//
// Also recommended when DB_HOST is set:
//   DB_USER     — sql user
//   DB_PASS     — sql password (use a secret manager; do NOT commit)
//   DB_NAME     — schema name
//   DB_SSL=true — for managed MySQL/TiDB
//   REDIS_HOST  — 127.0.0.1 in dev, your cache host in prod
//   DB_POOL     — connection-pool size (default 10)
//
// Examples:
//   Dev (local MySQL):   DB_HOST=127.0.0.1 DB_PORT=3306 DB_USER=dialog DB_PASS=dialog DB_NAME=dialog
//   Prod (managed/TLS):  DB_HOST=mysql.example.com DB_PORT=3306 DB_USER=app DB_PASS=*** DB_NAME=dialog DB_SSL=true
// =====================================================================
import "dotenv/config";
import express from "express";
import { createServer as createHttp } from "http";
import { createServer as createHttps } from "https";
import { Server } from "socket.io";
import { fileURLToPath } from "url";
import { dirname, join } from "path";
import { readFileSync, existsSync } from "fs";
import { exec } from "child_process";
import { networkInterfaces } from "os";
import crypto from "crypto";
import webpush from "web-push";
import { AccessToken } from "livekit-server-sdk";
import * as auth from "./auth.js";
import {
  initSchema, waitForDb, saveMessage, recentMessages, messagesBefore, deleteMessage, editMessage, toggleReaction,
  createGroup, getUserGroups, isGroupMember, getGroupMembers, getGroup, leaveGroup,
  isGroupOwner, getGroupAvatar, getGroupMembersDetailed, addGroupMembers, removeGroupMember, renameGroup, setGroupAvatar, setGroupOwner, deleteGroup,
  createGroupInvite, getGroupInvites, revokeGroupInvite, getInviteByHash, createPendingInvite, getGroupPending, deletePendingInvite,
  updateProfile, getAvatar, getProfileCard, getStatus, getUser,
  setRelation, removeRelation, getRelationsFull, getFriendLogins, areFriends, shareGroup, isBlockedBy,
  sendFriendRequest, acceptFriend, declineFriend, removeFriend,
  savePushSub, getPushSubs, deletePushSub,
  getRoomWatermarks, bumpWatermarks,
} from "./db.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const HISTORY_LIMIT = 50;
// Max file attachment size — must match the client composer cap and the JSON/Socket.IO HTTP limits
// above. Increasing here without bumping the buffer limits silently drops messages with socket.io's
// PayloadTooLarge error; bumping everything in lockstep is required. Value is shared so the push
// preview and the client-side alert stay in sync.
const MAX_FILE_SIZE_MB = 75;
const MAX_FILE_BYTES = MAX_FILE_SIZE_MB * 1024 * 1024;

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
// Client cap is MAX_FILE_SIZE_MB raw bytes, but base64 inflates by ~4/3;
// the JSON/Socket.IO buffer must fit the encoded payload. Compute from the raw limit.
const B64_BUFFER_MB = Math.ceil(MAX_FILE_BYTES * 4 / 3 / (1024 * 1024)) + 8; // +8 MB slack for JSON envelope
app.use(express.json({ limit: B64_BUFFER_MB + "mb" }));

const keyPath = join(__dirname, "certs", "key.pem");
const certPath = join(__dirname, "certs", "cert.pem");
const useHttps = existsSync(keyPath) && existsSync(certPath);
const httpServer = useHttps
  ? createHttps({ key: readFileSync(keyPath), cert: readFileSync(certPath) }, app)
  : createHttp(app);

const io = new Server(httpServer, { maxHttpBufferSize: B64_BUFFER_MB * 1024 * 1024 });

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
    if (typeof avatar === "string") patch.avatar = avatar.slice(0, 5_000_000);
    if (typeof description === "string") patch.description = description.slice(0, 280);
    if (["online", "dnd", "invisible"].includes(status)) patch.status = status;
    await updateProfile(me.login, patch);
    if (patch.status) { userStatus.set(me.login, patch.status); broadcastPresence(me.login); }
    // Broadcast name/avatar changes to friends and own devices in realtime
    if (patch.name || patch.avatar) {
      try {
        const friends = await getFriendLogins(me.login);
        const payload = { login: me.login, name: patch.name || me.name, avatarChanged: !!patch.avatar };
        for (const f of friends) notifyUser(f, "profile-updated", payload);
        notifyUser(me.login, "profile-updated", payload);
      } catch (e) { console.error("profile broadcast", e.message); }
    }
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
// 1×1 прозрачный PNG — отдаём при отсутствии аватара вместо 404, чтобы не сыпались ошибки в консоли
// у клиентов с большим списком чатов (каждый видимый собеседник без аватара иначе логирует ERR).
const TRANSPARENT_PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=", "base64");
const sendTransparent = (res) => { res.set("Content-Type", "image/png"); res.set("Cache-Control", "public, max-age=60"); res.send(TRANSPARENT_PNG); };
// Default PFP fallback chain: pfp.svg (when user drops the file) > lil_dialog.webp (mini-logo) > 1×1 transparent.
// Served as image/svg+xml so <img> in the browser renders it directly without a data-URL round-trip.
const PFP_DEFAULT_PATH  = join(__dirname, "public", "src", "pfp.svg");
const PFP_FALLBACK_PATH = join(__dirname, "public", "src", "lil_dialog.webp");
const sendPfpDefault = (res) => {
  res.set("Cache-Control", "public, max-age=60");
  if (existsSync(PFP_DEFAULT_PATH))  return res.type("image/svg+xml").sendFile(PFP_DEFAULT_PATH);
  if (existsSync(PFP_FALLBACK_PATH)) return res.type("image/webp").sendFile(PFP_FALLBACK_PATH);
  sendTransparent(res);
};
app.get("/api/avatar/:login", async (req, res) => {
  try {
    const dataUrl = await getAvatar(req.params.login.toLowerCase());
    if (!dataUrl) return sendPfpDefault(res);
    const m = /^data:(.+?);base64,(.*)$/.exec(dataUrl);
    if (!m) return sendPfpDefault(res);
    res.set("Content-Type", m[1]); res.set("Cache-Control", "public, max-age=60");
    res.send(Buffer.from(m[2], "base64"));
  } catch { sendPfpDefault(res); }
});
app.get("/api/group-avatar/:id", async (req, res) => {
  try {
    const dataUrl = await getGroupAvatar(req.params.id);
    if (!dataUrl) return sendPfpDefault(res);
    const m = /^data:(.+?);base64,(.*)$/.exec(dataUrl); if (!m) return sendPfpDefault(res);
    res.set("Content-Type", m[1]); res.set("Cache-Control", "public, max-age=60");
    res.send(Buffer.from(m[2], "base64"));
  } catch { sendPfpDefault(res); }
});
app.get("/api/user/:login", async (req, res) => {
  try {
    const u = await getUser(req.params.login.toLowerCase());
    if (!u) return res.status(404).json({ error: "not found" });
    res.json({ ok: true, login: u.login, name: u.name });
  } catch (e) { console.error("user get", e.message); res.status(500).json({ error: "server error" }); }
});
// Основные CRUD для групп: list / create / leave.
// ВАЖНО: эти маршруты идут ПЕРВЫМИ — Express сопоставляет по порядку объявления. Если поставить их после , GET /api/groups уйдёт в POST с :id='', а POST /api/groups/:id/leave может перепутаться.
// Клиент (app.js) вызывает вот эти три маршрута, но раньше сервер возвращал 404 — отсюда жалобы «группы сломались».

app.get("/api/groups", async (req, res) => {
  try {
    const me = await authUser(req); if (!me) return res.status(401).json({ error: "unauth" });
    res.json({ groups: await getUserGroups(me.login) });
  } catch (e) { console.error("group list", e.message); res.status(500).json({ error: "server error" }); }
});
app.get("/api/groups/:id", async (req, res) => {
  try {
    const me = await authUser(req); if (!me) return res.status(401).json({ error: "unauth" });
    const id = req.params.id;
    if (!/^\d+$/.test(id)) return res.status(400).json({ error: "bad id" });
    const g = await getGroup(id); if (!g) return res.status(404).json({ error: "not found" });
    const members = await getGroupMembersDetailed(id);
    res.json({ ok: true, id: g.id, name: g.name, owner: g.owner, members });
  } catch (e) { console.error("group get", e.message); res.status(500).json({ error: "server error" }); }
});
app.post("/api/groups", async (req, res) => {
  try {
    const me = await authUser(req); if (!me) return res.status(401).json({ error: "unauth" });
    const name = String(req.body?.name || "").trim();
    if (!name) return res.status(400).json({ error: "name required" });
    // Дублирруем name обрезкой и лимитом (VARCHAR(64) в schema), отбрасываем пустые.
    const cleanName = name.slice(0, 64);
    // members — comma-list (UI пикер может отправить несколько за раз). createGroup() сам добавляет owner
    // и дедупит INSERT IGNORE по (group_id,login) — дубли и owner-дубли безопасно.
    const memberList = [...new Set(String(req.body?.members || "").split(",").map((s) => s.trim().toLowerCase()).filter((l) => l && l !== me.login))];
    const id = await createGroup(cleanName, me.login, memberList);
    // Опциональный аватар: если передали — ставим отдельным UPDATE (не в createGroup, тот его не принимает). Лимит 3 MB как в rename/avatar верху.
    if (typeof req.body?.avatar === "string" && req.body.avatar) await setGroupAvatar(id, req.body.avatar.slice(0, 5_000_000));
    // Рассылаем group-updated всем новым участникам (включая овнера), чтобы их клиенты показали группу в списке чатов без ручного refetch.
    try { for (const l of await getGroupMembers(id)) notifyUser(l, "group-updated", { id }); } catch {}
    res.json({ ok: true, id, name: cleanName });
  } catch (e) { console.error("group create", e.message); res.status(500).json({ error: "server error" }); }
});
app.post("/api/groups/:id/leave", async (req, res) => {
  try {
    const me = await authUser(req); if (!me) return res.status(401).json({ error: "unauth" });
    const id = req.params.id;
    if (!/^\d+$/.test(id)) return res.status(400).json({ error: "bad id" });
    // Проверяем что группа вообще существует и пользователь её участник — иначе 404 вместо молчаливого 200.
    const g = await getGroup(id); if (!g) return res.status(404).json({ error: "not found" });
    if (!(await isGroupMember(id, me.login))) return res.status(404).json({ error: "not a member" });
    // Если уходит овнер — группа становится «безхозной». Мы не передаём владение автоматом (это большой UX-шок) — вместо этого: если овнер в группе один, автоматически удаляем группу; иначе просто выводим из group_members.
    const wasOwner = g.owner === me.login;
    const membersBefore = await getGroupMembers(id);
    const willDelete = wasOwner && membersBefore.length === 1;
    if (!willDelete) {
      saveSystemMessage("@grp:" + id, me.login, me.name, "leave", "");
    }
    await leaveGroup(id, me.login);
    if (willDelete) {
      // Одинокий участник — он же овнер; после leaveGroup() группа пуста, а сообщения в нёй орфаны. Проще всё удалить целиком.
      await deleteGroup(id);
      notifyUser(me.login, "group-deleted", { id });
    } else {
      // Если ушёл овнер и в группе остались люди — передаём владение первому по алфавиту
      // (getGroupMembersDetailed сортирует по u.name). Иначе chat_groups.owner останется указывать
      // на ушедшего, и все owner-only маршруты (rename/avatar/members/delete/pending) начнут 403'ить.
      if (wasOwner) {
        const remaining = await getGroupMembersDetailed(id);
        if (remaining.length) await setGroupOwner(id, remaining[0].login);
      }
      // Оповещаем оставшихся участников — они должны увидеть обновлённый список без этого юзера.
      try { for (const l of await getGroupMembers(id)) notifyUser(l, "group-updated", { id }); } catch {}
    }
    res.json({ ok: true });
  } catch (e) { console.error("group leave", e.message); res.status(500).json({ error: "server error" }); }
});

// Управление (только владелец): rename / avatar / add / remove / delete
async function notifyGroup(id, event, data) { try { for (const l of await getGroupMembers(id)) notifyUser(l, event, data); } catch {} }
app.post("/api/groups/:id", async (req, res) => {
  const me = await authUser(req); if (!me) return res.status(401).json({ error: "unauth" });
  const id = req.params.id;
  if (!(await isGroupOwner(id, me.login))) return res.status(403).json({ error: "not owner" });
  const { name, avatar } = req.body || {};
  if (typeof name === "string" && name.trim()) await renameGroup(id, name.trim().slice(0, 64));
  if (typeof avatar === "string") await setGroupAvatar(id, avatar.slice(0, 5_000_000));
  await notifyGroup(id, "group-updated", { id }); res.json({ ok: true });
});
app.post("/api/groups/:id/members", async (req, res) => {
  const me = await authUser(req); if (!me) return res.status(401).json({ error: "unauth" });
  const id = req.params.id;
  if (!(await isGroupOwner(id, me.login))) return res.status(403).json({ error: "not owner" });
  const room = "@grp:" + id;
  const before = await getGroupMembers(id);
  if (Array.isArray(req.body.add)) {
    const logins = req.body.add.map((l) => String(l).toLowerCase());
    await addGroupMembers(id, logins);
    for (const login of logins) {
      const u = await getUser(login);
      if (u) saveSystemMessage(room, login, u.name, "join", "");
    }
  }
  if (req.body.remove) {
    const login = String(req.body.remove).toLowerCase();
    const u = await getUser(login);
    await removeGroupMember(id, login);
    if (u) saveSystemMessage(room, login, u.name, "leave", "");
  }
  const after = await getGroupMembers(id);
  for (const l of new Set([...before, ...after])) notifyUser(l, "group-updated", { id });
  res.json({ ok: true });
});
app.delete("/api/groups/:id", async (req, res) => {
  const me = await authUser(req); if (!me) return res.status(401).json({ error: "unauth" });
  const id = req.params.id;
  if (!(await isGroupOwner(id, me.login))) return res.status(403).json({ error: "not owner" });
  const members = await getGroupMembers(id);
  await deleteGroup(id);
  for (const l of members) notifyUser(l, "group-deleted", { id });
  res.json({ ok: true });
});

// ---------- REST: приглашения в группу (invite-codes + suggestion queue) ----------
// Шарабельные коды. Все участники могут создать (любой код — входная точка в группу, можно расшарить).
// Приватный ключ: SHA-256 хеш кода хранится в БД; plaintext 22-символьный код отдаётся клиенту
// ОДИН РАЗ при создании (как пароль). Поиск при redeem — по UNIQUE(code_hash), O(log n).
function genInviteCode() {
  // 16 случайных байт в base64url (~22 символа без pad). Трим хвостовых '=' для URL-чистоты.
  return crypto.randomBytes(16).toString("base64url").replace(/=+$/, "").slice(0, 22);
}
function hashInviteCode(code) {
  // Lowercase trim — чтобы случайные leading/trailing spaces в pasted-коде не ломали lookup.
  return crypto.createHash("sha256").update(String(code || "").trim().toLowerCase()).digest("hex");
}
app.post("/api/groups/:id/invites", async (req, res) => {
  try {
    const me = await authUser(req); if (!me) return res.status(401).json({ error: "unauth" });
    const id = req.params.id;
    if (!/^\d+$/.test(id) || !(await isGroupMember(id, me.login))) return res.status(403).json({ error: "no access" });
    const code = genInviteCode();
    await createGroupInvite(id, me.login, hashInviteCode(code));
    // Овнеру И создателю — обоим полезно видеть новую точку входа в списке инвайтов. Создатель не
    // получит повторного socket-event потому что генерирует код в своём клиенте и сразу ре-фетчит,
    // но emit «на всякий случай» — для апдейта UI без ручного refetch.
    const g = await getGroup(id);
    if (g) notifyUser(g.owner, "invite-created", { id });
    notifyUser(me.login, "invite-created", { id });
    res.json({ ok: true, code, url: "/?invite=" + encodeURIComponent(code) });
  } catch (e) { console.error("invite create", e.message); res.status(500).json({ error: "server error" }); }
});
app.get("/api/groups/:id/invites", async (req, res) => {
  try {
    const me = await authUser(req); if (!me) return res.status(401).json({ error: "unauth" });
    const id = req.params.id;
    if (!/^\d+$/.test(id) || !(await isGroupMember(id, me.login))) return res.status(403).json({ error: "no access" });
    res.json({ invites: await getGroupInvites(id) });
  } catch (e) { console.error("invite list", e.message); res.status(500).json({ error: "server error" }); }
});
app.delete("/api/groups/:id/invites/:invId", async (req, res) => {
  try {
    const me = await authUser(req); if (!me) return res.status(401).json({ error: "unauth" });
    const id = req.params.id;
    if (!/^\d+$/.test(id)) return res.status(400).json({ error: "bad id" });
    const g = await getGroup(id); if (!g) return res.status(404).json({ error: "not found" });
    // Владелец ЛЮБОЙ код может отозвать; обычный участник — только свои (созданные им самим).
    const invId = parseInt(req.params.invId, 10);
    const all = await getGroupInvites(id);
    const target = all.find((x) => x.id === invId);
    if (!target) return res.status(404).json({ error: "not found" });
    if (g.owner !== me.login && target.creator_login !== me.login) return res.status(403).json({ error: "not allowed" });
    await revokeGroupInvite(invId);
    notifyGroup(id, "invites-changed", { id });
    res.json({ ok: true });
  } catch (e) { console.error("invite revoke", e.message); res.status(500).json({ error: "server error" }); }
});

// Redeem кода: неавторизованный получает {loginRequired:true} (клиент будит login + сохраняет код в
// sessionStorage). Авторизованный создаёт pending-invite (НЕ авто-join) — овнер должен approve.
app.post("/api/groups/redeem", async (req, res) => {
  try {
    const me = await authUser(req);
    if (!me) return res.json({ loginRequired: true });
    const code = String(req.body.code || "").trim();
    if (!code) return res.status(400).json({ error: "no code" });
    const inv = await getInviteByHash(hashInviteCode(code));
    if (!inv) return res.json({ ok: false, status: "invalid" });
    if (await isGroupMember(inv.group_id, me.login)) return res.json({ ok: true, status: "already", group: inv.group_id });
    const d = await createPendingInvite(inv.group_id, me.login, me.login);
    if (d.duplicate) return res.json({ ok: true, status: "duplicate", group: inv.group_id });
    const g = await getGroup(inv.group_id);
    if (g) notifyUser(g.owner, "pending-new", { id: inv.group_id, login: me.login, via: "code" });
    notifyUser(me.login, "pending-new", { id: inv.group_id, login: me.login, via: "code" });
    res.json({ ok: true, status: "pending", group: inv.group_id });
  } catch (e) { console.error("redeem", e.message); res.status(500).json({ error: "server error" }); }
});

// In-app suggestion (любой участник может предложить друга). Цель НЕ добавляется в группу сразу —
// заявка попадает в pending и ждёт одобрения овнера. target — comma-list: пикер в одном сабмите
// может отправить несколько логинов; невалидные/уже-участники/уже-pending молча пропускаются.
app.post("/api/groups/:id/suggest", async (req, res) => {
  try {
    const me = await authUser(req); if (!me) return res.status(401).json({ error: "unauth" });
    const id = req.params.id;
    if (!/^\d+$/.test(id) || !(await isGroupMember(id, me.login))) return res.status(403).json({ error: "no access" });
    const targets = [...new Set(String(req.body.target || "").split(",").map((s) => s.trim().toLowerCase()).filter(Boolean))]
      .filter((l) => l !== me.login);
    if (!targets.length) return res.status(400).json({ error: "bad target" });
    let created = 0;
    for (const target of targets) {
      if (!(await getUser(target))) continue;
      if (await isGroupMember(id, target)) continue;
      const d = await createPendingInvite(id, target, me.login);
      if (!d.duplicate) {
        created++;
        const g = await getGroup(id);
        if (g) notifyUser(g.owner, "pending-new", { id, login: target, by: me.login });
        notifyUser(target, "pending-new", { id, login: target, by: me.login });
      }
    }
    res.json({ ok: true, status: "pending", created });
  } catch (e) { console.error("suggest", e.message); res.status(500).json({ error: "server error" }); }
});

// Owner-only: список ожидающих заявок (для UI в settings → groups + для refresh после socket-event).
app.get("/api/groups/:id/pending", async (req, res) => {
  try {
    const me = await authUser(req); if (!me) return res.status(401).json({ error: "unauth" });
    const id = req.params.id;
    if (!/^\d+$/.test(id) || !(await isGroupOwner(id, me.login))) return res.status(403).json({ error: "not owner" });
    res.json({ pending: await getGroupPending(id) });
  } catch (e) { console.error("pending list", e.message); res.status(500).json({ error: "server error" }); }
});

// Owner-only: approve/decline. Сначала ВЕРИФИЦИРУЕМ что pid принадлежит именно группе :id
// (подбором из getGroupPending(id) — pid это глобальный PK, но матчим по id для подстраховки).
app.post("/api/groups/:id/pending/:pid", async (req, res) => {
  try {
    const me = await authUser(req); if (!me) return res.status(401).json({ error: "unauth" });
    const id = req.params.id;
    if (!/^\d+$/.test(id) || !(await isGroupOwner(id, me.login))) return res.status(403).json({ error: "not owner" });
    const pid = parseInt(req.params.pid, 10);
    const all = await getGroupPending(id);
    const pending = all.find((p) => p.id === pid);
    if (!pending) return res.status(404).json({ error: "not found" });
    const action = String(req.body.action || "");
    if (action !== "approve" && action !== "decline") return res.status(400).json({ error: "bad action" });
    await deletePendingInvite(pid);
    const gid = parseInt(id, 10);
    if (action === "approve") {
      await addGroupMembers(id, [pending.login]);
      const u = await getUser(pending.login);
      if (u) saveSystemMessage("@grp:" + id, pending.login, u.name, "join", "");
      // group-updated рассылается notifyGroup/include через addGroupMembers; pending-resolved уходит
      // целевому юзеру только. Ид — просто id (не дублируем как group, клиент использует p.id).
      notifyUser(pending.login, "pending-resolved", { id: gid, action: "approve" });
    } else {
      notifyUser(pending.login, "pending-resolved", { id: gid, action: "decline" });
    }
    res.json({ ok: true });
  } catch (e) { console.error("pending resolve", e.message); res.status(500).json({ error: "server error" }); }
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
  if (action === "block") { await setRelation(me.login, target, "block"); await removeFriend(me.login, target); notifyUser(target, "relations-changed", {}); }
  else if (action === "unblock") await removeRelation(me.login, target, "block");
  else return res.status(400).json({ error: "bad action" });
  notifyUser(me.login, "relations-changed", {});
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

// ---------- REST: Link preview (OpenGraph) ----------
const lpCache = new Map();
app.get("/api/link-preview", async (req, res) => {
  try {
    const me = await authUser(req); if (!me) return res.status(401).json({ error: "unauth" });
    const url = String(req.query.url || "");
    if (!/^https?:\/\//i.test(url)) return res.json({});
    if (/\/\/(localhost|127\.|0\.0\.0\.0|\[::1\]|192\.168\.|10\.|169\.254\.|172\.(1[6-9]|2\d|3[01])\.)/i.test(url)) return res.json({});
    if (lpCache.has(url)) return res.json(lpCache.get(url));
    const ctrl = new AbortController(); const tm = setTimeout(() => ctrl.abort(), 5000);
    let html = "";
    try {
      const r = await fetch(url, { signal: ctrl.signal, redirect: "follow", headers: { "User-Agent": "Mozilla/5.0 (compatible; DialogBot/1.0)" } });
      clearTimeout(tm);
      if (!(r.headers.get("content-type") || "").includes("text/html")) { lpCache.set(url, {}); return res.json({}); }
      html = Buffer.from((await r.arrayBuffer()).slice(0, 200000)).toString("utf8");
    } catch { clearTimeout(tm); return res.json({}); }
    const meta = (p) => { const m = html.match(new RegExp(`<meta[^>]+(?:property|name)=["']${p}["'][^>]+content=["']([^"']*)["']`, "i")) || html.match(new RegExp(`<meta[^>]+content=["']([^"']*)["'][^>]+(?:property|name)=["']${p}["']`, "i")); return m ? m[1] : ""; };
    const dec = (s) => (s || "").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#0?39;/g, "'");
    const title = dec(meta("og:title") || (html.match(/<title[^>]*>([^<]*)<\/title>/i) || [])[1] || "");
    const data = { site: dec(meta("og:site_name")) || new URL(url).hostname.replace(/^www\./, ""), title, description: dec(meta("og:description") || meta("description")).slice(0, 200), image: meta("og:image"), url };
    const out = (data.title || data.image) ? data : {};
    if (lpCache.size > 500) lpCache.clear();
    lpCache.set(url, out);
    res.json(out);
  } catch { res.json({}); }
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

// ---------- REST: Delete room messages (DM "delete for everyone") ----------
app.post("/api/room/:room/delete", async (req, res) => {
  try {
    const me = await authUser(req); if (!me) return res.status(401).json({ error: "unauth" });
    const room = req.params.room;
    if (!room.startsWith("@dm:")) return res.status(400).json({ error: "only DMs supported" });
    const parts = room.slice(4).split("~");
    if (!parts.includes(me.login)) return res.status(403).json({ error: "not a participant" });
    await deleteRoomMessages(room);
    const other = parts.find((l) => l !== me.login);
    if (other) notifyUser(other, "room-cleared", { room });
    res.json({ ok: true });
  } catch (e) { console.error("room delete", e.message); res.status(500).json({ error: "server error" }); }
});

// ---------- GitHub webhook (auto-deploy) ----------
app.post("/webhook", (req, res) => {
  const event = req.headers["x-github-event"];
  if (event !== "push") return res.json({ ok: true });
  res.status(202).json({ ok: true, status: "deploying" });
  const repo = process.env.HOST_REPO_PATH || "/repo";
  const gitSSH = `ssh -i /root/.ssh/id_ed25519 -o StrictHostKeyChecking=accept-new -o UserKnownHostsFile=/dev/null`;
  exec(`git config --global --add safe.directory ${repo} && cd ${repo} && git pull 2>&1 && docker compose -f docker-compose.prod.yml up -d --build 2>&1`,
    { timeout: 180000, env: { ...process.env, HOME: "/root", GIT_SSH_COMMAND: gitSSH } },
    (err, stdout) => {
      if (err) console.error("deploy:", stdout.slice(-400), err.message);
      else console.log("deploy ok:", stdout.slice(-300));
    }
  );
});

// ====================== Socket.IO ======================
const rooms = new Map();        // room -> Map(socketId -> {name, login})
const userSockets = new Map();  // login -> Set(socketId)
const socketRoom = new Map();   // socketId -> room
const userStatus = new Map();   // login -> 'online'|'dnd'|'invisible'
const callRooms = new Map();    // room -> Map(socketId -> {name, login}) — кто СЕЙЧАС в звонке
const callMeta = new Map();    // room -> { startTs, initiatorLogin, initiatorName, answered, ringTimer }
const getCall = (room) => { if (!callRooms.has(room)) callRooms.set(room, new Map()); return callRooms.get(room); };
function callStatePayload(room) {
  const c = callRooms.get(room);
  const logins = c ? [...new Set([...c.values()].map((v) => v.login))] : [];
  return { room, count: logins.length, logins };
}
function broadcastCallState(room) { io.to(room).emit("call-state", callStatePayload(room)); }
function fmtDuration(ms) {
  const sec = Math.floor(ms / 1000);
  const min = Math.floor(sec / 60);
  return min > 0 ? `${min}m ${sec % 60}s` : `${sec}s`;
}
async function saveSystemMessage(room, fromLogin, name, type, text) {
  const ts = Date.now();
  const payload = { room, fromLogin, name, ts, type, text: text || "", media: null, mediaName: null, localId: null };
  try {
    payload.id = await saveMessage({ ...payload });
  } catch (e) { console.error("saveSystemMessage", e.message); return; }
  if (!payload.id) return;
  io.to(room).emit("message", payload);
}

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

// ---------- Курсоры доставки/просмотра ----------
// В памяти держим свежий снимок по комнате — чтобы emit'ить дельту без запроса в БД.
const watermarks = new Map(); // room -> { login: {delivered, seen} }
async function getRoomWatermarkSnapshot(room) {
  let snap = watermarks.get(room);
  if (!snap) {
    try { snap = await getRoomWatermarks(room); } catch { snap = {}; }
    watermarks.set(room, snap);
  }
  return snap;
}
// Применить bump и emit'ить только тех, у кого курсор реально сдвинулся.
// Раньше каждый дубликат (напр. двойной «seen» с тем же maxId) рассылал watermark по всей комнате,
// хотя GREATEST ничего не менял — клиенты пересчитывали статусы впустую и дёргали DOM.
// snap[l] фиксируется только ПОСЛЕ успешной записи в БД: иначе при DB-сбое snap уже считал курсор
// продвинутым, и последующие идентичные бампы молча no-op'или — рассогласование с диском.
async function applyWatermarkBump(room, logins, { delivered, seen } = {}) {
  if (!logins || !logins.length) return;
  const snap = await getRoomWatermarkSnapshot(room);
  const advanced = [];
  const planned = {};
  for (const l of logins) {
    const w = snap[l] || { delivered: 0, seen: 0 };
    const curD = Number(w.delivered) || 0, curS = Number(w.seen) || 0;
    const wantD = delivered != null ? Number(delivered) : curD;
    const wantS = seen != null ? Number(seen) : curS;
    const willD = Math.max(curD, wantD), willS = Math.max(curS, wantS);
    if (willD <= curD && willS <= curS) continue; // GREATEST ничего реально не улучшит — пропускаем
    advanced.push(l);
    planned[l] = { delivered: willD, seen: willS };
  }
  if (!advanced.length) return;
  try {
    await bumpWatermarks(room, advanced, { delivered, seen });
  } catch (e) {
    console.error("watermark bump", e.message);
    return; // без коммита в snap и без broadcast — следующий bump с тем же id сможет попробовать снова
  }
  for (const l of advanced) snap[l] = planned[l];
  io.to(room).emit("watermark", { room, updates: advanced.map((l) => {
    const w = snap[l]; return { login: l, delivered: Number(w.delivered) || 0, seen: Number(w.seen) || 0 };
  }) });
}

const SERVER_REGION = process.env.SERVER_REGION || "local";

io.on("connection", (socket) => {
  let currentRoom = null, userLogin = null, userName = null;
  socket.emit("server-info", { region: SERVER_REGION });

  socket.on("latency", (cb) => { if (typeof cb === "function") cb(Date.now()); });

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
    socket.emit("call-state", callStatePayload(currentRoom)); // идёт ли тут звонок прямо сейчас
    // Снимок курсоров доставки/просмотра комнаты — чтобы клиент сразу показал,
    // какие из его сообщений уже доставлены / прочитаны собеседниками.
    try {
      const snap = await getRoomWatermarkSnapshot(currentRoom);
      socket.emit("watermark", { room: currentRoom, updates: Object.entries(snap).map(([login, w]) => ({ login, delivered: Number(w.delivered) || 0, seen: Number(w.seen) || 0 })) });
    } catch {}
    socket.to(currentRoom).emit("peer-joined", { id: socket.id, name: userName, login: userLogin });
    broadcastPresence(userLogin);
  });

  socket.on("leave", () => doLeave());

  socket.on("load-more", async ({ before }) => {
    if (!currentRoom || !userLogin) return;
    try {
      const msgs = await messagesBefore(currentRoom, before, 50);
      socket.emit("more-messages", { msgs, before });
    } catch (e) { console.error("load-more", e.message); }
  });

  socket.on("message", async (msg) => {
    if (!currentRoom || !userLogin) return;
    const dmTo = dmPartner(currentRoom, userLogin);
    if (dmTo) { // гейтинг ЛС
      if (await isBlockedBy(userLogin, dmTo)) { socket.emit("dm-blocked", { partner: dmTo, reason: "blocked_by_recipient" }); return; }
      if (await isBlockedBy(dmTo, userLogin)) { socket.emit("dm-blocked", { partner: dmTo, reason: "blocked_sender" }); return; }
      const allowed = (await areFriends(userLogin, dmTo)) || (await shareGroup(userLogin, dmTo));
      if (!allowed) {
        const status = await sendFriendRequest(userLogin, dmTo);
        socket.emit("dm-blocked", { partner: dmTo, status });
        notifyUser(dmTo, "relations-changed", {}); notifyUser(userLogin, "relations-changed", {});
        return;
      }
    }
    // Defense-in-depth: если клиент всё-таки послал media > 75 MB (по base64-строке; raw bytes ≈
    // ¾ от длины), аккуратно отказываем: текст сохраняем, файл просто не сохраняем, и кинем
    // отправителю локализованный toast через emit. Остальные участники ничего не увидят — без
    // шума в ленте "что это было". Заодно это страхует от случайного бампa `maxHttpBufferSize`
    // в одной из сред.
    let media = msg.media || null;
    let mediaName = (msg.mediaName || "").slice(0, 255);
    if (media) {
      // base64 упаковывает 3 байта → 4 символа. Точный raw ≈ length * 3 / 4. Используем тот же
      // лимит что и у клиента (75 MB), чтобы отправитель не получил false negative из-за недос-
      // татка в формуле.
      // Важно: data:…;base64, префикс не считается — его длина вычитается из media.length.
      const comma = media.indexOf(",");
      const b64len = comma >= 0 ? media.length - comma - 1 : media.length;
      const approxRawBytes = Math.floor(b64len * 3 / 4);
      if (approxRawBytes > MAX_FILE_BYTES) {
        socket.emit("file-rejected", { reason: "file_too_big", maxMb: MAX_FILE_SIZE_MB });
        media = null; mediaName = "";
      }
    }
    const payload = {
      from: socket.id, fromLogin: userLogin, name: userName, ts: Date.now(),
      type: media ? (msg.type || "file") : "text",
      text: media ? "" : (msg.text || "").slice(0, 4000),
      media, mediaName,
      localId: msg.localId || null,
    };
    try { payload.id = await saveMessage({ room: currentRoom, ...payload }); } catch (e) { console.error("saveMessage", e.message); }
    // Сообщаем только после успешного сохранения: если БД не приняла медиа (max_allowed_packet),
    // не шлём ни broadcast, ни ACK, и отправляем отправителю ошибку.
    if (!payload.id) {
      socket.emit("file-rejected", { reason: "save_failed" });
      return;
    }
    io.to(currentRoom).emit("message", payload);
    // Возвращаем автору ACK с id, чтобы клиент снял статус «отправляется».
    socket.emit("msg-ack", { localId: payload.localId, id: payload.id, room: currentRoom, ts: payload.ts });

    // ЛС-пинг + push (тем, кто не в этой комнате)
    let recips = [];
    if (dmTo) recips = [dmTo];
    else if (currentRoom.startsWith("@grp:")) { try { recips = await getGroupMembers(currentRoom.slice(5)); } catch {} }
    const preview = payload.type === "text" ? payload.text.slice(0, 120)
      : payload.type === "image" || payload.type === "gif" ? "🖼 Photo"
      : payload.type === "video" ? "🎬 Video"
      : payload.type === "audio" ? "🎤 Voice"
      : "📎 " + (payload.mediaName || "File");
    for (const login of recips) {
      if (login === userLogin) continue;
      notifyUser(login, "dm-ping", { room: currentRoom, fromLogin: userLogin, fromName: userName });
      if (!isUserInRoom(login, currentRoom)) sendPush(login, { kind: "msg", title: userName, body: preview, room: currentRoom });
    }
  });

  socket.on("typing", (isTyping) => { if (currentRoom) socket.to(currentRoom).emit("typing", { id: socket.id, name: userName, isTyping }); });
  // Курсоры доставки / просмотра
  // — delivery: получатель подтверждает, что сообщения долетели до его устройства.
  // — seen:     получатель подтверждает, что реально просмотрел переписку (чат открыт/сфокусирован).
  // Оба идёмпотентны (GREATEST) и обновляют «водяной знак» в БД, рассылая дельту в комнату.
  socket.on("delivery", ({ maxId } = {}) => {
    if (!currentRoom || !userLogin) return;
    const id = Number(maxId) | 0;
    if (id <= 0) return;
    applyWatermarkBump(currentRoom, [userLogin], { delivered: id }).catch((e) => console.error("delivery bump", e.message));
  });
  socket.on("seen", ({ maxId } = {}) => {
    if (!currentRoom || !userLogin) return;
    const id = Number(maxId) | 0;
    if (id <= 0) return;
    // «Просмотр» подразумевает доставку: доставка не может быть меньше просмотра.
    applyWatermarkBump(currentRoom, [userLogin], { seen: id, delivered: id }).catch((e) => console.error("seen bump", e.message));
  });

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
  function callLeave() {
    if (!currentRoom) return;
    const room = currentRoom;
    const c = callRooms.get(room);
    if (c) {
      c.delete(socket.id);
      if (!c.size) {
        callRooms.delete(room);
        const meta = callMeta.get(room);
        if (meta) {
          clearTimeout(meta.ringTimer);
          const dur = Date.now() - meta.startTs;
          if (meta.answered && dur > 2000) {
            saveSystemMessage(room, meta.initiatorLogin, meta.initiatorName, "call_ended", fmtDuration(dur));
          } else {
            saveSystemMessage(room, meta.initiatorLogin, meta.initiatorName, "call_missed", fmtDuration(dur));
          }
          callMeta.delete(room);
        }
      }
      broadcastCallState(room);
    }
  }
  socket.on("call-join", async ({ title } = {}) => {
    if (!currentRoom || !userLogin) return;
    const c = getCall(currentRoom);
    // Выкинуть старые сокеты того же пользователя (другая вкладка / устройство)
    for (const [sid, info] of c) {
      if (info.login === userLogin && sid !== socket.id) {
        io.to(sid).emit("call-replaced");
        c.delete(sid);
      }
    }
    const wasEmpty = c.size === 0;
    c.set(socket.id, { name: userName, login: userLogin });
    broadcastCallState(currentRoom);
    if (!wasEmpty) {
      // Другой участник присоединился — звонок отвечен
      const meta = callMeta.get(currentRoom);
      if (meta && !meta.answered) {
        const others = new Set([...c.values()].map((v) => v.login));
        others.delete(userLogin);
        if (others.size > 0) {
          meta.answered = true;
          clearTimeout(meta.ringTimer);
          meta.ringTimer = null;
        }
      }
      return;
    }
    // Если выкинули свой же старый сокет — не пересоздаём meta (таймер звонка уже идёт)
    if (callMeta.has(currentRoom)) return;
    // Первый участник — начинаем звонок и звоним остальным
    const room = currentRoom;
    callMeta.set(room, {
      startTs: Date.now(),
      initiatorLogin: userLogin,
      initiatorName: userName,
      answered: false,
      ringTimer: setTimeout(() => {
        const c2 = callRooms.get(room);
        const meta2 = callMeta.get(room);
        if (c2 && c2.size < 2 && meta2 && !meta2.answered) {
          io.to(room).emit("call-auto-end", { reason: "no_answer" });
          saveSystemMessage(room, meta2.initiatorLogin, meta2.initiatorName, "call_missed", fmtDuration(60000));
          c2.clear();
          callRooms.delete(room);
          callMeta.delete(room);
          broadcastCallState(room);
        }
      }, 60000)
    });
    saveSystemMessage(room, userLogin, userName, "call_started", "");
    const payload = { from: socket.id, name: userName, room, title: title || room };
    let recips = [];
    try {
      if (room.startsWith("@grp:")) recips = await getGroupMembers(room.slice(5));
      else if (room.startsWith("@dm:")) recips = room.slice(4).split("~");
    } catch {}
    for (const login of recips) {
      if (login === userLogin) continue;
      notifyUser(login, "call-ring", payload);
      sendPush(login, { kind: "call", title: "📞 " + userName, body: payload.title, room });
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

// SPA fallback — serve index.html for all non-API paths (needed for /en/@user, /ru/group/1, etc.)
app.get(/^\/(?!api\/|src\/|js\/|css\/|socket\.io\/)/, (req, res) => {
  res.sendFile(join(__dirname, "public", "index.html"));
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

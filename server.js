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
import { readFileSync, existsSync, mkdirSync, writeFileSync } from "fs";
import { statfs } from "fs/promises";
import { exec } from "child_process";
import { networkInterfaces, totalmem, freemem, loadavg, uptime as osUptime } from "os";
import crypto from "crypto";
import webpush from "web-push";
import { AccessToken } from "livekit-server-sdk";
import * as auth from "./auth.js";
import {
  initSchema, waitForDb, saveMessage, recentMessages, messagesBefore, deleteMessage, editMessage, editMessageMarkup, getMessageMeta, toggleReaction,
  createGroup, getUserGroups, isGroupMember, getGroupMembers, getGroup, leaveGroup, regenGroupHook,
  isGroupOwner, getGroupAvatar, getGroupMembersDetailed, addGroupMembers, removeGroupMember, renameGroup, setGroupAvatar, setGroupOwner, deleteGroup,
  createGroupInvite, getGroupInvites, revokeGroupInvite, getInviteByHash, createPendingInvite, getGroupPending, deletePendingInvite,
  updateProfile, getAvatar, getBanner, getProfileCard, getStatus, getUser, searchUsers,
  createBot, isBot, getBotByTokenHash, getBot, listBotsByOwner, countBotsByOwner, updateBot, setBotTokenHash, deleteBot,
  queueBotUpdate, getBotUpdates, deleteBotUpdatesBelow, pruneBotUpdates,
  setRelation, removeRelation, getRelationsFull, getFriendLogins, areFriends, shareGroup, isBlockedBy,
  sendFriendRequest, acceptFriend, declineFriend, removeFriend, cancelFriendRequest, haveMutualFriend, mutualFriends, mutualCounts,
  getPrefs, setPrefs, dmOpen, bumpInviteUse,
  getUserThemes, getTheme, saveTheme, deleteTheme, setThemePublished, countPublished, listWorkshop, incThemeInstalls, THEME_LIMITS,
  getUserDMs, saveUserDMs,
  getPinnedChats, savePinnedChats,
  savePushSub, getPushSubs, deletePushSub, saveFcmToken, getFcmTokens, deleteFcmToken,
  getRoomWatermarks, bumpWatermarks,
  getUserByEmail, setUserEmail, markEmailVerified, setNagDismissed,
  createEmailToken, getEmailToken, deleteEmailToken,
  adminListUsers, adminStats, setUserBanned, setUserName, setUserLastIp,
  isIpBanned, banIp, unbanIp, listBannedIps,
  createReport, listReports, getReport, resolveReport, countPendingReports,
  setUserReportBan, clearUserReport, setEmailWithStamp,
  messagesFrom, firstMessageIdAtOrAfter, searchMessages, pinMessage, getPinned, replySnippet,
  listSessions, deleteSessionOf, deleteOtherSessions, touchSession,
  setTotpSecret, enableTotp, disableTotp, getTotp,
  setGroupPublic, setBotPublic, listPublicGroups, listPublicBots,
  createScheduled, listScheduled, dueScheduled, markScheduledSent, deleteScheduled,
  exportAccount,
  createGroupAddRequest, listGroupAddRequests, getGroupAddRequest, deleteGroupAddRequest, deleteGroupAddRequestsFor,
  setUserBannedWithReason, getBanReason,
  getRichPresencePref, setRichPresencePref, listPresenceHidden, setPresenceHidden,
  SERVER_ROLE_LIMIT, createServer, getServer, getServerIcon, setServerIcon, updateServer, deleteServer,
  listUserServers, listPublicServers, isServerMember, joinServer, leaveServer, listServerMembers,
  listChannels, getChannel, createChannel, renameChannel, deleteChannel, autoChannelOf,
  listRoles, countRoles, createRole, updateRole, deleteRole, setMemberRole, memberPerms,
  setChannelRestrict, setChannelHook, getChannelByHook,
} from "./db.js";
import { sendVerifyEmail, sendResetEmail, sendWelcomeEmail, mailEnabled } from "./mail.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const HISTORY_LIMIT = 25; // one chunk — initial load + each scroll-up page
// Max file attachment size — must match the client composer cap and the JSON/Socket.IO HTTP limits
// above. Increasing here without bumping the buffer limits silently drops messages with socket.io's
// PayloadTooLarge error; bumping everything in lockstep is required. Value is shared so the push
// preview and the client-side alert stay in sync.
const MAX_FILE_SIZE_MB = 75;
const MAX_FILE_BYTES = MAX_FILE_SIZE_MB * 1024 * 1024;

// ---------- Log capture (admin panel: GET /api/admin/logs) ----------
// Keep the last N console lines in a ring buffer without losing normal stdout.
const LOG_RING = [];
const LOG_RING_MAX = 500;
function pushLog(level, args) {
  try {
    const line = args.map((a) => (typeof a === "string" ? a : (() => { try { return JSON.stringify(a); } catch { return String(a); } })())).join(" ");
    LOG_RING.push({ t: Date.now(), level, line: line.slice(0, 2000) });
    if (LOG_RING.length > LOG_RING_MAX) LOG_RING.shift();
  } catch {}
}
for (const level of ["log", "info", "warn", "error"]) {
  const orig = console[level].bind(console);
  console[level] = (...args) => { pushLog(level, args); orig(...args); };
}

// Last-resort resilience: a stray DB error or unhandled rejection must NEVER take the whole
// server down — a crash drops every Socket.IO connection and kills all in-progress calls.
// Log loudly and stay up. (An ER_DUP_ENTRY from a racing user_dms save was crash-looping us.)
process.on("unhandledRejection", (e) => console.error("unhandledRejection:", (e && e.stack) || (e && e.message) || e));
process.on("uncaughtException", (e) => console.error("uncaughtException:", (e && e.stack) || (e && e.message) || e));

// In-memory mirror of banned_ips (ip -> expires|null) so the gate stays synchronous.
const bannedIps = new Map();
// Normalize IPv4-mapped IPv6 (::ffff:1.2.3.4) down to the v4 form for consistent matching.
const normIp = (ip) => String(ip || "").replace(/^::ffff:/, "").trim();
// Synchronous ban check with expiry — lazily forgets a lapsed temporary IP ban.
function ipIsBanned(ip) {
  if (!bannedIps.has(ip)) return false;
  const exp = bannedIps.get(ip);
  if (exp != null && exp < Date.now()) { bannedIps.delete(ip); unbanIp(ip).catch(() => {}); return false; }
  return true;
}

// ---------- Web Push ----------
const VAPID_PUBLIC = process.env.VAPID_PUBLIC || "";
const VAPID_PRIVATE = process.env.VAPID_PRIVATE || "";
const pushOn = !!(VAPID_PUBLIC && VAPID_PRIVATE);
if (pushOn) webpush.setVapidDetails(process.env.VAPID_SUBJECT || "mailto:admin@dialog.app", VAPID_PUBLIC, VAPID_PRIVATE);
async function sendPush(login, payload) {
  try { // «не беспокоить» — не шлём уведомления
    const st = userStatus.has(login) ? userStatus.get(login) : await getStatus(login);
    if (st === "dnd") return;
  } catch {}
  // Web Push (browser / desktop) — VAPID.
  if (pushOn) {
    let subs = [];
    try { subs = await getPushSubs(login); } catch { subs = []; }
    const body = JSON.stringify(payload);
    await Promise.all(subs.map((s) =>
      webpush.sendNotification(s, body).catch((e) => { if (e.statusCode === 404 || e.statusCode === 410) deletePushSub(s.endpoint).catch(() => {}); })
    ));
  }
  // FCM (native Android app) — the WebView can't receive Web Push.
  sendFcm(login, payload).catch(() => {});
}

// ---------- FCM (Firebase Cloud Messaging, HTTP v1) ----------
// Service account JSON via env FCM_SA (raw JSON) or FCM_SA_PATH (file). Dependency-free:
// we mint the OAuth2 token by signing a JWT with the SA private key (RS256, node:crypto).
let fcmSA = null;
try {
  const raw = process.env.FCM_SA || (process.env.FCM_SA_PATH ? readFileSync(process.env.FCM_SA_PATH, "utf8") : "");
  if (raw) fcmSA = JSON.parse(raw);
} catch (e) { console.warn("FCM_SA parse failed:", e.message); }
const fcmOn = !!(fcmSA && fcmSA.client_email && fcmSA.private_key && fcmSA.project_id);
if (fcmOn) console.log("FCM push enabled for project", fcmSA.project_id);
let _fcmTok = null, _fcmTokExp = 0;
const b64url = (buf) => Buffer.from(buf).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
async function fcmAccessToken() {
  if (_fcmTok && Date.now() < _fcmTokExp - 60000) return _fcmTok;
  const now = Math.floor(Date.now() / 1000);
  const header = b64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const claim = b64url(JSON.stringify({
    iss: fcmSA.client_email, scope: "https://www.googleapis.com/auth/firebase.messaging",
    aud: "https://oauth2.googleapis.com/token", iat: now, exp: now + 3600,
  }));
  const sig = b64url(crypto.createSign("RSA-SHA256").update(header + "." + claim).sign(fcmSA.private_key));
  const jwt = `${header}.${claim}.${sig}`;
  const r = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion: jwt }),
  });
  const j = await r.json();
  if (!j.access_token) throw new Error("no fcm access_token");
  _fcmTok = j.access_token; _fcmTokExp = Date.now() + (j.expires_in || 3600) * 1000;
  return _fcmTok;
}
async function sendFcm(login, payload) {
  if (!fcmOn) return;
  let tokens = [];
  try { tokens = await getFcmTokens(login); } catch { return; }
  if (!tokens.length) return;
  let at; try { at = await fcmAccessToken(); } catch (e) { console.warn("fcm token", e.message); return; }
  const url = `https://fcm.googleapis.com/v1/projects/${fcmSA.project_id}/messages:send`;
  // Data-only message so the app renders it (fires even when backgrounded/killed).
  await Promise.all(tokens.map((tk) => fetch(url, {
    method: "POST", headers: { Authorization: "Bearer " + at, "Content-Type": "application/json" },
    body: JSON.stringify({ message: {
      token: tk, android: { priority: "high" },
      data: { kind: String(payload.kind || ""), title: String(payload.title || "Dialog"), body: String(payload.body || ""), room: String(payload.room || ""), icon: String(payload.icon || "") },
    } }),
  }).then((r) => { if (r.status === 404 || r.status === 400) deleteFcmToken(tk).catch(() => {}); }).catch(() => {})));
}

// ---------- Express ----------
const app = express();
app.set("trust proxy", 1);
// Client cap is MAX_FILE_SIZE_MB raw bytes, but base64 inflates by ~4/3;
// the JSON/Socket.IO buffer must fit the encoded payload. Compute from the raw limit.
const B64_BUFFER_MB = Math.ceil(MAX_FILE_BYTES * 4 / 3 / (1024 * 1024)) + 8; // +8 MB slack for JSON envelope
app.use(express.json({ limit: B64_BUFFER_MB + "mb" }));

// IP-ban gate — refuse everything from a banned IP (checked against the in-memory mirror).
app.use((req, res, next) => {
  if (ipIsBanned(normIp(req.ip))) return res.status(403).send("Your IP has been banned.");
  next();
});

const keyPath = join(__dirname, "certs", "key.pem");
const certPath = join(__dirname, "certs", "cert.pem");
const useHttps = existsSync(keyPath) && existsSync(certPath);
const httpServer = useHttps
  ? createHttps({ key: readFileSync(keyPath), cert: readFileSync(certPath) }, app)
  : createHttp(app);

const io = new Server(httpServer, { maxHttpBufferSize: B64_BUFFER_MB * 1024 * 1024 });

// The native apps (Electron desktop / Android WebView) must never see the
// marketing landing or downloads pages — they should stay in the chat. They
// send a recognizable User-Agent, so we bounce any such request to /login.
// This runs BEFORE express.static so it also catches /landing.html etc.
const isNativeApp = (req) =>
  /\b(Electron|DialogApp)\b/i.test(req.headers["user-agent"] || "");
const MARKETING_PATHS = new Set([
  "/", "/landing.html", "/download", "/downloads", "/download.html"
]);
app.use((req, res, next) => {
  if (isNativeApp(req) && MARKETING_PATHS.has(req.path)) {
    return res.redirect(302, "/login");
  }
  next();
});

// index:false so "/" is not auto-served as the SPA — the marketing landing
// page owns "/", the messenger SPA lives at /login and /{lang}/... routes.
app.use(express.static(join(__dirname, "public"), { index: false }));

// ---------- Uploaded media (files live on disk, NOT in MySQL) ----------
// A 75 MB attachment used to be stored as ~100 MB of base64 in messages.media and re-read in
// full on every history load. Now deliverMessage() writes the bytes once, keyed by content
// hash, and the row keeps a /uploads/<hash>.<ext> URL. Old data: rows still render as-is.
const UPLOAD_DIR = process.env.UPLOAD_DIR || join(__dirname, ".uploads");
try { mkdirSync(UPLOAD_DIR, { recursive: true }); } catch (e) { console.error("[uploads] mkdir", e.message); }
// Extension → what we're willing to hand back, and how. Anything not listed is served as an
// opaque download: never let user bytes come back as text/html or image/svg+xml, both of which
// execute script on our own origin.
const UPLOAD_TYPES = {
  png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif",
  webp: "image/webp", avif: "image/avif", bmp: "image/bmp",
  mp4: "video/mp4", webm: "video/webm", mov: "video/quicktime", mkv: "video/x-matroska",
  mp3: "audio/mpeg", ogg: "audio/ogg", oga: "audio/ogg", opus: "audio/ogg",
  wav: "audio/wav", m4a: "audio/mp4", weba: "audio/webm",
};
const MIME_EXT = {
  "image/png": "png", "image/jpeg": "jpg", "image/gif": "gif", "image/webp": "webp",
  "image/avif": "avif", "image/bmp": "bmp",
  "video/mp4": "mp4", "video/webm": "webm", "video/quicktime": "mov", "video/x-matroska": "mkv",
  "audio/mpeg": "mp3", "audio/ogg": "ogg", "audio/wav": "wav", "audio/x-wav": "wav",
  "audio/mp4": "m4a", "audio/webm": "weba", "audio/opus": "opus",
};
app.get("/uploads/:file", (req, res) => {
  const name = String(req.params.file || "");
  // Hash-derived names only — no traversal, no guessing at other people's paths.
  const m = /^([a-f0-9]{64})\.([a-z0-9]{1,5})$/.exec(name);
  if (!m) return res.status(404).end();
  const p = join(UPLOAD_DIR, name);
  if (!existsSync(p)) return res.status(404).end();
  const type = UPLOAD_TYPES[m[2]];
  res.setHeader("Content-Type", type || "application/octet-stream");
  if (!type) res.setHeader("Content-Disposition", "attachment");
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Content-Security-Policy", "default-src 'none'; sandbox");
  res.setHeader("Cache-Control", "public, max-age=31536000, immutable"); // content-addressed: never changes
  res.sendFile(p);
});
// Write a data: URL to disk and return its public URL. Returns the input unchanged for
// anything that isn't worth offloading (already a URL, or small enough that a file costs more
// than the row does). Never throws — a failed write just falls back to storing the data: URL.
const OFFLOAD_MIN_BYTES = 64 * 1024;
function offloadMedia(media) {
  try {
    if (typeof media !== "string" || !media.startsWith("data:")) return media;
    const comma = media.indexOf(",");
    if (comma < 0) return media;
    const header = media.slice(5, comma);
    if (!/;base64$/i.test(header)) return media;
    const mime = header.replace(/;base64$/i, "").toLowerCase().split(";")[0];
    const b64 = media.slice(comma + 1);
    if (Math.floor(b64.length * 3 / 4) < OFFLOAD_MIN_BYTES) return media;
    const buf = Buffer.from(b64, "base64");
    if (!buf.length) return media;
    const ext = MIME_EXT[mime] || "bin";
    const hash = crypto.createHash("sha256").update(buf).digest("hex");
    const file = `${hash}.${ext}`;
    const p = join(UPLOAD_DIR, file);
    if (!existsSync(p)) writeFileSync(p, buf);   // content-addressed → identical files dedupe
    return { media: "/uploads/" + file, size: buf.length };
  } catch (e) { console.error("[uploads] offload", e.message); return media; }
}
// Wrapper so callers get a uniform { media, size } no matter which branch ran.
function offloadResult(media) {
  const out = offloadMedia(media);
  if (out && typeof out === "object") return out;
  return { media: out, size: typeof out === "string" && out.startsWith("data:") ? Math.floor((out.length - out.indexOf(",") - 1) * 3 / 4) : 0 };
}

// Public marketing pages (must be registered before the SPA fallback below).
app.get("/", (_req, res) =>
  res.sendFile(join(__dirname, "public", "landing.html"))
);
app.get(["/download", "/downloads"], (_req, res) =>
  res.sendFile(join(__dirname, "public", "download.html"))
);
app.get(["/privacy", "/privacy-policy"], (_req, res) =>
  res.sendFile(join(__dirname, "public", "privacy.html"))
);
app.get(["/guidelines", "/dcg", "/rules"], (_req, res) =>
  res.sendFile(join(__dirname, "public", "guidelines.html"))
);
// Bot API documentation.
app.get(["/bots", "/bot-api", "/docs", "/api-docs"], (_req, res) =>
  res.sendFile(join(__dirname, "public", "bots.html"))
);
// Group-invite join page (a dedicated confirmation page, not the full app).
app.get(["/invite/:code", "/join/:code"], (_req, res) =>
  res.sendFile(join(__dirname, "public", "invite.html"))
);

const bearer = (req) => (req.headers.authorization || "").replace(/^Bearer\s+/i, "");
async function authUser(req) { return auth.userByToken(bearer(req)); }

// ---------- REST: аутентификация ----------
app.post("/api/register", async (req, res) => {
  try {
    const { login, name, password, email } = req.body;
    const out = await auth.register(login, name, password, email);
    setUserLastIp(out.profile.login, normIp(req.ip)).catch(() => {});
    const addr = String(email).trim().toLowerCase();
    // Fire-and-forget the verification + welcome emails (never block/break signup).
    sendVerification(out.profile.login, addr, out.profile.name).catch((e) => console.error("verify mail", e.message));
    sendWelcomeEmail(addr, out.profile.name).catch((e) => console.error("welcome mail", e.message));
    res.json(out);
  } catch (e) { res.status(400).json({ error: e.message }); }
});
app.post("/api/login", async (req, res) => {
  try {
    const { login, password, code } = req.body;
    // ua/ip are stamped on the session row so Settings → Account can list real devices.
    const out = await auth.login(login, password, code, { ua: req.headers["user-agent"], ip: normIp(req.ip) });
    setUserLastIp(out.profile.login, normIp(req.ip)).catch(() => {});
    res.json(out);
  } catch (e) { res.status(400).json({ error: e.message }); }
});
app.get("/api/me", async (req, res) => {
  const me = await authUser(req);
  if (!me) return res.status(401).json({ error: "unauth" });
  // One write per app load keeps the device list's "last active" honest without taxing
  // every authenticated request.
  touchSession(bearer(req)).catch(() => {});
  res.json({ profile: me });
});
app.post("/api/logout", async (req, res) => { await auth.logout(bearer(req)); res.json({ ok: true }); });

// ---------- Email verification + password reset ----------
const APP_ORIGIN = process.env.APP_URL || "https://dialogmsg.xyz";
const sha256 = (s) => crypto.createHash("sha256").update(s).digest("hex");
// Create a single-use token, store only its hash, return the raw token for the URL.
async function makeEmailToken(login, email, purpose, ttlMs) {
  const raw = crypto.randomBytes(32).toString("hex");
  await createEmailToken(sha256(raw), login, email, purpose, Date.now() + ttlMs);
  return raw;
}
async function sendVerification(login, email, name) {
  if (!email) return;
  const raw = await makeEmailToken(login, email, "verify", 24 * 3600 * 1000);
  await sendVerifyEmail(email, name || login, `${APP_ORIGIN}/verify?token=${raw}`);
}
// Consume a token: valid, unexpired, right purpose → returns the row, else null.
async function consumeToken(raw, purpose) {
  if (!raw) return null;
  const row = await getEmailToken(sha256(String(raw)));
  if (!row || row.purpose !== purpose) return null;
  await deleteEmailToken(row.token_hash);
  if (Number(row.expires) < Date.now()) return null;
  return row;
}
function htmlPage(title, heading, body, ok) {
  const color = ok ? "#2ec96b" : "#ff5252";
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title></head>
  <body style="margin:0;background:#050b06;color:#d6e6dc;font-family:-apple-system,Segoe UI,Roboto,Arial,sans-serif;display:grid;place-items:center;min-height:100vh">
    <div style="max-width:420px;text-align:center;padding:28px 24px;background:#0b140d;border:1px solid #1c3324;border-radius:16px">
      <div style="color:#2ec96b;font-weight:800;font-size:20px">Dialog</div>
      <h1 style="font-size:20px;margin:16px 0 6px;color:${color}">${heading}</h1>
      <p style="color:#a9c2b3;font-size:14px;line-height:1.5">${body}</p>
      <a href="${APP_ORIGIN}/login" style="display:inline-block;margin-top:18px;background:#2ec96b;color:#04180c;text-decoration:none;font-weight:700;padding:11px 22px;border-radius:10px">Open Dialog</a>
    </div>
  </body></html>`;
}

// Click-through from the verification email.
app.get("/verify", async (req, res) => {
  try {
    const row = await consumeToken(req.query.token, "verify");
    if (!row) return res.status(400).send(htmlPage("Verification", "Link expired or invalid", "Request a new verification email from Dialog settings.", false));
    // Only verify if the address still matches the account's current email.
    const u = await getUser(row.login);
    if (!u || (u.email || "").toLowerCase() !== row.email.toLowerCase()) return res.status(400).send(htmlPage("Verification", "Link no longer valid", "This email address has changed. Request a new verification email.", false));
    await markEmailVerified(row.login);
    for (const tk of await import("./db.js").then((m) => m.tokensForLogin(row.login))) await import("./cache.js").then((c) => c.cacheDel("sess:" + tk));
    res.send(htmlPage("Verified", "Email verified ✓", "Your email is confirmed. You can now recover your account if you ever lose access.", true));
  } catch (e) { console.error("verify", e.message); res.status(500).send(htmlPage("Verification", "Something went wrong", "Please try again later.", false)); }
});

// Reset-password page (standalone) — reached from the reset email link.
app.get("/reset", (req, res) => res.sendFile(join(__dirname, "public", "reset.html")));

// Add / change email from the app (nag modal, settings). Changing an existing
// address is rate-limited to once a week; first-time linking is always allowed.
const EMAIL_COOLDOWN_MS = 7 * 24 * 3600 * 1000;
app.post("/api/account/email", async (req, res) => {
  try {
    const me = await authUser(req); if (!me) return res.status(401).json({ error: "unauth" });
    const email = String(req.body.email || "").trim().toLowerCase();
    if (!auth.EMAIL_RE.test(email) || email.length > 190) return res.status(400).json({ error: "Введите корректный e-mail" });
    const u = await getUser(me.login);
    if (email === (u.email || "")) return res.status(400).json({ error: "same_email" });
    const last = Number(u.email_changed_at) || 0;
    if (u.email && last && Date.now() - last < EMAIL_COOLDOWN_MS) {
      return res.status(429).json({ error: "cooldown", retryAt: last + EMAIL_COOLDOWN_MS });
    }
    const taken = await getUserByEmail(email);
    if (taken && taken.login !== me.login) return res.status(400).json({ error: "E-mail уже используется" });
    await setEmailWithStamp(me.login, email);      // resets email_verified → 0, stamps time
    await setNagDismissed(me.login, false);
    for (const tk of await import("./db.js").then((m) => m.tokensForLogin(me.login))) await import("./cache.js").then((c) => c.cacheDel("sess:" + tk));
    await sendVerification(me.login, email, me.name);
    res.json({ ok: true, email, mailSent: mailEnabled(), retryAt: Date.now() + EMAIL_COOLDOWN_MS });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

// Change own display name (nickname) from the Account tab.
app.post("/api/account/nickname", async (req, res) => {
  try {
    const me = await authUser(req); if (!me) return res.status(401).json({ error: "unauth" });
    const name = String(req.body.name || "").trim().slice(0, 32);
    if (!name) return res.status(400).json({ error: "empty" });
    await setUserName(me.login, name);
    for (const tk of await import("./db.js").then((m) => m.tokensForLogin(me.login))) await import("./cache.js").then((c) => c.cacheDel("sess:" + tk));
    try {
      const friends = await getFriendLogins(me.login);
      for (const f of friends) notifyUser(f, "profile-updated", { login: me.login, name, avatarChanged: false });
      notifyUser(me.login, "profile-updated", { login: me.login, name, avatarChanged: false });
    } catch {}
    res.json({ ok: true, name });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

// ---------- Reports (moderation) ----------
// Report-reason codes double as the Dialog Community Guidelines (DCG) sections.
const REPORT_REASONS = new Set(["harassment", "hate", "threats", "nsfw", "spam", "doxxing", "illegal", "impersonation", "selfharm", "other"]);
app.post("/api/report", async (req, res) => {
  try {
    const me = await authUser(req); if (!me) return res.status(401).json({ error: "unauth" });
    const target = String(req.body.target || "").trim().toLowerCase();
    const reason = String(req.body.reason || "").trim();
    const description = String(req.body.description || "").trim();
    if (!target || target === me.login) return res.status(400).json({ error: "bad_target" });
    if (!REPORT_REASONS.has(reason)) return res.status(400).json({ error: "bad_reason" });
    // A message is linked when reporting from chat; profile/member-list reports may omit it.
    if (!(await getUser(target))) return res.status(400).json({ error: "no_user" });
    const id = await createReport({
      reporter: me.login, target, room: String(req.body.room || "").slice(0, 64),
      message_id: Number(req.body.messageId) || null, msg_preview: String(req.body.msgPreview || ""),
      reason, description,
    });
    // Ping every admin in realtime so the queue badge updates.
    for (const a of auth.ADMIN_LOGINS) notifyUser(a, "new-report", { id, target, reason });
    res.json({ ok: true, id });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

// Resend the verification email for the current address.
app.post("/api/account/resend-verify", async (req, res) => {
  try {
    const me = await authUser(req); if (!me) return res.status(401).json({ error: "unauth" });
    const u = await getUser(me.login);
    if (!u || !u.email) return res.status(400).json({ error: "no email on file" });
    if (u.email_verified) return res.json({ ok: true, alreadyVerified: true });
    await sendVerification(u.login, u.email, u.name);
    res.json({ ok: true, mailSent: mailEnabled() });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

// "Don't show the email reminder again."
app.post("/api/account/dismiss-nag", async (req, res) => {
  const me = await authUser(req); if (!me) return res.status(401).json({ error: "unauth" });
  await setNagDismissed(me.login, true);
  for (const tk of await import("./db.js").then((m) => m.tokensForLogin(me.login))) await import("./cache.js").then((c) => c.cacheDel("sess:" + tk));
  res.json({ ok: true });
});

// Change password from the profile — requires the current password, and can
// only be done once every 3 days.
const PW_COOLDOWN_MS = 3 * 24 * 3600 * 1000;
app.post("/api/account/password", async (req, res) => {
  try {
    const me = await authUser(req); if (!me) return res.status(401).json({ error: "unauth" });
    const { current, password } = req.body || {};
    const u = await getUser(me.login);
    if (!u) return res.status(400).json({ error: "not found" });
    if (!(await auth.verifyPassword(u, String(current || "")))) return res.status(400).json({ error: "wrong_current" });
    const last = Number(u.pw_changed_at) || 0;
    if (last && Date.now() - last < PW_COOLDOWN_MS) {
      return res.status(429).json({ error: "cooldown", retryAt: last + PW_COOLDOWN_MS });
    }
    await auth.setPassword(me.login, String(password || "")); // validates length, stamps time
    // Keep THIS session, drop all others.
    const keep = bearer(req);
    for (const tk of await import("./db.js").then((m) => m.tokensForLogin(me.login))) {
      if (tk === keep) { await import("./cache.js").then((c) => c.cacheDel("sess:" + tk)); continue; }
      await import("./db.js").then((m) => m.deleteSession(tk)); await import("./cache.js").then((c) => c.cacheDel("sess:" + tk));
    }
    res.json({ ok: true, changedAt: Date.now(), retryAt: Date.now() + PW_COOLDOWN_MS });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

// Forgot password → email a reset link. Always 200 (don't reveal which emails exist).
app.post("/api/forgot", async (req, res) => {
  try {
    const email = String(req.body.email || "").trim().toLowerCase();
    if (auth.EMAIL_RE.test(email)) {
      const u = await getUserByEmail(email);
      if (u && u.email_verified) {
        const raw = await makeEmailToken(u.login, email, "reset", 3600 * 1000);
        await sendResetEmail(email, u.name || u.login, `${APP_ORIGIN}/reset?token=${raw}`).catch((e) => console.error("reset mail", e.message));
      }
    }
    res.json({ ok: true });
  } catch (e) { res.json({ ok: true }); }
});

// Perform the reset with a valid token.
app.post("/api/reset", async (req, res) => {
  try {
    const { token, password } = req.body || {};
    const row = await consumeToken(token, "reset");
    if (!row) return res.status(400).json({ error: "Ссылка недействительна или устарела" });
    await auth.setPassword(row.login, password);
    // Invalidate every existing session for safety.
    for (const tk of await import("./db.js").then((m) => m.tokensForLogin(row.login))) { await import("./db.js").then((m) => m.deleteSession(tk)); await import("./cache.js").then((c) => c.cacheDel("sess:" + tk)); }
    res.json({ ok: true });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

// ---------- REST: профиль ----------
app.post("/api/profile", async (req, res) => {
  try {
    const me = await authUser(req);
    if (!me) return res.status(401).json({ error: "unauth" });
    const { name, avatar, banner, description, status, activity } = req.body || {};
    const patch = {};
    if (typeof name === "string" && name.trim()) patch.name = name.trim().slice(0, 64);
    if (typeof avatar === "string") patch.avatar = avatar.slice(0, 5_000_000);
    if (typeof banner === "string") patch.banner = banner.slice(0, 5_000_000);
    if (typeof description === "string") patch.description = description.slice(0, 280);
    if (typeof activity === "string") patch.activity = activity.trim().slice(0, 80);
    if (["online", "dnd", "invisible"].includes(status)) patch.status = status;
    await updateProfile(me.login, patch);
    if (patch.status) { userStatus.set(me.login, patch.status); broadcastPresence(me.login); }
    // Broadcast name/avatar/banner changes to friends and own devices in realtime
    if (patch.name || "avatar" in patch || "banner" in patch) {
      try {
        const friends = await getFriendLogins(me.login);
        const payload = { login: me.login, name: patch.name || me.name, avatarChanged: "avatar" in patch, bannerChanged: "banner" in patch };
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
// Profile banner — no default image (unset = 404, client hides the banner strip).
app.get("/api/banner/:login", async (req, res) => {
  try {
    const dataUrl = await getBanner(req.params.login.toLowerCase());
    if (!dataUrl) return res.status(404).end();
    const m = /^data:(.+?);base64,(.*)$/.exec(dataUrl);
    if (!m) return res.status(404).end();
    res.set("Content-Type", m[1]); res.set("Cache-Control", "public, max-age=60");
    res.send(Buffer.from(m[2], "base64"));
  } catch { res.status(404).end(); }
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
// Public user search (session-authed so anonymous clients can't scrape the roster).
// Powers the "find anyone" chat-search suggestions.
app.get("/api/users/search", async (req, res) => {
  const me = await authUser(req);
  if (!me) return res.status(401).json({ error: "unauthorized" });
  try {
    const users = (await searchUsers(req.query.q, 8)).filter((u) => u.login !== me.login);
    res.json({ ok: true, users });
  } catch (e) { console.error("user search", e.message); res.status(500).json({ error: "server error" }); }
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
    const hook = (g.channel && g.owner === me.login && g.hook_secret) ? `${APP_ORIGIN}/api/hook/${g.id}/${g.hook_secret}` : null;
    res.json({ ok: true, id: g.id, name: g.name, owner: g.owner, members, channel: !!g.channel, hook, isPublic: !!g.is_public, about: g.about || "" });
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
    const isChannel = !!req.body?.channel;
    const hookSecret = isChannel ? crypto.randomBytes(16).toString("hex") : null;
    const id = await createGroup(cleanName, me.login, memberList, isChannel, hookSecret);
    // Опциональный аватар: если передали — ставим отдельным UPDATE (не в createGroup, тот его не принимает). Лимит 3 MB как в rename/avatar верху.
    if (typeof req.body?.avatar === "string" && req.body.avatar) await setGroupAvatar(id, req.body.avatar.slice(0, 5_000_000));
    // Рассылаем group-updated всем новым участникам (включая овнера), чтобы их клиенты показали группу в списке чатов без ручного refetch.
    try { for (const l of await getGroupMembers(id)) notifyUser(l, "group-updated", { id }); } catch {}
    res.json({ ok: true, id, name: cleanName });
  } catch (e) { console.error("group create", e.message); res.status(500).json({ error: "server error" }); }
});
// Incoming webhook — external services POST here to publish a message into a channel.
const _hookLast = new Map();
app.post("/api/hook/:id/:secret", async (req, res) => {
  const id = req.params.id; if (!/^\d+$/.test(id)) return res.status(404).json({ error: "not_found" });
  const g = await getGroup(id);
  if (!g || !g.channel || !g.hook_secret || g.hook_secret !== req.params.secret) return res.status(404).json({ error: "not_found" });
  if (Date.now() - (_hookLast.get(id) || 0) < 800) return res.status(429).json({ error: "rate_limited" });
  const text = String(req.body?.text || "").trim(); if (!text) return res.status(400).json({ error: "empty" });
  _hookLast.set(id, Date.now());
  const name = String(req.body?.name || g.name || "Webhook").slice(0, 64);
  const buttons = normalizeButtons(req.body?.reply_markup || req.body?.buttons);
  try { await deliverMessage({ room: "@grp:" + id, fromLogin: g.owner, name, type: "text", text: text.slice(0, 4000), buttons }); res.json({ ok: true }); }
  catch (e) { console.error("hook", e.message); res.status(500).json({ error: "server error" }); }
});
// Owner: rotate the channel webhook secret (invalidates the old URL).
app.post("/api/groups/:id/hook/regen", async (req, res) => {
  const me = await authUser(req); if (!me) return res.status(401).json({ error: "unauth" });
  const id = req.params.id; if (!/^\d+$/.test(id)) return res.status(400).json({ error: "bad_id" });
  const g = await getGroup(id); if (!g || !g.channel) return res.status(404).json({ error: "not_found" });
  if (g.owner !== me.login) return res.status(403).json({ error: "forbidden" });
  const secret = crypto.randomBytes(16).toString("hex");
  await regenGroupHook(id, secret);
  res.json({ ok: true, hook: `${APP_ORIGIN}/api/hook/${id}/${secret}` });
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

// Redeem an invite code → auto-join (must be BEFORE "/api/groups/:id" or Express
// matches :id="redeem" and this never runs — that was why joining silently failed).
// Unauthenticated → {loginRequired:true}; authenticated → joins directly.
app.post("/api/groups/redeem", async (req, res) => {
  try {
    const me = await authUser(req);
    if (!me) return res.json({ loginRequired: true });
    const code = String(req.body.code || "").trim();
    if (!code) return res.status(400).json({ error: "no code" });
    const inv = await getInviteByHash(hashInviteCode(code));
    if (!inv) return res.json({ ok: false, status: "invalid" });
    if (inv.expires != null && inv.expires < Date.now()) { await revokeGroupInvite(inv.id).catch(() => {}); return res.json({ ok: false, status: "expired" }); }
    if (inv.max_uses != null && inv.uses >= inv.max_uses) { await revokeGroupInvite(inv.id).catch(() => {}); return res.json({ ok: false, status: "used_up" }); }
    if (await isGroupMember(inv.group_id, me.login)) return res.json({ ok: true, status: "already", group: inv.group_id });
    await addGroupMembers(inv.group_id, [me.login]); // the link IS the invitation — no approval
    const u = await getUser(me.login);
    if (u) saveSystemMessage("@grp:" + inv.group_id, me.login, u.name, "join", "");
    await bumpInviteUse(inv.id);
    for (const l of await getGroupMembers(inv.group_id)) notifyUser(l, "group-updated", { id: inv.group_id });
    res.json({ ok: true, status: "joined", group: inv.group_id });
  } catch (e) { console.error("redeem", e.message); res.status(500).json({ error: "server error" }); }
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
    // Being added is now an INVITATION: the target gets a request they accept or decline, so
    // nobody lands in a group they never agreed to join. "friends can add me to groups" still
    // gates who may even ask.
    const requested = req.body.add.map((l) => String(l).toLowerCase());
    const logins = [];
    for (const l of requested) { if ((await getPrefs(l)).groupAdd) logins.push(l); }
    const blocked = requested.filter((l) => !logins.includes(l));
    const g = await getGroup(id);
    for (const login of logins) {
      if (await isGroupMember(id, login)) continue;
      const reqId = await createGroupAddRequest(id, me.login, login);
      notifyUser(login, "group-invite", {
        id: reqId, groupId: Number(id), groupName: g ? g.name : "", channel: !!(g && g.channel),
        fromLogin: me.login, fromName: me.name,
      });
    }
    if (blocked.length && !logins.length) { res.json({ ok: false, error: "add_blocked", blocked }); return; }
    req._blockedAdds = blocked;
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
    // Optional limits: maxUses (>=1) and days (>=1). 0/absent = unlimited / never expires.
    const maxUses = Math.max(0, Math.min(9999, Number(req.body.maxUses) || 0)) || null;
    const days = Math.max(0, Math.min(365, Number(req.body.days) || 0));
    const expires = days > 0 ? Date.now() + days * 86400000 : null;
    await createGroupInvite(id, me.login, hashInviteCode(code), maxUses, expires);
    // Овнеру И создателю — обоим полезно видеть новую точку входа в списке инвайтов. Создатель не
    // получит повторного socket-event потому что генерирует код в своём клиенте и сразу ре-фетчит,
    // но emit «на всякий случай» — для апдейта UI без ручного refetch.
    const g = await getGroup(id);
    if (g) notifyUser(g.owner, "invite-created", { id });
    notifyUser(me.login, "invite-created", { id });
    res.json({ ok: true, code, url: "/invite/" + encodeURIComponent(code) });
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

// Public invite preview (no auth) — powers the /invite/<code> join page.
app.get("/api/invite/:code", async (req, res) => {
  try {
    const inv = await getInviteByHash(hashInviteCode(req.params.code));
    if (!inv) return res.json({ ok: false, status: "invalid" });
    if (inv.expires != null && inv.expires < Date.now()) return res.json({ ok: false, status: "expired" });
    if (inv.max_uses != null && inv.uses >= inv.max_uses) return res.json({ ok: false, status: "used_up" });
    const g = await getGroup(inv.group_id);
    if (!g) return res.json({ ok: false, status: "invalid" });
    const members = await getGroupMembers(inv.group_id);
    res.json({ ok: true, group: { id: g.id, name: g.name, members: members.length },
      remaining: inv.max_uses == null ? null : Math.max(0, inv.max_uses - inv.uses), expires: inv.expires });
  } catch (e) { console.error("invite preview", e.message); res.status(500).json({ error: "server error" }); }
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
      if (!(await getPrefs(target)).groupAdd) continue; // target disallows being added to groups
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
// Can `from` send `to` a friend request, given `to`'s privacy preference?
async function canFriendRequest(from, to) {
  const p = await getPrefs(to);
  if (p.friendReq === "nobody") return false;
  if (p.friendReq === "fof") return await haveMutualFriend(from, to); // friends-of-friends only
  return true; // everyone
}

// ---------- REST: privacy preferences ----------
app.get("/api/prefs", async (req, res) => {
  const me = await authUser(req); if (!me) return res.status(401).json({ error: "unauth" });
  res.json(await getPrefs(me.login));
});
app.post("/api/prefs", async (req, res) => {
  const me = await authUser(req); if (!me) return res.status(401).json({ error: "unauth" });
  const patch = {};
  if (["everyone", "fof", "nobody"].includes(req.body.friendReq)) patch.friendReq = req.body.friendReq;
  if (typeof req.body.groupAdd === "boolean") patch.groupAdd = req.body.groupAdd;
  if (typeof req.body.readReceipts === "boolean") patch.readReceipts = req.body.readReceipts;
  if (typeof req.body.dmOpen === "boolean") patch.dmOpen = req.body.dmOpen;
  await setPrefs(me.login, patch);
  for (const tk of await import("./db.js").then((m) => m.tokensForLogin(me.login))) await import("./cache.js").then((c) => c.cacheDel("sess:" + tk));
  res.json({ ok: true, prefs: await getPrefs(me.login) });
});

// ---------- REST: Themes (studio + workshop) ----------
app.get("/api/themes", async (req, res) => {
  const me = await authUser(req); if (!me) return res.status(401).json({ error: "unauth" });
  res.json({ themes: await getUserThemes(me.login), limits: THEME_LIMITS, published: await countPublished(me.login) });
});
app.post("/api/themes", async (req, res) => {
  const me = await authUser(req); if (!me) return res.status(401).json({ error: "unauth" });
  const { id, name, tokens } = req.body || {};
  if (!tokens || typeof tokens !== "object") return res.status(400).json({ error: "bad_tokens" });
  const out = await saveTheme(me.login, { id: id || null, name, tokens });
  if (out.error) return res.status(400).json(out);
  res.json({ ok: true, id: out.id });
});
app.delete("/api/themes/:id", async (req, res) => {
  const me = await authUser(req); if (!me) return res.status(401).json({ error: "unauth" });
  await deleteTheme(me.login, Number(req.params.id) || 0);
  res.json({ ok: true });
});
app.post("/api/themes/:id/publish", async (req, res) => {
  const me = await authUser(req); if (!me) return res.status(401).json({ error: "unauth" });
  const id = Number(req.params.id) || 0;
  const th = await getTheme(id);
  if (!th || th.owner !== me.login) return res.status(404).json({ error: "not_found" });
  const publish = !!req.body.published;
  if (publish && !th.published && (await countPublished(me.login)) >= THEME_LIMITS.published) {
    return res.status(400).json({ error: "publish_limit", limit: THEME_LIMITS.published });
  }
  await setThemePublished(me.login, id, publish);
  res.json({ ok: true, published: publish });
});
app.get("/api/themes/workshop", async (req, res) => {
  const me = await authUser(req); if (!me) return res.status(401).json({ error: "unauth" });
  res.json({ themes: await listWorkshop(String(req.query.q || ""), String(req.query.sort || "popular")) });
});
app.post("/api/themes/:id/install", async (req, res) => {
  const me = await authUser(req); if (!me) return res.status(401).json({ error: "unauth" });
  const th = await getTheme(Number(req.params.id) || 0);
  if (!th || !th.published) return res.status(404).json({ error: "not_found" });
  await incThemeInstalls(th.id);
  res.json({ ok: true, theme: { name: th.name, tokens: th.tokens, owner: th.owner } });
});

app.post("/api/friend", async (req, res) => {
  const me = await authUser(req); if (!me) return res.status(401).json({ error: "unauth" });
  const target = String(req.body.target || "").toLowerCase();
  const action = req.body.action;
  if (!target || target === me.login) return res.status(400).json({ error: "bad target" });
  if (action === "request") {
    if (!(await getUser(target))) return res.status(404).json({ error: "not found" });
    // Bots skip the privacy gate and auto-accept (handled in sendFriendRequest).
    if (!(await isBot(target)) && !(await canFriendRequest(me.login, target))) return res.status(403).json({ error: "req_blocked" });
    await sendFriendRequest(me.login, target);
  }
  else if (action === "accept") await acceptFriend(me.login, target);
  else if (action === "decline") await declineFriend(me.login, target);
  else if (action === "remove") await removeFriend(me.login, target);
  // Take back a request you sent (the row is keyed the other way round from "decline").
  else if (action === "cancel") await cancelFriendRequest(me.login, target);
  else return res.status(400).json({ error: "bad action" });
  notifyUser(target, "relations-changed", {}); notifyUser(me.login, "relations-changed", {});
  res.json({ ok: true });
});

// Mutual friends: a per-contact list, and a one-shot map of counts for all my friends.
app.get("/api/mutual/:login", async (req, res) => {
  const me = await authUser(req); if (!me) return res.status(401).json({ error: "unauth" });
  try { res.json({ ok: true, mutual: await mutualFriends(me.login, String(req.params.login).toLowerCase()) }); }
  catch (e) { console.error("mutual", e.message); res.status(500).json({ error: "server error" }); }
});
app.get("/api/mutuals", async (req, res) => {
  const me = await authUser(req); if (!me) return res.status(401).json({ error: "unauth" });
  try { res.json({ ok: true, counts: await mutualCounts(me.login) }); }
  catch (e) { console.error("mutuals", e.message); res.status(500).json({ error: "server error" }); }
});

// ---------- REST: DM синхронизация ----------
app.get("/api/dms", async (req, res) => {
  const me = await authUser(req); if (!me) return res.status(401).json({ error: "unauth" });
  res.json(await getUserDMs(me.login));
});
app.post("/api/dms", async (req, res) => {
  const me = await authUser(req); if (!me) return res.status(401).json({ error: "unauth" });
  const list = Array.isArray(req.body.dms) ? req.body.dms.slice(0, 50) : [];
  try { await saveUserDMs(me.login, list); res.json({ ok: true }); }
  catch (e) { console.error("saveUserDMs", e.message); res.status(500).json({ error: "save_failed" }); }
});

// ---------- REST: закреплённые чаты (серверная синхронизация) ----------
app.get("/api/pins", async (req, res) => {
  const me = await authUser(req); if (!me) return res.status(401).json({ error: "unauth" });
  res.json(await getPinnedChats(me.login));
});
app.post("/api/pins", async (req, res) => {
  const me = await authUser(req); if (!me) return res.status(401).json({ error: "unauth" });
  const keys = Array.isArray(req.body.keys) ? req.body.keys.slice(0, 200) : [];
  await savePinnedChats(me.login, keys);
  res.json({ ok: true });
});

// ---------- REST: Админка (только для ADMIN_LOGINS) ----------
async function requireAdmin(req, res) {
  const me = await authUser(req);
  if (!me) { res.status(401).json({ error: "unauth" }); return null; }
  if (!auth.isAdmin(me.login)) { res.status(403).json({ error: "forbidden" }); return null; }
  return me;
}
// Invalidate every session for a login and disconnect all its live sockets.
async function kickAllDevices(login) {
  for (const tk of await import("./db.js").then((m) => m.tokensForLogin(login))) {
    await import("./db.js").then((m) => m.deleteSession(tk));
    await import("./cache.js").then((c) => c.cacheDel("sess:" + tk));
  }
  const ids = userSockets.get(login);
  if (ids) for (const id of [...ids]) {
    const s = io.sockets.sockets.get(id);
    if (s) { s.emit("force-logout", { reason: "kicked" }); s.disconnect(true); }
  }
}

app.get("/api/admin/stats", async (req, res) => {
  if (!(await requireAdmin(req, res))) return;
  res.json({ ...(await adminStats()), online: userSockets.size, reports: await countPendingReports() });
});
// ---- Reports review ----
app.get("/api/admin/reports", async (req, res) => {
  if (!(await requireAdmin(req, res))) return;
  const list = await listReports({ filter: String(req.query.filter || "pending"), q: String(req.query.q || ""), sort: String(req.query.sort || "new") });
  res.json(list);
});
app.get("/api/admin/reports-count", async (req, res) => {
  if (!(await requireAdmin(req, res))) return;
  res.json({ pending: await countPendingReports() });
});
// Resolve a report: IP-ban the target (days or life) OR mark it a false report.
app.post("/api/admin/reports/:id/resolve", async (req, res) => {
  if (!(await requireAdmin(req, res))) return;
  const rep = await getReport(req.params.id);
  if (!rep) return res.status(404).json({ error: "no_report" });
  const action = String(req.body.action || "");
  if (action === "false") {
    await resolveReport(rep.id, { status: "false", resolution: "false", by: (await authUser(req)).login });
    return res.json({ ok: true });
  }
  if (action === "ipban") {
    const life = !!req.body.life;
    const days = life ? 0 : Math.max(1, Number(req.body.days) || 1);
    const until = life ? null : Date.now() + days * 86400000;
    const durationMs = life ? 0 : days * 86400000;   // 0 = life (for the unstable tooltip)
    // Mark the account "unstable" (guilty) + set the login-block window; life = hard ban.
    await setUserReportBan(rep.target, { until, reason: rep.reason, durationMs });
    if (life) await setUserBanned(rep.target, true);
    // IP-ban the target's last-known IP for the same window.
    const u = await getUser(rep.target);
    const ip = normIp(u && u.last_ip);
    if (ip) await applyIpBan(ip, "report:" + rep.reason, until);
    await kickAllDevices(rep.target);
    await resolveReport(rep.id, { status: "actioned", resolution: life ? "ipban_life" : ("ipban_" + days + "d"), ban_until: until, by: (await authUser(req)).login });
    return res.json({ ok: true });
  }
  res.status(400).json({ error: "bad_action" });
});
// Lift a user's "unstable" mark (reporter forgave / appeal granted).
app.post("/api/admin/clear-unstable", async (req, res) => {
  if (!(await requireAdmin(req, res))) return;
  const login = String(req.body.login || "").toLowerCase();
  if (!login) return res.status(400).json({ error: "bad_target" });
  await clearUserReport(login);
  if (!(await getUser(login)).banned) { /* allow login again if not hard-banned */ }
  for (const tk of await import("./db.js").then((m) => m.tokensForLogin(login))) await import("./cache.js").then((c) => c.cacheDel("sess:" + tk));
  res.json({ ok: true });
});
app.get("/api/admin/users", async (req, res) => {
  if (!(await requireAdmin(req, res))) return;
  const users = await adminListUsers(String(req.query.q || ""), 200);
  const onlineSet = new Set(userSockets.keys());
  res.json(users.map((u) => ({ ...u, online: onlineSet.has(u.login), devices: (userSockets.get(u.login) || new Set()).size })));
});
app.get("/api/admin/logs", async (req, res) => {
  if (!(await requireAdmin(req, res))) return;
  res.json(LOG_RING.slice(-300));
});
// Server resource usage for the admin Logs tab (RAM + disk + load).
app.get("/api/admin/sys", async (req, res) => {
  if (!(await requireAdmin(req, res))) return;
  const mem = { total: totalmem(), free: freemem(), rss: process.memoryUsage().rss };
  let disk = null;
  try { const s = await statfs("/"); disk = { total: s.blocks * s.bsize, free: s.bavail * s.bsize }; } catch (e) { console.warn("statfs", e.message); }
  res.json({ mem, disk, load: loadavg(), uptime: osUptime(), procUptime: process.uptime() });
});
app.get("/api/admin/banned-ips", async (req, res) => {
  if (!(await requireAdmin(req, res))) return;
  res.json(await listBannedIps());
});
// Live devices for a user (socket id + ip), so an admin can kick a single device.
app.get("/api/admin/devices", async (req, res) => {
  if (!(await requireAdmin(req, res))) return;
  const login = String(req.query.login || "").toLowerCase();
  const ids = userSockets.get(login) || new Set();
  const out = [];
  for (const id of ids) {
    const s = io.sockets.sockets.get(id);
    out.push({ id, ip: s ? s._ip : null, room: socketRoom.get(id) || null });
  }
  res.json(out);
});
app.post("/api/admin/ban", async (req, res) => {
  const me = await requireAdmin(req, res); if (!me) return;
  const login = String(req.body.login || "").toLowerCase();
  const banned = !!req.body.banned;
  if (!login || auth.isAdmin(login)) return res.status(400).json({ error: "bad_target" });
  // A ban carries a reason: one of the guideline codes, or free text the admin typed.
  const reason = String(req.body.reason || "").slice(0, 300).trim();
  await setUserBannedWithReason(login, banned, reason);
  if (banned) await kickAllDevices(login); // block login + kick everywhere
  res.json({ ok: true });
});
app.post("/api/admin/kick", async (req, res) => {
  if (!(await requireAdmin(req, res))) return;
  const login = String(req.body.login || "").toLowerCase();
  if (!login) return res.status(400).json({ error: "bad_target" });
  await kickAllDevices(login);
  res.json({ ok: true });
});
app.post("/api/admin/kick-device", async (req, res) => {
  if (!(await requireAdmin(req, res))) return;
  const id = String(req.body.socketId || "");
  const s = io.sockets.sockets.get(id);
  if (!s) return res.status(404).json({ error: "no_device" });
  if (s._token) { await import("./db.js").then((m) => m.deleteSession(s._token)); await import("./cache.js").then((c) => c.cacheDel("sess:" + s._token)); }
  s.emit("force-logout", { reason: "kicked" }); s.disconnect(true);
  res.json({ ok: true });
});
// Apply an IP ban (expires = null for life), sync the in-memory map, and kick live sockets on it.
async function applyIpBan(ip, reason, expires = null) {
  await banIp(ip, reason, expires);
  bannedIps.set(ip, expires);
  for (const s of io.sockets.sockets.values()) if (s._ip === ip) { s.emit("banned", { ip: true }); s.disconnect(true); }
}
app.post("/api/admin/ban-ip", async (req, res) => {
  if (!(await requireAdmin(req, res))) return;
  // Ban a raw IP, or the last-known IP of a login. Optional `days` → temporary.
  let ip = normIp(req.body.ip || "");
  const login = String(req.body.login || "").toLowerCase();
  const days = Number(req.body.days) || 0;
  const expires = days > 0 ? Date.now() + days * 86400000 : null;
  if (!ip && login) { const u = await getUser(login); ip = normIp(u && u.last_ip); if (login && !days) await setUserBanned(login, true); }
  if (!ip) return res.status(400).json({ error: "no_ip" });
  await applyIpBan(ip, req.body.reason || (login ? "user:" + login : null), expires);
  if (login && !days) await kickAllDevices(login);
  res.json({ ok: true, ip });
});
app.post("/api/admin/unban-ip", async (req, res) => {
  if (!(await requireAdmin(req, res))) return;
  const ip = normIp(req.body.ip || "");
  await unbanIp(ip); bannedIps.delete(ip);
  res.json({ ok: true });
});
app.post("/api/admin/rename", async (req, res) => {
  if (!(await requireAdmin(req, res))) return;
  const login = String(req.body.login || "").toLowerCase();
  const name = String(req.body.name || "").trim();
  if (!login || !name) return res.status(400).json({ error: "bad_input" });
  await setUserName(login, name);
  for (const tk of await import("./db.js").then((m) => m.tokensForLogin(login))) await import("./cache.js").then((c) => c.cacheDel("sess:" + tk));
  try {
    const friends = await getFriendLogins(login);
    for (const f of friends) notifyUser(f, "profile-updated", { login, name, avatarChanged: false });
    notifyUser(login, "profile-updated", { login, name, avatarChanged: false });
  } catch {}
  res.json({ ok: true });
});
app.post("/api/admin/set-email", async (req, res) => {
  if (!(await requireAdmin(req, res))) return;
  const login = String(req.body.login || "").toLowerCase();
  const email = String(req.body.email || "").trim().toLowerCase();
  if (!login || !auth.EMAIL_RE.test(email) || email.length > 190) return res.status(400).json({ error: "bad_input" });
  const taken = await getUserByEmail(email);
  if (taken && taken.login !== login) return res.status(400).json({ error: "email_taken" });
  await setUserEmail(login, email);
  for (const tk of await import("./db.js").then((m) => m.tokensForLogin(login))) await import("./cache.js").then((c) => c.cacheDel("sess:" + tk));
  res.json({ ok: true });
});
// Email the user a password-reset link (admin-triggered).
app.post("/api/admin/send-reset", async (req, res) => {
  if (!(await requireAdmin(req, res))) return;
  const login = String(req.body.login || "").toLowerCase();
  const u = await getUser(login);
  if (!u || !u.email) return res.status(400).json({ error: "no_email" });
  const raw = await makeEmailToken(u.login, u.email, "reset", 3600 * 1000);
  await sendResetEmail(u.email, u.name || u.login, `${APP_ORIGIN}/reset?token=${raw}`);
  res.json({ ok: true, email: u.email, mailSent: mailEnabled() });
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
// FCM device token registration (native Android app). `enabled` tells the client
// whether the server can actually send (Firebase configured) so it can decide UX.
app.get("/api/push/fcm/status", (req, res) => res.json({ enabled: fcmOn }));
app.post("/api/push/fcm", async (req, res) => {
  try {
    const me = await authUser(req); if (!me) return res.status(401).json({ error: "unauth" });
    const token = String(req.body && req.body.token || "").trim();
    if (!token) return res.status(400).json({ error: "no token" });
    await saveFcmToken(me.login, token); res.json({ ok: true });
  } catch (e) { console.error("fcm reg", e.message); res.status(500).json({ error: "server error" }); }
});
app.post("/api/push/fcm/delete", async (req, res) => {
  try {
    const token = String(req.body && req.body.token || "").trim();
    if (token) await deleteFcmToken(token);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: "server error" }); }
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

// ================= Bots =================
const BOT_CAP = 3;
const botLoginOk = (l) => /^[a-z0-9_]{3,24}$/.test(l);
const newBotToken = () => "dlg_" + crypto.randomBytes(24).toString("base64url");
const botTokenHash = (tok) => crypto.createHash("sha256").update(String(tok)).digest("hex");
const safeJson = (s) => { try { return JSON.parse(s) || []; } catch { return []; } };
const cleanCommands = (arr) => (Array.isArray(arr) ? arr : []).slice(0, 50)
  .map((c) => ({ command: String(c.command || "").replace(/[^a-z0-9_]/gi, "").slice(0, 32).toLowerCase(), description: String(c.description || "").slice(0, 120) }))
  .filter((c) => c.command);

// ---- Owner management (authenticated with the user's session, NOT a bot token) ----
app.get("/api/dev/bots", async (req, res) => {
  const me = await authUser(req); if (!me) return res.status(401).json({ error: "unauth" });
  const bots = await listBotsByOwner(me.login);
  res.json({ ok: true, cap: BOT_CAP, bots: bots.map((b) => ({ login: b.login, name: b.name, description: b.description || "", webhook: b.bot_webhook || "", miniapp: b.bot_miniapp || "", privacy: !!b.bot_privacy, public: !!b.bot_public, commands: safeJson(b.bot_commands), created_at: b.created_at })) });
});
app.post("/api/dev/bots", async (req, res) => {
  const me = await authUser(req); if (!me) return res.status(401).json({ error: "unauth" });
  const login = String(req.body.login || "").trim().toLowerCase();
  const name = String(req.body.name || "").trim().slice(0, 64) || login;
  if (!botLoginOk(login)) return res.status(400).json({ error: "bad_login" });
  if (await getUser(login)) return res.status(400).json({ error: "login_taken" });
  if (await countBotsByOwner(me.login) >= BOT_CAP) return res.status(400).json({ error: "bot_cap", cap: BOT_CAP });
  const token = newBotToken();
  const salt = crypto.randomBytes(16).toString("hex");
  const hash = crypto.randomBytes(64).toString("hex"); // random → bots can't password-login
  try { await createBot(login, name, me.login, botTokenHash(token), salt, hash); }
  catch (e) { console.error("createBot", e.message); return res.status(500).json({ error: "server error" }); }
  res.json({ ok: true, login, name, token });
});
app.post("/api/dev/bots/:login", async (req, res) => {
  const me = await authUser(req); if (!me) return res.status(401).json({ error: "unauth" });
  const bot = await getBot(String(req.params.login).toLowerCase());
  if (!bot || bot.bot_owner !== me.login) return res.status(404).json({ error: "not_found" });
  const patch = {};
  if (typeof req.body.name === "string" && req.body.name.trim()) patch.name = req.body.name.trim().slice(0, 64);
  if (typeof req.body.description === "string") patch.description = req.body.description.slice(0, 280);
  if (typeof req.body.privacy === "boolean") patch.privacy = req.body.privacy ? 1 : 0;
  if ("webhook" in req.body) {
    const url = String(req.body.webhook || "").trim();
    if (url && !safeHttpUrl(url)) return res.status(400).json({ error: "bad_webhook" });
    patch.webhook = url || null;
    if (url && !bot.bot_webhook_secret) patch.webhookSecret = crypto.randomBytes(16).toString("hex");
  }
  if (Array.isArray(req.body.commands)) patch.commands = JSON.stringify(cleanCommands(req.body.commands));
  if ("miniapp" in req.body) {
    const url = String(req.body.miniapp || "").trim();
    if (url && !/^https:\/\/.+/i.test(url)) return res.status(400).json({ error: "bad_miniapp" });
    patch.miniapp = url ? url.slice(0, 300) : null;
  }
  await updateBot(bot.login, patch);
  if (patch.name) { try { notifyUser(me.login, "profile-updated", { login: bot.login, name: patch.name }); } catch {} }
  res.json({ ok: true, webhookSecret: patch.webhookSecret || bot.bot_webhook_secret || null });
});
app.post("/api/dev/bots/:login/token", async (req, res) => {
  const me = await authUser(req); if (!me) return res.status(401).json({ error: "unauth" });
  const bot = await getBot(String(req.params.login).toLowerCase());
  if (!bot || bot.bot_owner !== me.login) return res.status(404).json({ error: "not_found" });
  const token = newBotToken();
  await setBotTokenHash(bot.login, botTokenHash(token));
  res.json({ ok: true, token });
});
app.delete("/api/dev/bots/:login", async (req, res) => {
  const me = await authUser(req); if (!me) return res.status(401).json({ error: "unauth" });
  res.json({ ok: await deleteBot(String(req.params.login).toLowerCase(), me.login) });
});

// ---- Telegram-style bot HTTP API (authenticated with the bot token) ----
async function botInRoom(botLogin, room) {
  if (!room || typeof room !== "string") return false;
  if (room.startsWith("@dm:")) return room.slice(4).split("~").includes(botLogin);
  if (room.startsWith("@grp:")) { const gid = room.slice(5); return /^\d+$/.test(gid) && await isGroupMember(gid, botLogin); }
  return false;
}
async function botApi(req, res) {
  const method = req.botMethod || req.params.method;
  const token = req.botToken || bearer(req);
  const bot = token ? await getBotByTokenHash(botTokenHash(token)) : null;
  if (!bot) return res.status(401).json({ ok: false, error_code: 401, description: "Unauthorized" });
  // Accept params from the JSON body OR the query string (Telegram allows both; the
  // JSON body wins on conflict). Without this, GET ...?offset=&timeout= is ignored.
  const body = { ...(req.query || {}), ...(req.body || {}) };
  const okr = (result) => res.json({ ok: true, result });
  const err = (code, desc) => res.status(code).json({ ok: false, error_code: code, description: desc });
  try {
    switch (method) {
      case "getMe": return okr({ id: bot.login, login: bot.login, name: bot.name, is_bot: true, description: bot.description || "", miniapp: bot.bot_miniapp || "" });
      case "setMiniApp": {
        const url = String(body.url || "").trim();
        if (url && !/^https:\/\/.+/i.test(url)) return err(400, "bad url (https required)");
        await updateBot(bot.login, { miniapp: url ? url.slice(0, 300) : null }); return okr(true);
      }
      case "getMyCommands": return okr(safeJson(bot.bot_commands));
      case "setMyCommands": await updateBot(bot.login, { commands: JSON.stringify(cleanCommands(body.commands)) }); return okr(true);
      case "setWebhook": {
        const url = String(body.url || "").trim();
        if (url && !safeHttpUrl(url)) return err(400, "bad url (https + public host required)");
        const patch = { webhook: url || null };
        if (url) patch.webhookSecret = String(body.secret || "").slice(0, 32) || crypto.randomBytes(16).toString("hex");
        await updateBot(bot.login, patch); return okr(true);
      }
      case "deleteWebhook": await updateBot(bot.login, { webhook: null }); return okr(true);
      case "getUpdates": return botGetUpdates(bot, body, res);
      case "sendMessage": case "sendPhoto": case "sendDocument": case "sendVideo": case "sendAudio":
        return botSend(bot, method, body, okr, err);
      case "editMessageText": {
        const id = Number(body.message_id) || 0, text = String(body.text || "").trim().slice(0, 4000);
        if (!id || !text) return err(400, "message_id and text required");
        const room = await editMessage(id, bot.login, text);
        if (!room) return err(400, "message not editable"); io.to(room).emit("msg-edited", { id, text });
        // editMessageText may also carry a new keyboard (Telegram allows reply_markup here).
        if ("reply_markup" in body || "buttons" in body) {
          const buttons = normalizeButtons(body.reply_markup || body.buttons);
          const r2 = await editMessageMarkup(id, bot.login, buttons);
          if (r2) io.to(r2).emit("msg-markup", { id, buttons: buttons || null });
        }
        return okr(true);
      }
      case "editMessageReplyMarkup": {
        const id = Number(body.message_id) || 0; if (!id) return err(400, "message_id required");
        const buttons = normalizeButtons(body.reply_markup || body.buttons);
        const room = await editMessageMarkup(id, bot.login, buttons);
        if (!room) return err(400, "message not found"); io.to(room).emit("msg-markup", { id, buttons: buttons || null }); return okr(true);
      }
      case "answerCallbackQuery": {
        const cbid = String(body.callback_query_id || "");
        const p = pendingCb.get(cbid);
        if (p) { notifyUser(p.login, "cb-answer", { cbid, text: String(body.text || "").slice(0, 200), alert: !!(body.show_alert || body.alert) }); pendingCb.delete(cbid); }
        return okr(true);
      }
      case "deleteMessage": {
        const id = Number(body.message_id) || 0; if (!id) return err(400, "message_id required");
        const room = await deleteMessage(id, bot.login);
        if (!room) return err(400, "message not found"); io.to(room).emit("msg-deleted", { id }); return okr(true);
      }
      case "sendChatAction": {
        const room = String(body.chat_id || "");
        if (await botInRoom(bot.login, room)) io.to(room).emit("typing", { id: "bot:" + bot.login, name: bot.name, isTyping: body.action !== "cancel" });
        return okr(true);
      }
      default: return err(404, "Unknown method: " + method);
    }
  } catch (e) { console.error("botApi " + method, e.message); return err(500, "server error"); }
}
async function botSend(bot, method, body, okr, err) {
  const room = String(body.chat_id || "");
  if (!(await botInRoom(bot.login, room))) return err(403, "bot is not a participant of this chat");
  let type = "text", media = null, mediaName = "", text = String(body.text || body.caption || "");
  if (method !== "sendMessage") {
    media = body.media || body.photo || body.document || body.video || body.audio || body.url;
    if (!media || typeof media !== "string") return err(400, "media required (data: URL or https URL)");
    if (media.startsWith("data:")) { const c = media.indexOf(","); const b64 = c >= 0 ? media.length - c - 1 : media.length; if (Math.floor(b64 * 3 / 4) > MAX_FILE_BYTES) return err(400, "file_too_big"); }
    type = method === "sendPhoto" ? "image" : method === "sendVideo" ? "video" : method === "sendAudio" ? "audio" : "file";
    mediaName = String(body.filename || body.media_name || "file").slice(0, 255); text = "";
  } else if (!text.trim()) return err(400, "text required");
  const buttons = normalizeButtons(body.reply_markup || body.buttons);
  const payload = await deliverMessage({ room, fromLogin: bot.login, name: bot.name, from: "bot:" + bot.login, type, text, media, mediaName, buttons });
  if (!payload) return err(500, "could not send");
  return okr({ message_id: payload.id, chat: { id: room }, date: Math.floor(payload.ts / 1000), text: payload.text, from: { login: bot.login, name: bot.name, is_bot: true } });
}
function botGetUpdates(bot, body, res) {
  const offset = Number(body.offset) || 0;
  if (offset > 0) deleteBotUpdatesBelow(bot.login, offset).catch(() => {});
  const timeout = Math.min(30, Math.max(0, Number(body.timeout) || 0));
  const deadline = Date.now() + timeout * 1000;
  const poll = async () => {
    let rows = [];
    try { rows = await getBotUpdates(bot.login, offset, Number(body.limit) || 100); } catch {}
    if (rows.length || Date.now() >= deadline) {
      return res.json({ ok: true, result: rows.map((r) => { let u = {}; try { u = JSON.parse(r.update_json); } catch {} u.update_id = r.id; return u; }) });
    }
    setTimeout(poll, 1000);
  };
  poll();
}
// /bot<token>/<method> (Telegram-compatible) + /api/bot/<method> (Bearer). Registered BEFORE
// the SPA fallback so they aren't swallowed by it.
app.all(/^\/bot([A-Za-z0-9_-]+)\/([A-Za-z]+)$/, (req, res) => { req.botToken = req.params[0]; req.botMethod = req.params[1]; botApi(req, res); });
app.all("/api/bot/:method", botApi);
// Housekeeping: drop stale queued updates hourly.
setInterval(() => { pruneBotUpdates().catch(() => {}); }, 3600 * 1000);

// ---------- GitHub webhook (auto-deploy) ----------
app.post("/webhook", (req, res) => {
  const event = req.headers["x-github-event"];
  const sig = req.headers["x-hub-signature-256"];
  if (event !== "push") return res.json({ ok: true });
  const secret = process.env.GITHUB_WEBHOOK_SECRET;
  if (secret && sig) {
    const payload = JSON.stringify(req.body);
    const hmac = crypto.createHmac("sha256", secret).update(payload, "utf-8").digest("hex");
    if (sig !== `sha256=${hmac}`) return res.status(401).json({ error: "invalid signature" });
  }
  res.status(202).json({ ok: true, status: "deploying" });
  const repo = process.env.HOST_REPO_PATH || "/repo";
  const gitSSH = `ssh -i /root/.ssh/id_ed25519 -o StrictHostKeyChecking=accept-new -o UserKnownHostsFile=/dev/null`;
  // Deterministic sync: fetch + hard-reset to origin/main. This avoids the
  // `git stash && git pull` failures (merge conflicts / leftover stashes) that
  // would skip the build step and leave the container stale. Untracked files
  // (certs/, .env) are preserved by reset --hard.
  exec(`git config --global --add safe.directory ${repo} && cd ${repo} && git fetch origin main 2>&1 && git reset --hard origin/main 2>&1`,
    { timeout: 60000, env: { ...process.env, HOME: "/root", GIT_SSH_COMMAND: gitSSH } },
    (err, stdout) => {
      if (err) { console.error("deploy sync:", stdout.slice(-400), err.message); return; }
      console.log("deploy sync ok");
      const hostRepoPath = "/home/ubuntu/dialog";
      // Remove any orphaned deployer from a previous run, then rebuild + prune.
      exec(`docker rm -f dialog-deployer 2>/dev/null; docker run -d --rm \
        -v /var/run/docker.sock:/var/run/docker.sock \
        -v ${hostRepoPath}:${hostRepoPath} \
        -w ${hostRepoPath} \
        --name dialog-deployer \
        node:22-alpine \
        sh -c "apk add --no-cache docker-cli docker-cli-compose >/dev/null 2>&1 && docker compose -f docker-compose.prod.yml up -d --no-deps --build app && docker image prune -f"`,
        { timeout: 180000 },
        (err2, stdout2) => {
          if (err2) console.error("deploy build:", stdout2.slice(-400), err2.message);
          else console.log("deploy ok:", stdout2.slice(-300));
        }
      );
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
  const meta = callMeta.get(room);
  return { room, count: logins.length, logins, locked: !!(meta && meta.locked), muteOnEntry: !!(meta && meta.muteOnEntry) };
}
// Who is currently in a room's call, with display names — the server panel shows these
// under a voice channel, so it needs names rather than a bare count.
function voiceOccupancy(room) {
  const c = callRooms.get(room);
  if (!c) return [];
  const seen = new Map();
  for (const v of c.values()) if (!seen.has(v.login)) seen.set(v.login, { login: v.login, name: v.name });
  return [...seen.values()];
}
function broadcastCallState(room) {
  io.to(room).emit("call-state", callStatePayload(room));
  // A voice channel's occupancy is interesting to everyone in the server, not just the
  // people already inside the room.
  if (room.startsWith("@ch:")) {
    getChannel(room.slice(4)).then((ch) => {
      if (ch) notifyServer(ch.serverId, "server-voice", { channelId: ch.id, users: voiceOccupancy(room) });
    }).catch(() => {});
  }
}
// Remove one socket from a call room, running the same end-of-call bookkeeping
// (system message + meta cleanup) as a normal leave when the room empties.
function removeFromCall(room, sid) {
  const c = callRooms.get(room);
  if (!c || !c.has(sid)) return;
  c.delete(sid);
  if (!c.size) {
    callRooms.delete(room);
    const meta = callMeta.get(room);
    if (meta) {
      clearTimeout(meta.ringTimer);
      const dur = Date.now() - meta.startTs;
      if (meta.answered && dur > 2000) saveSystemMessage(room, meta.initiatorLogin, meta.initiatorName, "call_ended", fmtDuration(dur));
      else {
        saveSystemMessage(room, meta.initiatorLogin, meta.initiatorName, "call_missed", fmtDuration(dur));
        // Caller left before anyone answered → stop the callees' ringtone/popup.
        for (const login of (meta.recips || [])) notifyUser(login, "call-cancelled", { room });
      }
      callMeta.delete(room);
    }
  }
  broadcastCallState(room);
}
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

// Save + broadcast + notify a message into a room, then fan out to any bot participants.
// Shared by the socket "message" handler and the bot HTTP API. Returns the saved payload
// (with .id) or null if the DB rejected it. Never throws.
// Which participants a message @-mentions. `@all` (word-boundary) → everyone but the sender;
// otherwise the @login tokens that match an actual participant. recips is already scoped to the
// room (DM = the partner, group = its members), so DM mentions can only ever hit the DM partner.
function resolveMentions(text, recips, fromLogin) {
  const s = String(text || "");
  const out = new Set();
  if (/(^|\s)@all(?![\w-])/i.test(s)) { for (const l of recips) if (l !== fromLogin) out.add(l); return out; }
  const toks = new Set((s.match(/@([a-z0-9_.]+)/gi) || []).map((x) => x.slice(1).toLowerCase()));
  if (!toks.size) return out;
  for (const l of recips) if (l !== fromLogin && toks.has(String(l).toLowerCase())) out.add(l);
  return out;
}

// Normalize an inline keyboard from either the Telegram shape ({inline_keyboard:[[{text,url|
// callback_data}]]}) or a flat {buttons:[[{text,url|data}]]} into the compact internal shape
// [[{t, u?, d?}]]. URL buttons are http(s) only (opened in the user's browser, never fetched
// server-side); callback buttons carry ≤64-char data. Returns null when there's nothing valid.
function normalizeButtons(input) {
  if (typeof input === "string") { try { input = JSON.parse(input); } catch { return null; } }
  let rows = null;
  if (input && input.inline_keyboard) rows = input.inline_keyboard;
  else if (Array.isArray(input)) rows = Array.isArray(input[0]) ? input : [input];
  if (!Array.isArray(rows)) return null;
  const out = [];
  for (const row of rows.slice(0, 10)) {
    if (!Array.isArray(row)) continue;
    const r = [];
    for (const b of row.slice(0, 8)) {
      if (!b || typeof b !== "object") continue;
      const t = String(b.text ?? b.t ?? "").slice(0, 64).trim();
      if (!t) continue;
      const url = String(b.url ?? b.u ?? "").trim();
      const data = String(b.callback_data ?? b.data ?? b.d ?? "").slice(0, 64);
      if (url && /^https?:\/\//i.test(url)) r.push({ t, u: url.slice(0, 500) });
      else if (data) r.push({ t, d: data });
    }
    if (r.length) out.push(r);
  }
  return out.length ? out : null;
}
// Pending callback-button presses: cbid → { login, ts }. answerCallbackQuery routes the bot's
// reply back to the user who tapped. Entries self-expire so the map can't grow unbounded.
const pendingCb = new Map();
setInterval(() => { const now = Date.now(); for (const [k, v] of pendingCb) if (now - v.ts > 120000) pendingCb.delete(k); }, 60000);

async function deliverMessage({ room, fromLogin, name, from, type, text, media, mediaName, localId, buttons, replyTo, fwdFrom, fwdName }) {
  const off = media ? offloadResult(media) : { media: null, size: 0 };
  const payload = {
    from: from || fromLogin, fromLogin, name, ts: Date.now(),
    type: media ? (type || "file") : "text",
    // Keep the caption on media too (was previously dropped) — up to 1024 chars, Telegram-style.
    text: String(text || "").slice(0, media ? 1024 : 4000),
    media: off.media, mediaSize: off.size || null, mediaName: (mediaName || "").slice(0, 255),
    buttons: buttons || null,
    replyTo: Number(replyTo) > 0 ? Number(replyTo) : null,
    fwdFrom: fwdFrom ? String(fwdFrom).slice(0, 24) : null,
    fwdName: fwdName ? String(fwdName).slice(0, 64) : null,
    localId: localId || null,
  };
  // Resolve the quote once, here, so every listener gets the snippet with the message and the
  // client never has to fetch a parent that's outside its loaded window. A parent in another
  // room (or gone) simply drops the reply link.
  if (payload.replyTo) {
    try {
      const rs = await replySnippet(payload.replyTo);
      if (rs && rs.room === room) { payload.replyName = rs.name; payload.replyType = rs.type; payload.replyText = rs.text; }
      else payload.replyTo = null;
    } catch { payload.replyTo = null; }
  }
  try { payload.id = await saveMessage({ room, ...payload }); } catch (e) { console.error("saveMessage", e.message); }
  if (!payload.id) return null;
  io.to(room).emit("message", payload);
  const capPrev = payload.text ? " " + payload.text.slice(0, 110) : "";
  const preview = payload.type === "text" ? payload.text.slice(0, 120)
    : payload.type === "image" || payload.type === "gif" ? "🖼" + (capPrev || " Photo")
    : payload.type === "video" ? "🎬" + (capPrev || " Video")
    : payload.type === "audio" ? "🎤 Voice" : "📎 " + (payload.mediaName || "File");
  let recips = [];
  const dmTo = dmPartner(room, fromLogin);
  if (dmTo) recips = [dmTo];
  else if (room.startsWith("@grp:")) { try { recips = await getGroupMembers(room.slice(5)); } catch {} }
  const mentions = resolveMentions(payload.text, recips, fromLogin);
  for (const login of recips) {
    if (login === fromLogin) continue;
    const mentioned = mentions.has(login);
    notifyUser(login, "dm-ping", { room, fromLogin, fromName: name, mention: mentioned });
    // A mention pushes even if the recipient is elsewhere; normal msgs push only when not in the room.
    if (mentioned || !isUserInRoom(login, room)) sendPush(login, { kind: "msg", title: name, body: (mentioned ? "@ " : "") + preview, room, icon: `${APP_ORIGIN}/api/avatar/${fromLogin}` });
  }
  maybeDeliverToBots(room, payload).catch((e) => console.error("bot fanout", e.message));
  return payload;
}

// ---------- Bot fan-out (deliver incoming messages to bot participants) ----------
async function maybeDeliverToBots(room, payload) {
  if (payload.fromLogin && await isBot(payload.fromLogin)) return; // don't echo a bot's own msg back
  // Which bots are in this chat?
  let botLogins = [];
  const dmTo = dmPartner(room, payload.fromLogin);
  if (dmTo) { if (await isBot(dmTo)) botLogins = [dmTo]; }
  else if (room.startsWith("@grp:")) {
    try { const members = await getGroupMembers(room.slice(5)); for (const m of members) if (m !== payload.fromLogin && await isBot(m)) botLogins.push(m); } catch {}
  }
  if (!botLogins.length) return;
  const isGroup = room.startsWith("@grp:");
  const text = payload.type === "text" ? (payload.text || "") : "";
  for (const botLogin of botLogins) {
    const bot = await getBot(botLogin);
    if (!bot) continue;
    // Group privacy: unless privacy is off, only deliver commands (/…) or @mentions of the bot.
    if (isGroup && bot.bot_privacy) {
      const mentioned = new RegExp("(^|\\s)@" + botLogin.replace(/[^a-z0-9_]/gi, "") + "\\b", "i").test(text);
      if (!(text.trim().startsWith("/") || mentioned)) continue;
    }
    const update = {
      // update_id is assigned per transport: the DB row id for getUpdates, a timestamp for webhooks
      message: {
        message_id: payload.id,
        from: { login: payload.fromLogin, name: payload.name, is_bot: false },
        chat: { id: room, type: isGroup ? "group" : "private" },
        date: Math.floor(payload.ts / 1000),
        text: payload.type === "text" ? payload.text : undefined,
        media_type: payload.type !== "text" ? payload.type : undefined,
        media: payload.media || undefined,
        media_name: payload.mediaName || undefined,
      },
    };
    if (bot.bot_webhook) {
      const body = JSON.stringify({ ...update, update_id: Date.now() });
      postBotWebhook(bot, body);
    } else {
      try { await queueBotUpdate(botLogin, JSON.stringify(update)); } catch (e) { console.error("queueBotUpdate", e.message); }
    }
  }
}
function postBotWebhook(bot, body) {
  const url = bot.bot_webhook;
  if (!safeHttpUrl(url)) return;
  const sig = crypto.createHmac("sha256", bot.bot_webhook_secret || "").update(body).digest("hex");
  const ctrl = new AbortController(); const tm = setTimeout(() => ctrl.abort(), 8000);
  fetch(url, { method: "POST", signal: ctrl.signal, headers: { "Content-Type": "application/json", "X-Dialog-Signature": "sha256=" + sig, "User-Agent": "DialogBot/1.0" }, body })
    .catch((e) => { /* webhook errors never affect human delivery */ })
    .finally(() => clearTimeout(tm));
}
// Block internal/loopback targets (SSRF guard, mirrors the link-preview check).
function safeHttpUrl(u) {
  if (!/^https:\/\//i.test(u)) return false;
  if (/\/\/(localhost|127\.|0\.0\.0\.0|\[::1\]|192\.168\.|10\.|169\.254\.|172\.(1[6-9]|2\d|3[01])\.)/i.test(u)) return false;
  return true;
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
// room -> { kind, host, hostName, state, ts }. In memory: an activity is a live session, not
// something worth surviving a restart.
const roomActivity = new Map();
const actPayload = (a) => (a ? { kind: a.kind, host: a.host, hostName: a.hostName, state: a.state } : null);
// The host leaving ends the session — everyone else is a viewer of their state.
function endActivityIfHost(room, login) {
  const cur = room && roomActivity.get(room);
  if (cur && cur.host === login) { roomActivity.delete(room); io.to(room).emit("activity", null); }
}

// login -> { type, name, detail, since } — what someone is playing/listening to right now.
// Deliberately in memory only: it's ephemeral by nature and worthless after a disconnect.
const richPresence = new Map();
// Who must not see it: the master switch plus the per-person list. Cached because presence is
// broadcast far more often than the settings change.
const rpPrefCache = new Map();   // login -> { on, hidden:Set, ts }
async function rpSettings(login) {
  const c = rpPrefCache.get(login);
  if (c && Date.now() - c.ts < 30000) return c;
  const [on, hidden] = await Promise.all([getRichPresencePref(login), listPresenceHidden(login)]);
  const v = { on, hidden: new Set(hidden), ts: Date.now() };
  rpPrefCache.set(login, v);
  return v;
}
function rpInvalidate(login) { rpPrefCache.delete(login); }
async function broadcastPresence(login) {
  const status = effectiveStatus(login);
  let friends = []; try { friends = await getFriendLogins(login); } catch {}
  const act = richPresence.get(login) || null;
  let rp = { on: true, hidden: new Set() };
  if (act) { try { rp = await rpSettings(login); } catch {} }
  for (const f of friends) {
    // The activity is filtered per recipient — the status itself always goes out.
    const activity = act && rp.on && !rp.hidden.has(f) ? act : null;
    notifyUser(f, "presence", { login, status, activity });
  }
}
// The client pushes what it's doing (a game, a track, watching together). Anything else is
// rejected: this is a presence line, not a free-form broadcast channel.
function normalizeActivity(a) {
  if (!a || typeof a !== "object") return null;
  const type = ["playing", "listening", "watching"].includes(a.type) ? a.type : null;
  const name = String(a.name || "").slice(0, 64).trim();
  if (!type || !name) return null;
  return { type, name, detail: String(a.detail || "").slice(0, 96), since: Number(a.since) || Date.now() };
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

// Анти-спам (авторитетно на сервере; клиент дублирует для мгновенного UX).
// Флуд: не более SPAM_MAX сообщений за SPAM_WINDOW_MS. Дубли: одинаковый текст
// подряд более SPAM_DUP_MAX раз за SPAM_DUP_WINDOW_MS — блокируем. Состояние держим
// на самом сокете (чистится при дисконнекте автоматически).
const SPAM_WINDOW_MS = 5000, SPAM_MAX = 8;
const SPAM_DUP_WINDOW_MS = 12000, SPAM_DUP_MAX = 4;
// true → сообщение пропустить молча; иначе вернёт причину ("flood" | "duplicate").
function spamReason(socket, text, isMedia) {
  const now = Date.now();
  socket._spamTimes = (socket._spamTimes || []).filter((ts) => now - ts < SPAM_WINDOW_MS);
  if (socket._spamTimes.length >= SPAM_MAX) return "flood";
  const t = isMedia ? "" : (text || "").trim();
  if (t && t === socket._spamLast && now - (socket._spamLastTs || 0) < SPAM_DUP_WINDOW_MS && (socket._spamDup || 1) + 1 >= SPAM_DUP_MAX) return "duplicate";
  // пропускаем → фиксируем состояние
  socket._spamTimes.push(now);
  if (t) {
    socket._spamDup = (t === socket._spamLast && now - (socket._spamLastTs || 0) < SPAM_DUP_WINDOW_MS) ? (socket._spamDup || 1) + 1 : 1;
    socket._spamLast = t; socket._spamLastTs = now;
  }
  return null;
}

io.on("connection", (socket) => {
  let currentRoom = null, userLogin = null, userName = null;
  const sockIp = normIp((socket.handshake.headers["x-forwarded-for"] || "").split(",")[0] || socket.handshake.address);
  socket._ip = sockIp;
  if (ipIsBanned(sockIp)) { socket.emit("banned", { ip: true }); socket.disconnect(true); return; }
  socket.emit("server-info", { region: SERVER_REGION });

  socket.on("latency", (cb) => { if (typeof cb === "function") cb(Date.now()); });

  socket.on("identify", async ({ token }) => {
    const p = await auth.userByToken(token); if (!p) return;
    userLogin = p.login; userName = p.name;
    socket._token = token; socket._authLogin = userLogin;
    setUserLastIp(userLogin, sockIp).catch(() => {});
    addUserSocket(userLogin, socket.id);
    if (!userStatus.has(userLogin)) { try { userStatus.set(userLogin, await getStatus(userLogin)); } catch {} }
    broadcastPresence(userLogin);
  });

  function doLeave() {
    if (!currentRoom) return;
    endActivityIfHost(currentRoom, userLogin);   // host walked out → the session goes with them
    sweepAutoChannel(currentRoom, userLogin);    // self-service voice room dies with its owner
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
    } else if (newRoom.startsWith("@ch:")) {
      // Server channel: membership of the owning server, plus the channel's own visibility.
      const ch = await getChannel(newRoom.slice(4));
      if (!ch || !(await canSeeChannel(ch, p.login))) { socket.emit("auth-error", "No access"); return; }
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
    try { socket.emit("pinned", { room: currentRoom, pinned: await getPinned(currentRoom) }); } catch {}
    { const a = roomActivity.get(currentRoom); if (a) socket.emit("activity", actPayload(a)); }
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
      const msgs = await messagesBefore(currentRoom, before, HISTORY_LIMIT);
      socket.emit("more-messages", { msgs, before });
    } catch (e) { console.error("load-more", e.message); }
  });

  // Load a window of history starting at `id` (jump to date, or jumping to a quoted message
  // that scrolled out of the loaded window). The client replaces its list with this window.
  socket.on("jump-to", async ({ id } = {}) => {
    if (!currentRoom || !userLogin) return;
    const from = Number(id) || 0;
    if (from <= 0) return;
    try {
      // A little context above the anchor so it doesn't land glued to the top edge.
      const before = await messagesBefore(currentRoom, from, 8);
      const after = await messagesFrom(currentRoom, from, HISTORY_LIMIT);
      socket.emit("jump-result", { msgs: [...before, ...after], anchorId: from });
    } catch (e) { console.error("jump-to", e.message); }
  });

  socket.on("message", async (msg) => {
    if (!currentRoom || !userLogin) return;
    // Анти-спам: дёшево отсекаем флуд/дубли до любой работы с БД и рассылки.
    const spam = spamReason(socket, msg.text, !!msg.media);
    if (spam) { socket.emit("rate-limited", { reason: spam, localId: msg.localId || null }); return; }
    const dmTo = dmPartner(currentRoom, userLogin);
    if (dmTo && !(await isBot(dmTo))) { // гейтинг ЛС (боты авто-принимают ЛС — гейт пропускаем)
      if (await isBlockedBy(userLogin, dmTo)) { socket.emit("dm-blocked", { partner: dmTo, reason: "blocked_by_recipient" }); return; }
      if (await isBlockedBy(dmTo, userLogin)) { socket.emit("dm-blocked", { partner: dmTo, reason: "blocked_sender" }); return; }
      // Recipient opted to accept DMs from anyone → let it straight through.
      const allowed = (await areFriends(userLogin, dmTo)) || (await shareGroup(userLogin, dmTo)) || (await dmOpen(dmTo));
      if (!allowed) {
        // Respect the recipient's friend-request preference before auto-creating one.
        if (!(await canFriendRequest(userLogin, dmTo))) { socket.emit("dm-blocked", { partner: dmTo, status: "blocked" }); return; }
        const status = await sendFriendRequest(userLogin, dmTo);
        socket.emit("dm-blocked", { partner: dmTo, status });
        notifyUser(dmTo, "relations-changed", {}); notifyUser(userLogin, "relations-changed", {});
        return;
      }
    }
    // Server channel: rules are read-only, news needs POST_NEWS, and a "post"-restricted
    // channel is staff-only. Same shape as the group-channel rule below.
    if (currentRoom.startsWith("@ch:")) {
      const ch = await getChannel(currentRoom.slice(4));
      if (ch && !(await canPostChannel(ch, userLogin))) { socket.emit("channel-readonly", { room: currentRoom }); return; }
    }
    // Channel (broadcast) group: only the owner + bots may post; everyone else is read-only.
    if (currentRoom.startsWith("@grp:")) {
      const g = await getGroup(currentRoom.slice(5));
      if (g && g.channel && g.owner !== userLogin && !(await isBot(userLogin))) { socket.emit("channel-readonly", { room: currentRoom }); return; }
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
    const payload = await deliverMessage({
      room: currentRoom, fromLogin: userLogin, name: userName, from: socket.id,
      type: msg.type, text: msg.text, media, mediaName, localId: msg.localId,
      replyTo: msg.replyTo, fwdFrom: msg.fwdFrom, fwdName: msg.fwdName,
    });
    // Сообщаем только после успешного сохранения: если БД не приняла медиа (max_allowed_packet),
    // не шлём ни broadcast, ни ACK, и отправляем отправителю ошибку.
    if (!payload) { socket.emit("file-rejected", { reason: "save_failed" }); return; }
    // Возвращаем автору ACK с id, чтобы клиент снял статус «отправляется».
    socket.emit("msg-ack", { localId: payload.localId, id: payload.id, room: currentRoom, ts: payload.ts });
  });

  // ---------- Activities (watch together / games) ----------
  // The server is a dumb, authenticated relay: it remembers WHICH activity a room is running
  // and who hosts it, and stamps every message with the sender's real login + display name so
  // a client can't put words in someone else's mouth. All game rules live in the host's client.
  socket.on("activity-start", ({ kind } = {}) => {
    if (!currentRoom || !userLogin) return;
    if (!["watch", "gartic", "golf"].includes(kind)) return;
    const cur = roomActivity.get(currentRoom);
    if (cur && cur.host !== userLogin) { socket.emit("activity-busy", { kind: cur.kind, hostName: cur.hostName }); return; }
    const act = { kind, host: userLogin, hostName: userName, state: null, ts: Date.now() };
    roomActivity.set(currentRoom, act);
    io.to(currentRoom).emit("activity", actPayload(act));
  });
  socket.on("activity-stop", () => {
    if (!currentRoom) return;
    const cur = roomActivity.get(currentRoom);
    if (!cur || cur.host !== userLogin) return;
    roomActivity.delete(currentRoom);
    io.to(currentRoom).emit("activity", null);
  });
  // Only the host publishes state — that's what makes the host authoritative for playback
  // position, round numbers and whose turn it is.
  socket.on("activity-state", (state) => {
    if (!currentRoom) return;
    const cur = roomActivity.get(currentRoom);
    if (!cur || cur.host !== userLogin) return;
    cur.state = state && typeof state === "object" ? state : null;
    cur.ts = Date.now();
    socket.to(currentRoom).emit("activity-state", cur.state);
  });
  // Everyone may send input (a guess, a drawing, a putt). Relayed to the room as-is.
  socket.on("activity-msg", (msg) => {
    if (!currentRoom || !userLogin) return;
    const cur = roomActivity.get(currentRoom); if (!cur) return;
    if (!msg || typeof msg !== "object") return;
    io.to(currentRoom).emit("activity-msg", { ...msg, from: userLogin, fromName: userName });
  });

  // Rich presence in/out. Sending null clears it.
  socket.on("presence-activity", async (a) => {
    if (!userLogin) return;
    const act = normalizeActivity(a);
    if (act) richPresence.set(userLogin, act); else richPresence.delete(userLogin);
    broadcastPresence(userLogin).catch(() => {});
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
  // A user tapped an inline callback button — hand it to the bot(s) in this chat as a
  // callback_query (webhook or getUpdates). The bot answers via answerCallbackQuery, which
  // routes a toast back to this user. `cb-answer` with no bot present just stops the spinner.
  socket.on("callback-query", async ({ id, data }) => {
    if (!currentRoom || !userLogin) return;
    const mid = Number(id) || 0; if (!mid) return;
    const cbData = String(data || "").slice(0, 64);
    let meta; try { meta = await getMessageMeta(mid); } catch { return; }
    if (!meta || meta.room !== currentRoom || !Array.isArray(meta.buttons)) return;
    // Anti-spoof: the pressed data must actually be a callback button on this message.
    if (!meta.buttons.some((row) => Array.isArray(row) && row.some((b) => b && b.d === cbData))) return;
    let botLogins = [];
    const dmTo = dmPartner(currentRoom, userLogin);
    if (dmTo) { if (await isBot(dmTo)) botLogins.push(dmTo); }
    else if (currentRoom.startsWith("@grp:")) {
      try { const members = await getGroupMembers(currentRoom.slice(5)); for (const m of members) if (await isBot(m)) botLogins.push(m); } catch {}
    }
    if (meta.fromLogin && !botLogins.includes(meta.fromLogin) && await isBot(meta.fromLogin)) botLogins.push(meta.fromLogin);
    if (!botLogins.length) { socket.emit("cb-answer", { cbid: null }); return; }
    const cbid = crypto.randomBytes(9).toString("hex");
    pendingCb.set(cbid, { login: userLogin, ts: Date.now() });
    const cbq = { callback_query: { id: cbid, from: { login: userLogin, name: userName, is_bot: false },
      message: { message_id: mid, chat: { id: currentRoom, type: currentRoom.startsWith("@grp:") ? "group" : "private" } }, data: cbData } };
    for (const botLogin of botLogins) {
      const bot = await getBot(botLogin); if (!bot) continue;
      if (bot.bot_webhook) postBotWebhook(bot, JSON.stringify({ ...cbq, update_id: Date.now() }));
      else queueBotUpdate(botLogin, JSON.stringify(cbq)).catch(() => {});
    }
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
    removeFromCall(currentRoom, socket.id);
  }
  socket.on("call-join", async ({ title } = {}) => {
    if (!currentRoom || !userLogin) return;
    // Channels are broadcast rooms — no calls in them. The UI hides the button; this is the
    // rule a hand-rolled client can't skip.
    if (currentRoom.startsWith("@grp:")) {
      try { const g = await getGroup(currentRoom.slice(5)); if (g && g.channel) { socket.emit("call-refused", { reason: "channel" }); return; } } catch {}
    }
    const c = getCall(currentRoom);
    // Locked group call: only the owner or someone already in it may join (checked before
    // the device-swap so a legitimate reconnect from another device isn't turned away).
    if (currentRoom.startsWith("@grp:")) {
      const mLock = callMeta.get(currentRoom);
      if (mLock && mLock.locked && ![...c.values()].some((v) => v.login === userLogin) && !(await isGroupOwner(currentRoom.slice(5), userLogin))) {
        socket.emit("call-locked"); return;
      }
    }
    // Same user already in a call on ANOTHER device/room → kick it (full
    // cleanup) so this device takes over; the old one shows a red notice.
    for (const [room, members] of [...callRooms]) {
      if (room === currentRoom) continue;
      for (const [sid, info] of [...members]) {
        if (info.login === userLogin && sid !== socket.id) {
          io.to(sid).emit("call-replaced", { reason: "other_device" });
          removeFromCall(room, sid);
        }
      }
    }
    // Same user's old sockets in THIS room (extra tab/device) → silent swap
    // (keep the call/meta running), old device still gets the notice.
    for (const [sid, info] of c) {
      if (info.login === userLogin && sid !== socket.id) {
        io.to(sid).emit("call-replaced", { reason: "other_device" });
        c.delete(sid);
      }
    }
    const wasEmpty = c.size === 0;
    c.set(socket.id, { name: userName, login: userLogin });
    broadcastCallState(currentRoom);
    // Mute-on-entry: a non-owner joining an ongoing group call starts muted if the owner set it.
    if (!wasEmpty && currentRoom.startsWith("@grp:")) {
      const mMoe = callMeta.get(currentRoom);
      if (mMoe && mMoe.muteOnEntry && !(await isGroupOwner(currentRoom.slice(5), userLogin))) socket.emit("call-forced", { action: "mute", by: "host" });
    }
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
          for (const login of (meta2.recips || [])) notifyUser(login, "call-cancelled", { room });
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
    const ringed = recips.filter((l) => l !== userLogin);
    const meta = callMeta.get(room); if (meta) meta.recips = ringed; // to dismiss on cancel
    for (const login of ringed) {
      notifyUser(login, "call-ring", payload);
      sendPush(login, { kind: "call", title: "📞 " + userName, body: payload.title, room, icon: `${APP_ORIGIN}/api/avatar/${userLogin}` });
    }
  });
  socket.on("call-leave", () => callLeave());

  // ---- Custom P2P WebRTC signalling relay (SDP offer/answer + ICE) ----
  // Relays a payload to a specific peer *login* that is in the same call room. No media ever
  // touches the server — it only forwards the tiny signalling messages between the two browsers.
  socket.on("rtc-signal", ({ to, data } = {}) => {
    if (!currentRoom || !userLogin || !to || !data) return;
    const members = callRooms.get(currentRoom); if (!members) return;
    // Sender must actually be in this call room (prevents relaying from outside a call).
    if (![...members.values()].some((v) => v.login === userLogin)) return;
    for (const [sid, info] of members) if (info.login === to && sid !== socket.id) io.to(sid).emit("rtc-signal", { from: userLogin, fromName: userName, data });
  });

  // Owner-only call moderation (group calls). Cooperative: the target's client obeys the signal.
  socket.on("call-mod", async ({ action, target } = {}) => {
    if (!currentRoom || !userLogin || !currentRoom.startsWith("@grp:")) return;
    if (!(await isGroupOwner(currentRoom.slice(5), userLogin))) return; // only the group owner
    const members = callRooms.get(currentRoom); if (!members) return;
    const emitTo = (login, ev, data) => { for (const [sid, info] of members) if (info.login === login) io.to(sid).emit(ev, data); };
    if (action === "mute" && target) emitTo(target, "call-forced", { action: "mute", by: userName });
    else if (action === "mute-all") { for (const info of members.values()) if (info.login !== userLogin) emitTo(info.login, "call-forced", { action: "mute", by: userName }); }
    else if (action === "kick" && target) { emitTo(target, "call-kicked", { by: userName }); for (const [sid, info] of [...members]) if (info.login === target) removeFromCall(currentRoom, sid); broadcastCallState(currentRoom); }
    else if (action === "lock" || action === "unlock") { const m = callMeta.get(currentRoom); if (m) { m.locked = action === "lock"; broadcastCallState(currentRoom); } }
    else if (action === "moe-on" || action === "moe-off") { const m = callMeta.get(currentRoom); if (m) { m.muteOnEntry = action === "moe-on"; broadcastCallState(currentRoom); } }
  });

  socket.on("set-status", async (status) => {
    if (!userLogin || !["online", "dnd", "invisible"].includes(status)) return;
    userStatus.set(userLogin, status);
    try { await updateProfile(userLogin, { status }); } catch {}
    broadcastPresence(userLogin);
  });

  socket.on("disconnect", () => {
    doLeave();
    if (userLogin) {
      removeUserSocket(userLogin, socket.id);
      if (!userSockets.has(userLogin)) { richPresence.delete(userLogin); broadcastPresence(userLogin); }
    }
  });
});

// ============================ REST: Servers ============================
// Permission bits. Owner implicitly has all of them; everyone else gets the OR of their roles.
const SERVER_PERMS = { MANAGE_SERVER: 1, MANAGE_ROLES: 2, KICK: 4, CREATE_VOICE: 8, POST_NEWS: 16 };
async function srvPerms(serverId, login) {
  const srv = await getServer(serverId);
  if (!srv) return { srv: null, perms: 0, owner: false };
  if (srv.owner === login) return { srv, perms: -1, owner: true };   // -1 = every bit set
  if (!(await isServerMember(serverId, login))) return { srv, perms: 0, owner: false, outsider: true };
  return { srv, perms: await memberPerms(serverId, login), owner: false };
}
const hasPerm = (p, bit) => p.owner || (p.perms & bit) === bit;
// Channel restrictions key off "is this person staff here", not off a specific bit: a
// view-locked channel is for the people who run the server.
const isStaff = (p) => p.owner || (p.perms & (SERVER_PERMS.MANAGE_SERVER | SERVER_PERMS.MANAGE_ROLES | SERVER_PERMS.KICK)) !== 0;
// Can this person even open the channel? (view-restricted channels are staff-only)
async function canSeeChannel(ch, login) {
  if (!ch) return false;
  if (!(await isServerMember(ch.serverId, login))) return false;
  if (ch.restrictMode !== "view") return true;
  return isStaff(await srvPerms(ch.serverId, login));
}
// Can they post in it? (rules are always read-only; "post" restriction is staff-only)
async function canPostChannel(ch, login) {
  if (!ch) return false;
  if (ch.kind === "rules") return isStaff(await srvPerms(ch.serverId, login));
  if (ch.kind === "news") { const p = await srvPerms(ch.serverId, login); return p.owner || (p.perms & SERVER_PERMS.POST_NEWS) === SERVER_PERMS.POST_NEWS || isStaff(p); }
  if (ch.restrictMode === "post" || ch.restrictMode === "view") return isStaff(await srvPerms(ch.serverId, login));
  return true;
}

app.get("/api/servers", async (req, res) => {
  try {
    const me = await authUser(req); if (!me) return res.status(401).json({ error: "unauth" });
    res.json({ servers: await listUserServers(me.login) });
  } catch (e) { console.error("servers", e.message); res.status(500).json({ error: "server error" }); }
});
app.post("/api/servers", async (req, res) => {
  try {
    const me = await authUser(req); if (!me) return res.status(401).json({ error: "unauth" });
    const name = String(req.body.name || "").trim();
    if (!name) return res.status(400).json({ error: "bad_name" });
    const id = await createServer(name.slice(0, 64), me.login);
    // Icon and tags come in with the create call so the whole thing is one dialog.
    if (typeof req.body.icon === "string" && req.body.icon.startsWith("data:")) await setServerIcon(id, req.body.icon.slice(0, 3_000_000));
    if (req.body.tags || req.body.about || req.body.isPublic !== undefined) {
      await updateServer(id, { tags: req.body.tags, about: req.body.about, isPublic: req.body.isPublic });
    }
    res.json({ ok: true, id });
  } catch (e) { console.error("server create", e.message); res.status(500).json({ error: "server error" }); }
});
app.get("/api/servers/public", async (req, res) => {
  try {
    const me = await authUser(req); if (!me) return res.status(401).json({ error: "unauth" });
    res.json({ servers: await listPublicServers(40) });
  } catch (e) { console.error("servers pub", e.message); res.status(500).json({ error: "server error" }); }
});
app.get("/api/servers/:id", async (req, res) => {
  try {
    const me = await authUser(req); if (!me) return res.status(401).json({ error: "unauth" });
    const id = req.params.id; if (!/^\d+$/.test(id)) return res.status(400).json({ error: "bad id" });
    const p = await srvPerms(id, me.login);
    if (!p.srv) return res.status(404).json({ error: "not_found" });
    if (p.outsider) return res.status(403).json({ error: "not_member" });
    const [chAll, roles, members] = await Promise.all([listChannels(id), listRoles(id), listServerMembers(id)]);
    const staff = isStaff(p);
    const channels = chAll
      .filter((c) => c.restrictMode !== "view" || staff)          // hidden channels stay hidden
      .map((c) => ({
        ...c,
        // The webhook URL is a secret — only staff ever see it.
        hook: staff && c.kind === "text" && c.hookSecret ? `${APP_ORIGIN}/api/hook/ch/${c.id}/${c.hookSecret}` : null,
        hookSecret: undefined,
        voice: c.kind === "voice" ? voiceOccupancy("@ch:" + c.id) : undefined,
      }));
    res.json({
      ok: true, server: p.srv, owner: p.owner, perms: p.owner ? -1 : p.perms, staff,
      permBits: SERVER_PERMS, roleLimit: SERVER_ROLE_LIMIT,
      channels,
      roles,
      members: members.map((m) => ({ login: m.login, name: m.name, status: m.status, roles: (m.roleIds || "").split(",").filter(Boolean).map(Number) })),
    });
  } catch (e) { console.error("server get", e.message); res.status(500).json({ error: "server error" }); }
});
app.post("/api/servers/:id", async (req, res) => {
  try {
    const me = await authUser(req); if (!me) return res.status(401).json({ error: "unauth" });
    const id = req.params.id;
    const p = await srvPerms(id, me.login);
    if (!p.srv) return res.status(404).json({ error: "not_found" });
    if (!hasPerm(p, SERVER_PERMS.MANAGE_SERVER)) return res.status(403).json({ error: "forbidden" });
    await updateServer(id, { name: req.body.name, about: req.body.about, isPublic: req.body.isPublic, tags: req.body.tags });
    if (typeof req.body.icon === "string") await setServerIcon(id, req.body.icon.slice(0, 3_000_000));
    notifyServer(id, "server-updated", { id: Number(id) });
    res.json({ ok: true });
  } catch (e) { console.error("server patch", e.message); res.status(500).json({ error: "server error" }); }
});
app.delete("/api/servers/:id", async (req, res) => {
  try {
    const me = await authUser(req); if (!me) return res.status(401).json({ error: "unauth" });
    const p = await srvPerms(req.params.id, me.login);
    if (!p.srv) return res.status(404).json({ error: "not_found" });
    if (!p.owner) return res.status(403).json({ error: "owner_only" });
    const members = await listServerMembers(req.params.id);
    await deleteServer(req.params.id);
    for (const m of members) notifyUser(m.login, "servers-changed", {});
    res.json({ ok: true });
  } catch (e) { console.error("server delete", e.message); res.status(500).json({ error: "server error" }); }
});
app.get("/api/server-icon/:id", async (req, res) => {
  try {
    const icon = await getServerIcon(req.params.id);
    if (!icon) return res.status(404).end();
    const m = /^data:(image\/[a-z+]+);base64,(.+)$/i.exec(icon);
    if (!m) return res.status(404).end();
    res.setHeader("Content-Type", m[1]);
    res.setHeader("Cache-Control", "public, max-age=300");
    res.end(Buffer.from(m[2], "base64"));
  } catch { res.status(404).end(); }
});
app.post("/api/servers/:id/join", async (req, res) => {
  try {
    const me = await authUser(req); if (!me) return res.status(401).json({ error: "unauth" });
    const srv = await getServer(req.params.id);
    if (!srv) return res.status(404).json({ error: "not_found" });
    if (!srv.isPublic) return res.status(403).json({ error: "invite_only" });
    await joinServer(srv.id, me.login);
    notifyServer(srv.id, "server-updated", { id: srv.id });
    res.json({ ok: true, id: srv.id });
  } catch (e) { console.error("server join", e.message); res.status(500).json({ error: "server error" }); }
});
app.post("/api/servers/:id/leave", async (req, res) => {
  try {
    const me = await authUser(req); if (!me) return res.status(401).json({ error: "unauth" });
    const p = await srvPerms(req.params.id, me.login);
    if (!p.srv) return res.status(404).json({ error: "not_found" });
    if (p.owner) return res.status(400).json({ error: "owner_cannot_leave" });
    await cleanupAutoChannels(req.params.id, me.login);
    await leaveServer(req.params.id, me.login);
    notifyServer(req.params.id, "server-updated", { id: Number(req.params.id) });
    res.json({ ok: true });
  } catch (e) { console.error("server leave", e.message); res.status(500).json({ error: "server error" }); }
});
app.post("/api/servers/:id/kick", async (req, res) => {
  try {
    const me = await authUser(req); if (!me) return res.status(401).json({ error: "unauth" });
    const p = await srvPerms(req.params.id, me.login);
    if (!p.srv) return res.status(404).json({ error: "not_found" });
    if (!hasPerm(p, SERVER_PERMS.KICK)) return res.status(403).json({ error: "forbidden" });
    const target = String(req.body.login || "").toLowerCase();
    if (target === p.srv.owner) return res.status(400).json({ error: "cannot_kick_owner" });
    await cleanupAutoChannels(req.params.id, target);
    await leaveServer(req.params.id, target);
    notifyUser(target, "servers-changed", {});
    notifyServer(req.params.id, "server-updated", { id: Number(req.params.id) });
    res.json({ ok: true });
  } catch (e) { console.error("server kick", e.message); res.status(500).json({ error: "server error" }); }
});

// ---- Channels ----
app.post("/api/servers/:id/channels", async (req, res) => {
  try {
    const me = await authUser(req); if (!me) return res.status(401).json({ error: "unauth" });
    const id = req.params.id;
    const p = await srvPerms(id, me.login);
    if (!p.srv) return res.status(404).json({ error: "not_found" });
    if (p.outsider) return res.status(403).json({ error: "not_member" });
    const kind = ["text", "voice", "rules", "news"].includes(req.body.kind) ? req.body.kind : "text";
    const auto = !!req.body.auto;
    // Self-service voice rooms: allowed with CREATE_VOICE (what moderators hand to "common
    // mortals"), one per person, and swept away when they leave it. Anything else needs
    // MANAGE_SERVER.
    if (auto) {
      if (kind !== "voice") return res.status(400).json({ error: "auto_voice_only" });
      if (!hasPerm(p, SERVER_PERMS.CREATE_VOICE)) return res.status(403).json({ error: "no_create_voice" });
      const existing = await autoChannelOf(id, me.login);
      if (existing) return res.json({ ok: true, id: existing, existed: true });
    } else if (!hasPerm(p, SERVER_PERMS.MANAGE_SERVER)) return res.status(403).json({ error: "forbidden" });
    const name = String(req.body.name || "").trim().slice(0, 48) || (auto ? me.name : kind);
    const chId = await createChannel(id, name, kind, auto ? me.login : null);
    notifyServer(id, "server-updated", { id: Number(id) });
    res.json({ ok: true, id: chId });
  } catch (e) { console.error("channel create", e.message); res.status(500).json({ error: "server error" }); }
});
app.post("/api/channels/:id", async (req, res) => {
  try {
    const me = await authUser(req); if (!me) return res.status(401).json({ error: "unauth" });
    const ch = await getChannel(req.params.id); if (!ch) return res.status(404).json({ error: "not_found" });
    const p = await srvPerms(ch.serverId, me.login);
    if (!hasPerm(p, SERVER_PERMS.MANAGE_SERVER) && ch.autoOwner !== me.login) return res.status(403).json({ error: "forbidden" });
    if (req.body.name) await renameChannel(ch.id, req.body.name);
    notifyServer(ch.serverId, "server-updated", { id: ch.serverId });
    res.json({ ok: true });
  } catch (e) { console.error("channel patch", e.message); res.status(500).json({ error: "server error" }); }
});
// Restriction + webhook management for one channel (moderator tools).
app.post("/api/channels/:id/restrict", async (req, res) => {
  try {
    const me = await authUser(req); if (!me) return res.status(401).json({ error: "unauth" });
    const ch = await getChannel(req.params.id); if (!ch) return res.status(404).json({ error: "not_found" });
    const p = await srvPerms(ch.serverId, me.login);
    if (!hasPerm(p, SERVER_PERMS.MANAGE_SERVER)) return res.status(403).json({ error: "forbidden" });
    await setChannelRestrict(ch.id, String(req.body.mode || "none"));
    notifyServer(ch.serverId, "server-updated", { id: ch.serverId });
    res.json({ ok: true });
  } catch (e) { console.error("channel restrict", e.message); res.status(500).json({ error: "server error" }); }
});
app.post("/api/channels/:id/hook", async (req, res) => {
  try {
    const me = await authUser(req); if (!me) return res.status(401).json({ error: "unauth" });
    const ch = await getChannel(req.params.id); if (!ch) return res.status(404).json({ error: "not_found" });
    const p = await srvPerms(ch.serverId, me.login);
    if (!hasPerm(p, SERVER_PERMS.MANAGE_SERVER)) return res.status(403).json({ error: "forbidden" });
    if (ch.kind !== "text") return res.status(400).json({ error: "text_only" });
    // `off` revokes; anything else (re)issues, which also rotates a leaked URL.
    const secret = req.body.off ? null : crypto.randomBytes(16).toString("hex");
    await setChannelHook(ch.id, secret);
    notifyServer(ch.serverId, "server-updated", { id: ch.serverId });
    res.json({ ok: true, hook: secret ? `${APP_ORIGIN}/api/hook/ch/${ch.id}/${secret}` : null });
  } catch (e) { console.error("channel hook", e.message); res.status(500).json({ error: "server error" }); }
});
// Incoming webhook for a text channel — same contract as the group-channel hook.
app.post("/api/hook/ch/:id/:secret", async (req, res) => {
  const id = req.params.id; if (!/^\d+$/.test(id)) return res.status(404).json({ error: "not_found" });
  const ch = await getChannelByHook(id, req.params.secret);
  if (!ch) return res.status(404).json({ error: "not_found" });
  const key = "ch" + id;
  if (Date.now() - (_hookLast.get(key) || 0) < 800) return res.status(429).json({ error: "rate_limited" });
  const text = String(req.body?.text || "").trim(); if (!text) return res.status(400).json({ error: "empty" });
  _hookLast.set(key, Date.now());
  const srv = await getServer(ch.serverId);
  const name = String(req.body?.name || ch.name || "Webhook").slice(0, 64);
  const buttons = normalizeButtons(req.body?.reply_markup || req.body?.buttons);
  try {
    await deliverMessage({ room: "@ch:" + id, fromLogin: srv ? srv.owner : null, name, type: "text", text: text.slice(0, 4000), buttons });
    res.json({ ok: true });
  } catch (e) { console.error("ch hook", e.message); res.status(500).json({ error: "server error" }); }
});
app.delete("/api/channels/:id", async (req, res) => {
  try {
    const me = await authUser(req); if (!me) return res.status(401).json({ error: "unauth" });
    const ch = await getChannel(req.params.id); if (!ch) return res.status(404).json({ error: "not_found" });
    const p = await srvPerms(ch.serverId, me.login);
    if (!hasPerm(p, SERVER_PERMS.MANAGE_SERVER) && ch.autoOwner !== me.login) return res.status(403).json({ error: "forbidden" });
    await deleteChannel(ch.id);
    notifyServer(ch.serverId, "server-updated", { id: ch.serverId });
    res.json({ ok: true });
  } catch (e) { console.error("channel delete", e.message); res.status(500).json({ error: "server error" }); }
});

// ---- Roles ----
app.post("/api/servers/:id/roles", async (req, res) => {
  try {
    const me = await authUser(req); if (!me) return res.status(401).json({ error: "unauth" });
    const id = req.params.id;
    const p = await srvPerms(id, me.login);
    if (!p.srv) return res.status(404).json({ error: "not_found" });
    if (!hasPerm(p, SERVER_PERMS.MANAGE_ROLES)) return res.status(403).json({ error: "forbidden" });
    if (await countRoles(id) >= SERVER_ROLE_LIMIT) return res.status(400).json({ error: "role_limit", limit: SERVER_ROLE_LIMIT });
    const roleId = await createRole(id, req.body.name || "role", req.body.color, req.body.perms);
    notifyServer(id, "server-updated", { id: Number(id) });
    res.json({ ok: true, id: roleId });
  } catch (e) { console.error("role create", e.message); res.status(500).json({ error: "server error" }); }
});
app.post("/api/servers/:id/roles/:roleId", async (req, res) => {
  try {
    const me = await authUser(req); if (!me) return res.status(401).json({ error: "unauth" });
    const p = await srvPerms(req.params.id, me.login);
    if (!p.srv) return res.status(404).json({ error: "not_found" });
    if (!hasPerm(p, SERVER_PERMS.MANAGE_ROLES)) return res.status(403).json({ error: "forbidden" });
    if (req.body.assign !== undefined) await setMemberRole(req.params.id, String(req.body.login || "").toLowerCase(), Number(req.params.roleId), !!req.body.assign);
    else await updateRole(Number(req.params.roleId), { name: req.body.name, color: req.body.color, perms: req.body.perms });
    notifyServer(req.params.id, "server-updated", { id: Number(req.params.id) });
    res.json({ ok: true });
  } catch (e) { console.error("role patch", e.message); res.status(500).json({ error: "server error" }); }
});
app.delete("/api/servers/:id/roles/:roleId", async (req, res) => {
  try {
    const me = await authUser(req); if (!me) return res.status(401).json({ error: "unauth" });
    const p = await srvPerms(req.params.id, me.login);
    if (!p.srv) return res.status(404).json({ error: "not_found" });
    if (!hasPerm(p, SERVER_PERMS.MANAGE_ROLES)) return res.status(403).json({ error: "forbidden" });
    await deleteRole(Number(req.params.roleId));
    notifyServer(req.params.id, "server-updated", { id: Number(req.params.id) });
    res.json({ ok: true });
  } catch (e) { console.error("role delete", e.message); res.status(500).json({ error: "server error" }); }
});

// Tell every member of a server that something changed.
async function notifyServer(id, event, payload) {
  try { for (const m of await listServerMembers(id)) notifyUser(m.login, event, payload); } catch {}
}
// Drop the self-service voice rooms someone owns here (they left, were kicked, or hung up).
async function cleanupAutoChannels(serverId, login) {
  try {
    const chId = await autoChannelOf(serverId, login);
    if (chId) { await deleteChannel(chId); notifyServer(serverId, "server-updated", { id: Number(serverId) }); }
  } catch {}
}
// The one an auto-room really depends on: leaving the voice room deletes it.
async function sweepAutoChannel(room, login) {
  if (!room || !room.startsWith("@ch:")) return;
  try {
    const ch = await getChannel(room.slice(4));
    if (ch && ch.autoOwner === login) { await deleteChannel(ch.id); notifyServer(ch.serverId, "server-updated", { id: ch.serverId }); }
  } catch {}
}

// ---------- REST: rich presence privacy ----------
app.get("/api/presence-privacy", async (req, res) => {
  try {
    const me = await authUser(req); if (!me) return res.status(401).json({ error: "unauth" });
    const [on, hidden] = await Promise.all([getRichPresencePref(me.login), listPresenceHidden(me.login)]);
    res.json({ on, hidden });
  } catch (e) { console.error("rp get", e.message); res.status(500).json({ error: "server error" }); }
});
app.post("/api/presence-privacy", async (req, res) => {
  try {
    const me = await authUser(req); if (!me) return res.status(401).json({ error: "unauth" });
    if (req.body.on !== undefined) await setRichPresencePref(me.login, !!req.body.on);
    if (req.body.target) await setPresenceHidden(me.login, String(req.body.target).toLowerCase(), !!req.body.hidden);
    rpInvalidate(me.login);
    broadcastPresence(me.login).catch(() => {});   // apply immediately, don't wait for the cache
    res.json({ ok: true });
  } catch (e) { console.error("rp set", e.message); res.status(500).json({ error: "server error" }); }
});

// ---------- REST: group add requests (invitations) ----------
app.get("/api/group-invites", async (req, res) => {
  try {
    const me = await authUser(req); if (!me) return res.status(401).json({ error: "unauth" });
    res.json({ invites: await listGroupAddRequests(me.login) });
  } catch (e) { console.error("group invites", e.message); res.status(500).json({ error: "server error" }); }
});
app.post("/api/group-invites/:id/:action", async (req, res) => {
  try {
    const me = await authUser(req); if (!me) return res.status(401).json({ error: "unauth" });
    const r = await getGroupAddRequest(Number(req.params.id) || 0, me.login);
    if (!r) return res.status(404).json({ error: "not_found" });
    const action = req.params.action;
    if (action === "accept") {
      await addGroupMembers(r.groupId, [me.login]);
      await deleteGroupAddRequest(r.id);
      const room = "@grp:" + r.groupId;
      saveSystemMessage(room, me.login, me.name, "join", "");
      notifyUser(me.login, "groups-changed", {});
      notifyUser(r.fromLogin, "group-updated", { id: r.groupId });
      io.to(room).emit("group-updated", { id: r.groupId });
      return res.json({ ok: true, groupId: r.groupId });
    }
    if (action === "decline") { await deleteGroupAddRequest(r.id); return res.json({ ok: true }); }
    res.status(400).json({ error: "bad_action" });
  } catch (e) { console.error("group invite action", e.message); res.status(500).json({ error: "server error" }); }
});

// ---------- Room access (shared by search / jump / pin / schedule) ----------
// A DM room encodes both participants; a group room has to be checked against membership.
async function canAccessRoom(login, room) {
  if (!login || typeof room !== "string") return false;
  if (room.startsWith("@dm:")) return room.slice(4).split("~").includes(login);
  if (room.startsWith("@grp:")) { try { return await isGroupMember(room.slice(5), login); } catch { return false; } }
  if (room.startsWith("@ch:")) {
    try { return await canSeeChannel(await getChannel(room.slice(4)), login); } catch { return false; }
  }
  return false;
}

// ---------- REST: in-chat search + jump to date ----------
app.get("/api/search", async (req, res) => {
  try {
    const me = await authUser(req); if (!me) return res.status(401).json({ error: "unauth" });
    const room = String(req.query.room || ""), q = String(req.query.q || "").trim();
    if (!q || q.length < 2) return res.json({ results: [] });
    if (!(await canAccessRoom(me.login, room))) return res.status(403).json({ error: "forbidden" });
    res.json({ results: await searchMessages(room, q, 40) });
  } catch (e) { console.error("search", e.message); res.status(500).json({ error: "server error" }); }
});
// Resolve a picked day (local midnight, sent as epoch ms) to the first message id on/after it.
app.get("/api/jump", async (req, res) => {
  try {
    const me = await authUser(req); if (!me) return res.status(401).json({ error: "unauth" });
    const room = String(req.query.room || ""), ts = Number(req.query.ts) || 0;
    if (!(await canAccessRoom(me.login, room))) return res.status(403).json({ error: "forbidden" });
    res.json({ id: await firstMessageIdAtOrAfter(room, ts) });
  } catch (e) { console.error("jump", e.message); res.status(500).json({ error: "server error" }); }
});

// ---------- REST: pinned message ----------
// Groups/channels: owner only. DMs: either participant. Passing id=null unpins.
app.post("/api/pin", async (req, res) => {
  try {
    const me = await authUser(req); if (!me) return res.status(401).json({ error: "unauth" });
    const room = String(req.body.room || ""); const id = req.body.id ? Number(req.body.id) : null;
    if (!(await canAccessRoom(me.login, room))) return res.status(403).json({ error: "forbidden" });
    if (room.startsWith("@grp:") && !(await isGroupOwner(room.slice(5), me.login))) return res.status(403).json({ error: "owner_only" });
    await pinMessage(room, id);
    const pinned = await getPinned(room);
    io.to(room).emit("pinned", { room, pinned });
    res.json({ ok: true, pinned });
  } catch (e) { console.error("pin", e.message); res.status(500).json({ error: "server error" }); }
});

// ---------- REST: signed-in devices ----------
app.get("/api/sessions", async (req, res) => {
  try {
    const me = await authUser(req); if (!me) return res.status(401).json({ error: "unauth" });
    const cur = bearer(req);
    const rows = await listSessions(me.login);
    res.json({ sessions: rows.map((s) => ({
      id: s.token.slice(0, 12),          // never hand the full token back to the page
      current: s.token === cur,
      ua: s.ua || "", ip: s.ip || "", lastSeen: Number(s.lastSeen) || 0, createdAt: Number(s.createdAt) || 0,
    })) });
  } catch (e) { console.error("sessions", e.message); res.status(500).json({ error: "server error" }); }
});
app.post("/api/sessions/revoke", async (req, res) => {
  try {
    const me = await authUser(req); if (!me) return res.status(401).json({ error: "unauth" });
    const cur = bearer(req);
    if (req.body.others) {
      const rows = await listSessions(me.login);
      for (const s of rows) if (s.token !== cur) await auth.logout(s.token); // clears the Redis copy too
      return res.json({ ok: true, revoked: await deleteOtherSessions(me.login, cur) });
    }
    const id = String(req.body.id || "");
    const rows = await listSessions(me.login);
    const target = rows.find((s) => s.token.slice(0, 12) === id);
    if (!target) return res.status(404).json({ error: "not_found" });
    if (target.token === cur) return res.status(400).json({ error: "current_session" });
    await auth.logout(target.token);
    await deleteSessionOf(me.login, target.token);
    res.json({ ok: true });
  } catch (e) { console.error("revoke", e.message); res.status(500).json({ error: "server error" }); }
});

// ---------- REST: two-factor (TOTP) ----------
app.get("/api/2fa", async (req, res) => {
  try {
    const me = await authUser(req); if (!me) return res.status(401).json({ error: "unauth" });
    const t = await getTotp(me.login);
    res.json({ enabled: !!(t && t.enabled) });
  } catch { res.status(500).json({ error: "server error" }); }
});
// Hands back a fresh secret + otpauth URI. Nothing is enforced until /enable verifies a code,
// so abandoning setup here can never lock the account.
app.post("/api/2fa/setup", async (req, res) => {
  try {
    const me = await authUser(req); if (!me) return res.status(401).json({ error: "unauth" });
    const secret = auth.newTotpSecret();
    await setTotpSecret(me.login, secret);
    res.json({ secret, uri: auth.totpUri(me.login, secret) });
  } catch (e) { console.error("2fa setup", e.message); res.status(500).json({ error: "server error" }); }
});
app.post("/api/2fa/enable", async (req, res) => {
  try {
    const me = await authUser(req); if (!me) return res.status(401).json({ error: "unauth" });
    const t = await getTotp(me.login);
    if (!t || !t.secret) return res.status(400).json({ error: "no_setup" });
    if (!auth.totpVerify(t.secret, req.body.code)) return res.status(400).json({ error: "bad_code" });
    await enableTotp(me.login);
    res.json({ ok: true });
  } catch (e) { console.error("2fa enable", e.message); res.status(500).json({ error: "server error" }); }
});
// Turning 2FA off re-checks the password: a borrowed unlocked session shouldn't be able to
// quietly strip the second factor.
app.post("/api/2fa/disable", async (req, res) => {
  try {
    const me = await authUser(req); if (!me) return res.status(401).json({ error: "unauth" });
    const u = await getUser(me.login);
    if (!u || !(await auth.verifyPassword(u, String(req.body.password || "")))) return res.status(400).json({ error: "bad_password" });
    await disableTotp(me.login);
    res.json({ ok: true });
  } catch (e) { console.error("2fa disable", e.message); res.status(500).json({ error: "server error" }); }
});

// ---------- REST: data export ----------
app.get("/api/export", async (req, res) => {
  try {
    const me = await authUser(req); if (!me) return res.status(401).json({ error: "unauth" });
    const data = await exportAccount(me.login);
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    res.setHeader("Content-Disposition", `attachment; filename="dialog-${me.login}-export.json"`);
    res.end(JSON.stringify(data, null, 2));
  } catch (e) { console.error("export", e.message); res.status(500).json({ error: "server error" }); }
});

// ---------- REST: public directory (opt-in channels + bots) ----------
app.get("/api/directory", async (req, res) => {
  try {
    const me = await authUser(req); if (!me) return res.status(401).json({ error: "unauth" });
    const [groups, bots] = await Promise.all([listPublicGroups(60), listPublicBots(60)]);
    res.json({ groups, bots });
  } catch (e) { console.error("directory", e.message); res.status(500).json({ error: "server error" }); }
});
app.post("/api/groups/:id/public", async (req, res) => {
  try {
    const me = await authUser(req); if (!me) return res.status(401).json({ error: "unauth" });
    const id = req.params.id;
    if (!/^\d+$/.test(id)) return res.status(400).json({ error: "bad id" });
    if (!(await isGroupOwner(id, me.login))) return res.status(403).json({ error: "owner_only" });
    await setGroupPublic(id, !!req.body.on, req.body.about);
    res.json({ ok: true });
  } catch (e) { console.error("group public", e.message); res.status(500).json({ error: "server error" }); }
});
app.post("/api/bots/:login/public", async (req, res) => {
  try {
    const me = await authUser(req); if (!me) return res.status(401).json({ error: "unauth" });
    const ok = await setBotPublic(String(req.params.login || "").toLowerCase(), me.login, !!req.body.on);
    if (!ok) return res.status(403).json({ error: "not_your_bot" });
    res.json({ ok: true });
  } catch (e) { console.error("bot public", e.message); res.status(500).json({ error: "server error" }); }
});

// ---------- REST: scheduled channel posts ----------
app.get("/api/schedule", async (req, res) => {
  try {
    const me = await authUser(req); if (!me) return res.status(401).json({ error: "unauth" });
    const room = String(req.query.room || "");
    if (!(await canAccessRoom(me.login, room))) return res.status(403).json({ error: "forbidden" });
    res.json({ posts: await listScheduled(room) });
  } catch (e) { console.error("schedule list", e.message); res.status(500).json({ error: "server error" }); }
});
app.post("/api/schedule", async (req, res) => {
  try {
    const me = await authUser(req); if (!me) return res.status(401).json({ error: "unauth" });
    const room = String(req.body.room || ""), text = String(req.body.text || "").trim();
    const due = Number(req.body.due) || 0;
    if (!text) return res.status(400).json({ error: "empty" });
    if (due < Date.now() - 60000) return res.status(400).json({ error: "past" });
    if (!(await canAccessRoom(me.login, room))) return res.status(403).json({ error: "forbidden" });
    // Same posting rule as live messages: in a channel only the owner may publish.
    if (room.startsWith("@grp:")) {
      const g = await getGroup(room.slice(5));
      if (g && g.channel && g.owner !== me.login) return res.status(403).json({ error: "channel_readonly" });
    }
    const id = await createScheduled(room, me.login, me.name, text, due);
    res.json({ ok: true, id });
  } catch (e) { console.error("schedule add", e.message); res.status(500).json({ error: "server error" }); }
});
app.delete("/api/schedule/:id", async (req, res) => {
  try {
    const me = await authUser(req); if (!me) return res.status(401).json({ error: "unauth" });
    const ok = await deleteScheduled(Number(req.params.id) || 0, me.login);
    res.json({ ok });
  } catch (e) { console.error("schedule del", e.message); res.status(500).json({ error: "server error" }); }
});
// Sweeper: publishes anything whose time has come. 30s granularity is plenty for "post later"
// and costs one indexed query per tick.
setInterval(async () => {
  try {
    const due = await dueScheduled(Date.now(), 20);
    for (const p of due) {
      await markScheduledSent(p.id);   // mark first: a delivery failure must not loop forever
      await deliverMessage({ room: p.room, fromLogin: p.fromLogin, name: p.name, type: "text", text: p.text });
    }
  } catch (e) { console.error("schedule sweep", e.message); }
}, 30000);

// SPA fallback — serve index.html for all non-API paths (needed for /en/@user, /ru/group/1, etc.)
app.get(/^\/(?!api\/|src\/|js\/|css\/|socket\.io\/)/, (req, res) => {
  res.sendFile(join(__dirname, "public", "index.html"));
});

// ---------- Старт ----------
async function start() {
  await waitForDb(); await initSchema(); console.log("MySQL подключён, схема готова");
  try { for (const r of await listBannedIps()) bannedIps.set(normIp(r.ip), r.expires == null ? null : Number(r.expires)); } catch {}
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

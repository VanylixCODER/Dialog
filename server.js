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
  updateProfile, getAvatar, getBanner, getProfileCard, getStatus, getUser,
  createBot, isBot, getBotByTokenHash, getBot, listBotsByOwner, countBotsByOwner, updateBot, setBotTokenHash, deleteBot,
  queueBotUpdate, getBotUpdates, deleteBotUpdatesBelow, pruneBotUpdates,
  setRelation, removeRelation, getRelationsFull, getFriendLogins, areFriends, shareGroup, isBlockedBy,
  sendFriendRequest, acceptFriend, declineFriend, removeFriend, haveMutualFriend,
  getPrefs, setPrefs, bumpInviteUse,
  getUserThemes, getTheme, saveTheme, deleteTheme, setThemePublished, countPublished, listWorkshop, incThemeInstalls, THEME_LIMITS,
  getUserDMs, saveUserDMs,
  getPinnedChats, savePinnedChats,
  savePushSub, getPushSubs, deletePushSub,
  getRoomWatermarks, bumpWatermarks,
  getUserByEmail, setUserEmail, markEmailVerified, setNagDismissed,
  createEmailToken, getEmailToken, deleteEmailToken,
  adminListUsers, adminStats, setUserBanned, setUserName, setUserLastIp,
  isIpBanned, banIp, unbanIp, listBannedIps,
  createReport, listReports, getReport, resolveReport, countPendingReports,
  setUserReportBan, clearUserReport, setEmailWithStamp,
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
    const { login, password } = req.body;
    const out = await auth.login(login, password);
    setUserLastIp(out.profile.login, normIp(req.ip)).catch(() => {});
    res.json(out);
  } catch (e) { res.status(400).json({ error: e.message }); }
});
app.get("/api/me", async (req, res) => {
  const me = await authUser(req);
  if (!me) return res.status(401).json({ error: "unauth" });
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
    // Skip anyone who has turned off "friends can add me to groups".
    const requested = req.body.add.map((l) => String(l).toLowerCase());
    const logins = [];
    for (const l of requested) { if ((await getPrefs(l)).groupAdd) logins.push(l); }
    const blocked = requested.filter((l) => !logins.includes(l));
    await addGroupMembers(id, logins);
    for (const login of logins) {
      const u = await getUser(login);
      if (u) saveSystemMessage(room, login, u.name, "join", "");
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
    if (!(await canFriendRequest(me.login, target))) return res.status(403).json({ error: "req_blocked" });
    await sendFriendRequest(me.login, target);
  }
  else if (action === "accept") await acceptFriend(me.login, target);
  else if (action === "decline") await declineFriend(me.login, target);
  else if (action === "remove") await removeFriend(me.login, target);
  else return res.status(400).json({ error: "bad action" });
  notifyUser(target, "relations-changed", {}); notifyUser(me.login, "relations-changed", {});
  res.json({ ok: true });
});

// ---------- REST: DM синхронизация ----------
app.get("/api/dms", async (req, res) => {
  const me = await authUser(req); if (!me) return res.status(401).json({ error: "unauth" });
  res.json(await getUserDMs(me.login));
});
app.post("/api/dms", async (req, res) => {
  const me = await authUser(req); if (!me) return res.status(401).json({ error: "unauth" });
  const list = Array.isArray(req.body.dms) ? req.body.dms.slice(0, 50) : [];
  await saveUserDMs(me.login, list);
  res.json({ ok: true });
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
  await setUserBanned(login, banned);
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
const BOT_CAP = 10;
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
  res.json({ ok: true, cap: BOT_CAP, bots: bots.map((b) => ({ login: b.login, name: b.name, description: b.description || "", webhook: b.bot_webhook || "", privacy: !!b.bot_privacy, commands: safeJson(b.bot_commands), created_at: b.created_at })) });
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
      case "getMe": return okr({ id: bot.login, login: bot.login, name: bot.name, is_bot: true, description: bot.description || "" });
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
        if (!room) return err(400, "message not editable"); io.to(room).emit("msg-edited", { id, text }); return okr(true);
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
  const payload = await deliverMessage({ room, fromLogin: bot.login, name: bot.name, from: "bot:" + bot.login, type, text, media, mediaName });
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
  return { room, count: logins.length, logins };
}
function broadcastCallState(room) { io.to(room).emit("call-state", callStatePayload(room)); }
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
async function deliverMessage({ room, fromLogin, name, from, type, text, media, mediaName, localId }) {
  const payload = {
    from: from || fromLogin, fromLogin, name, ts: Date.now(),
    type: media ? (type || "file") : "text",
    text: media ? "" : String(text || "").slice(0, 4000),
    media: media || null, mediaName: (mediaName || "").slice(0, 255),
    localId: localId || null,
  };
  try { payload.id = await saveMessage({ room, ...payload }); } catch (e) { console.error("saveMessage", e.message); }
  if (!payload.id) return null;
  io.to(room).emit("message", payload);
  const preview = payload.type === "text" ? payload.text.slice(0, 120)
    : payload.type === "image" || payload.type === "gif" ? "🖼 Photo"
    : payload.type === "video" ? "🎬 Video"
    : payload.type === "audio" ? "🎤 Voice" : "📎 " + (payload.mediaName || "File");
  let recips = [];
  const dmTo = dmPartner(room, fromLogin);
  if (dmTo) recips = [dmTo];
  else if (room.startsWith("@grp:")) { try { recips = await getGroupMembers(room.slice(5)); } catch {} }
  for (const login of recips) {
    if (login === fromLogin) continue;
    notifyUser(login, "dm-ping", { room, fromLogin, fromName: name });
    if (!isUserInRoom(login, room)) sendPush(login, { kind: "msg", title: name, body: preview, room });
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
      const msgs = await messagesBefore(currentRoom, before, HISTORY_LIMIT);
      socket.emit("more-messages", { msgs, before });
    } catch (e) { console.error("load-more", e.message); }
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
      const allowed = (await areFriends(userLogin, dmTo)) || (await shareGroup(userLogin, dmTo));
      if (!allowed) {
        // Respect the recipient's friend-request preference before auto-creating one.
        if (!(await canFriendRequest(userLogin, dmTo))) { socket.emit("dm-blocked", { partner: dmTo, status: "blocked" }); return; }
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
    const payload = await deliverMessage({
      room: currentRoom, fromLogin: userLogin, name: userName, from: socket.id,
      type: msg.type, text: msg.text, media, mediaName, localId: msg.localId,
    });
    // Сообщаем только после успешного сохранения: если БД не приняла медиа (max_allowed_packet),
    // не шлём ни broadcast, ни ACK, и отправляем отправителю ошибку.
    if (!payload) { socket.emit("file-rejected", { reason: "save_failed" }); return; }
    // Возвращаем автору ACK с id, чтобы клиент снял статус «отправляется».
    socket.emit("msg-ack", { localId: payload.localId, id: payload.id, room: currentRoom, ts: payload.ts });
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
    removeFromCall(currentRoom, socket.id);
  }
  socket.on("call-join", async ({ title } = {}) => {
    if (!currentRoom || !userLogin) return;
    const c = getCall(currentRoom);
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

// Аутентификация: scrypt-хеш паролей + токен-сессии в БД (с кэшем в Redis).
import { randomBytes, scrypt, timingSafeEqual } from "crypto";
import { promisify } from "util";
import * as db from "./db.js";
import { cacheGet, cacheSet, cacheDel } from "./cache.js";

const scryptAsync = promisify(scrypt);
const SESS_TTL = 7 * 24 * 3600; // кэш сессии — неделя

// Admin accounts (comma-separated logins via env, default "admin").
export const ADMIN_LOGINS = new Set(
  (process.env.ADMIN_LOGINS || "admin").split(",").map((s) => s.trim().toLowerCase()).filter(Boolean)
);
export const isAdmin = (login) => ADMIN_LOGINS.has(String(login || "").toLowerCase());

const hashPw = async (password, salt) => (await scryptAsync(password, salt, 64)).toString("hex");

export const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

export async function register(login, name, password, email) {
  login = String(login || "").trim().toLowerCase();
  name = String(name || "").trim() || login;
  email = String(email || "").trim().toLowerCase();
  if (!/^[a-z0-9_]{3,24}$/.test(login)) throw new Error("Логин: латиница/цифры, 3–24");
  if (String(password || "").length < 6) throw new Error("Пароль от 6 символов");
  // Email is required for new accounts (soft-verified afterwards).
  if (!EMAIL_RE.test(email) || email.length > 190) throw new Error("Введите корректный e-mail");
  if (await db.getUser(login)) throw new Error("Логин занят");
  if (await db.getUserByEmail(email)) throw new Error("E-mail уже используется");
  const salt = randomBytes(16).toString("hex");
  const hash = await hashPw(password, salt);
  await db.createUser(login, name, salt, hash, email);
  return issueToken(login);
}

// Constant-time password check against a user row.
async function pwMatches(u, password) {
  const calc = Buffer.from(await hashPw(password, u.salt), "hex");
  const stored = Buffer.from(u.hash, "hex");
  return calc.length === stored.length && timingSafeEqual(calc, stored);
}
export async function verifyPassword(u, password) { return pwMatches(u, password); }

// Set a new password (reset flow + profile change) — fresh salt+hash, stamps time.
export async function setPassword(login, password) {
  if (String(password || "").length < 6) throw new Error("Пароль от 6 символов");
  const salt = randomBytes(16).toString("hex");
  const hash = await hashPw(password, salt);
  await db.setUserPassword(login, salt, hash, Date.now());
}

// Log in by username OR email.
export async function login(identifier, password) {
  identifier = String(identifier || "").trim().toLowerCase();
  let u = null;
  if (EMAIL_RE.test(identifier)) {
    const byEmail = await db.getUserByEmail(identifier);
    if (byEmail) u = await db.getUser(byEmail.login);
  } else {
    u = await db.getUser(identifier);
  }
  if (!u) throw new Error("Неверный логин или пароль");
  if (!(await pwMatches(u, password))) throw new Error("Неверный логин или пароль");
  if (u.banned) throw new Error("Аккаунт заблокирован");
  const rbu = Number(u.report_ban_until) || 0;
  if (rbu && rbu > Date.now()) throw new Error("Аккаунт временно заблокирован до " + new Date(rbu).toLocaleString());
  return issueToken(u.login);
}

async function issueToken(loginName) {
  const token = randomBytes(32).toString("hex");
  await db.saveSession(token, loginName);
  const u = await db.getUser(loginName);
  const profile = profileOf(u);
  await cacheSet("sess:" + token, JSON.stringify(profile), SESS_TTL);
  return { token, profile };
}

export async function userByToken(token) {
  if (!token) return null;
  // DB-first, cache — best-effort. Если Redis недоступен, /api/me всё равно ответит 200/401 через БД.
  // Иначе любой 500 от недоступного кеша стерал бы токен на клиенте и разлогинивал юзера на каждом F5.
  try { const cached = await cacheGet("sess:" + token); if (cached) { try { return JSON.parse(cached); } catch {} } } catch {}
  let login = null, u = null;
  try { login = await db.sessionLogin(token); } catch { return null; }
  if (!login) return null;
  try { u = await db.getUser(login); } catch { return null; }
  if (!u) return null;
  if (u.banned) return null; // banned mid-session → token stops resolving
  const rbu = Number(u.report_ban_until) || 0;
  if (rbu && rbu > Date.now()) return null; // active report ban → kicked until it lapses
  const profile = profileOf(u);
  cacheSet("sess:" + token, JSON.stringify(profile), SESS_TTL).catch(() => {}); // best-effort, не блокируем ответ
  return profile;
}

export async function logout(token) {
  await db.deleteSession(token);
  await cacheDel("sess:" + token);
}

function profileOf(u) {
  const unstable = !!u.report_reason;
  return { login: u.login, name: u.name, description: u.description || "", status: u.status || "online",
           created_at: u.created_at,
           email: u.email || null, emailVerified: !!u.email_verified, nagDismissed: !!u.nag_dismissed,
           pwChangedAt: Number(u.pw_changed_at) || 0,
           emailChangedAt: Number(u.email_changed_at) || 0,
           streamProtect: !!u.stream_protect,
           accountStatus: unstable ? "unstable" : (u.email_verified ? "stable" : "unverified"),
           reportReason: unstable ? u.report_reason : null,
           reportBanMs: unstable ? (u.report_ban_ms == null ? null : Number(u.report_ban_ms)) : null,
           reportBanUntil: Number(u.report_ban_until) || 0,
           banned: !!u.banned, admin: isAdmin(u.login) };
}

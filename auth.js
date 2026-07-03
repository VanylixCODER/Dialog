// Аутентификация: scrypt-хеш паролей + токен-сессии в БД (с кэшем в Redis).
import { randomBytes, scrypt, timingSafeEqual } from "crypto";
import { promisify } from "util";
import * as db from "./db.js";
import { cacheGet, cacheSet, cacheDel } from "./cache.js";

const scryptAsync = promisify(scrypt);
const SESS_TTL = 7 * 24 * 3600; // кэш сессии — неделя

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

// Set a new password (used by the reset flow) — generates a fresh salt+hash.
export async function setPassword(login, password) {
  if (String(password || "").length < 6) throw new Error("Пароль от 6 символов");
  const salt = randomBytes(16).toString("hex");
  const hash = await hashPw(password, salt);
  await db.setUserPassword(login, salt, hash);
}

export async function login(loginName, password) {
  loginName = String(loginName || "").trim().toLowerCase();
  const u = await db.getUser(loginName);
  if (!u) throw new Error("Неверный логин или пароль");
  const calc = Buffer.from(await hashPw(password, u.salt), "hex");
  const stored = Buffer.from(u.hash, "hex");
  if (calc.length !== stored.length || !timingSafeEqual(calc, stored)) throw new Error("Неверный логин или пароль");
  return issueToken(loginName);
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
  const profile = profileOf(u);
  cacheSet("sess:" + token, JSON.stringify(profile), SESS_TTL).catch(() => {}); // best-effort, не блокируем ответ
  return profile;
}

export async function logout(token) {
  await db.deleteSession(token);
  await cacheDel("sess:" + token);
}

function profileOf(u) {
  return { login: u.login, name: u.name, description: u.description || "", status: u.status || "online",
           created_at: u.created_at,
           email: u.email || null, emailVerified: !!u.email_verified, nagDismissed: !!u.nag_dismissed };
}

// Аутентификация: scrypt-хеш паролей + токен-сессии в БД (с кэшем в Redis).
import { randomBytes, scrypt, timingSafeEqual } from "crypto";
import { promisify } from "util";
import * as db from "./db.js";
import { cacheGet, cacheSet, cacheDel } from "./cache.js";

const scryptAsync = promisify(scrypt);
const SESS_TTL = 7 * 24 * 3600; // кэш сессии — неделя

const hashPw = async (password, salt) => (await scryptAsync(password, salt, 64)).toString("hex");

export async function register(login, name, password) {
  login = String(login || "").trim().toLowerCase();
  name = String(name || "").trim() || login;
  if (!/^[a-z0-9_]{3,24}$/.test(login)) throw new Error("Логин: латиница/цифры, 3–24");
  if (String(password || "").length < 6) throw new Error("Пароль от 6 символов");
  if (await db.getUser(login)) throw new Error("Логин занят");
  const salt = randomBytes(16).toString("hex");
  const hash = await hashPw(password, salt);
  await db.createUser(login, name, salt, hash);
  return issueToken(login);
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
           created_at: u.created_at };
}

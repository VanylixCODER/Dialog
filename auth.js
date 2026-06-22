import { randomBytes, scryptSync, timingSafeEqual } from "crypto";
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = join(__dirname, "data");
const USERS_FILE = join(DATA_DIR, "users.json");

if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true });

// login -> { login, name, salt, hash, createdAt }
const users = new Map();
// token -> login (сессии живут в памяти, сбрасываются при рестарте)
const sessions = new Map();

function load() {
  if (!existsSync(USERS_FILE)) return;
  try {
    const arr = JSON.parse(readFileSync(USERS_FILE, "utf8"));
    arr.forEach((u) => users.set(u.login, u));
  } catch (e) {
    console.error("Не удалось прочитать users.json:", e.message);
  }
}
function persist() {
  writeFileSync(USERS_FILE, JSON.stringify([...users.values()], null, 2));
}
load();

function hashPassword(password, salt = randomBytes(16).toString("hex")) {
  const hash = scryptSync(password, salt, 64).toString("hex");
  return { salt, hash };
}
function verifyPassword(password, salt, expectedHash) {
  const { hash } = hashPassword(password, salt);
  const a = Buffer.from(hash, "hex");
  const b = Buffer.from(expectedHash, "hex");
  return a.length === b.length && timingSafeEqual(a, b);
}
function issueToken(login) {
  const token = randomBytes(24).toString("hex");
  sessions.set(token, login);
  return token;
}

export function register({ login, name, password }) {
  login = (login || "").trim().toLowerCase();
  name = (name || "").trim().slice(0, 32);
  if (!/^[a-z0-9_.-]{3,24}$/.test(login)) {
    return { error: "Логин: 3–24 символа, латиница, цифры, . _ -" };
  }
  if (!name) return { error: "Укажите отображаемое имя" };
  if (!password || password.length < 6) return { error: "Пароль минимум 6 символов" };
  if (users.has(login)) return { error: "Такой логин уже занят" };

  const { salt, hash } = hashPassword(password);
  const user = { login, name, salt, hash, createdAt: Date.now() };
  users.set(login, user);
  persist();
  const token = issueToken(login);
  return { token, profile: { login, name } };
}

export function login({ login, password }) {
  login = (login || "").trim().toLowerCase();
  const user = users.get(login);
  if (!user || !verifyPassword(password || "", user.salt, user.hash)) {
    return { error: "Неверный логин или пароль" };
  }
  const token = issueToken(login);
  return { token, profile: { login: user.login, name: user.name } };
}

// Возвращает профиль по токену или null
export function userByToken(token) {
  const login = sessions.get(token);
  if (!login) return null;
  const user = users.get(login);
  if (!user) return null;
  return { login: user.login, name: user.name };
}

export function logout(token) {
  sessions.delete(token);
}

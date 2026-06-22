import { randomBytes, scryptSync, timingSafeEqual } from "crypto";
import { query } from "./db.js";

// token -> login (сессии живут в памяти, сбрасываются при рестарте)
const sessions = new Map();

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

export async function register({ login, name, password }) {
  login = (login || "").trim().toLowerCase();
  name = (name || "").trim().slice(0, 32);
  if (!/^[a-z0-9_.-]{3,24}$/.test(login)) {
    return { error: "Логин: 3–24 символа, латиница, цифры, . _ -" };
  }
  if (!name) return { error: "Укажите отображаемое имя" };
  if (!password || password.length < 6) return { error: "Пароль минимум 6 символов" };

  const exists = await query("SELECT 1 FROM users WHERE login = ?", [login]);
  if (exists.length > 0) return { error: "Такой логин уже занят" };

  const { salt, hash } = hashPassword(password);
  await query(
    "INSERT INTO users (login, name, salt, hash) VALUES (?, ?, ?, ?)",
    [login, name, salt, hash]
  );
  const token = issueToken(login);
  return { token, profile: { login, name } };
}

export async function login({ login, password }) {
  login = (login || "").trim().toLowerCase();
  const rows = await query("SELECT login, name, salt, hash FROM users WHERE login = ?", [login]);
  const user = rows[0];
  if (!user || !verifyPassword(password || "", user.salt, user.hash)) {
    return { error: "Неверный логин или пароль" };
  }
  const token = issueToken(login);
  return { token, profile: { login: user.login, name: user.name } };
}

// Профиль по токену или null. Подтягиваем актуальное имя из БД.
export async function userByToken(token) {
  const login = sessions.get(token);
  if (!login) return null;
  const rows = await query("SELECT login, name FROM users WHERE login = ?", [login]);
  return rows[0] || null;
}

export function logout(token) {
  sessions.delete(token);
}

import { randomBytes, scryptSync, timingSafeEqual } from "crypto";
import { query } from "./db.js";

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
// Токен в БД — переживает рестарт/сон сервера (важно для Render free).
async function issueToken(login) {
  const token = randomBytes(24).toString("hex");
  await query("INSERT INTO sessions (token, login) VALUES (?, ?)", [token, login]);
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
  const token = await issueToken(login);
  return { token, profile: { login, name } };
}

export async function login({ login, password }) {
  login = (login || "").trim().toLowerCase();
  const rows = await query("SELECT login, name, salt, hash FROM users WHERE login = ?", [login]);
  const user = rows[0];
  if (!user || !verifyPassword(password || "", user.salt, user.hash)) {
    return { error: "Неверный логин или пароль" };
  }
  const token = await issueToken(login);
  return { token, profile: { login: user.login, name: user.name } };
}

// Профиль по токену или null — джойн сессии с пользователем.
export async function userByToken(token) {
  if (!token) return null;
  const rows = await query(
    "SELECT u.login, u.name FROM sessions s JOIN users u ON u.login = s.login WHERE s.token = ?",
    [token]
  );
  return rows[0] || null;
}

export async function logout(token) {
  await query("DELETE FROM sessions WHERE token = ?", [token]);
}

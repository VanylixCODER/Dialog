import mysql from "mysql2/promise";
import { cacheGet, cacheSet, cacheDel } from "./cache.js";

const HIST_TTL = 60;              // история комнаты живёт в кэше до 60с
const HIST_MAX_CACHE = 256 * 1024; // не кэшируем тяжёлые (медиа) комнаты

// Подключение через DATABASE_URL либо стандартный URI.
// По умолчанию — локальный контейнер dialog-mysql.
const connectionUri =
  process.env.DATABASE_URL || "mysql://dialog:dialog@localhost:3306/dialog";

// Разбираем URL в конфиг — так можно добавить SSL и лимит пула.
const u = new URL(connectionUri);
const config = {
  host: u.hostname,
  port: u.port ? Number(u.port) : 3306,
  user: decodeURIComponent(u.username),
  password: decodeURIComponent(u.password),
  database: u.pathname.replace(/^\//, ""),
  charset: "utf8mb4",
  connectionLimit: Number(process.env.DB_POOL || 10),
  waitForConnections: true,
};
// Managed MySQL обычно требует TLS — включается через DB_SSL=true.
if (process.env.DB_SSL === "true") config.ssl = { rejectUnauthorized: false };

export const pool = mysql.createPool(config);

pool.on("error", (err) => console.error("MySQL pool error:", err.message));

// Возвращает массив строк (SELECT).
export async function query(sql, params) {
  const [rows] = await pool.query(sql, params);
  return rows;
}
// Возвращает результат (INSERT/UPDATE): insertId, affectedRows.
export async function execute(sql, params) {
  const [result] = await pool.query(sql, params);
  return result;
}

// Создаём таблицы при старте (идемпотентно).
export async function initSchema() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      login       VARCHAR(24) PRIMARY KEY,
      name        VARCHAR(64) NOT NULL,
      salt        CHAR(32) NOT NULL,
      hash        CHAR(128) NOT NULL,
      avatar      LONGTEXT NULL,
      created_at  TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
  `);
  // Для уже существующих БД добавляем колонку аватара (идемпотентно)
  try { await pool.query("ALTER TABLE users ADD COLUMN avatar LONGTEXT NULL"); } catch {}
  await pool.query(`
    CREATE TABLE IF NOT EXISTS messages (
      id          BIGINT AUTO_INCREMENT PRIMARY KEY,
      room        VARCHAR(32) NOT NULL,
      from_login  VARCHAR(24),
      name        VARCHAR(64) NOT NULL,
      ts          BIGINT NOT NULL,
      type        VARCHAR(16) NOT NULL,
      text        TEXT,
      media       LONGTEXT,
      media_name  VARCHAR(255),
      KEY idx_messages_room (room, id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS sessions (
      token       VARCHAR(64) PRIMARY KEY,
      login       VARCHAR(24) NOT NULL,
      created_at  TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      KEY idx_sessions_login (login)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS chat_groups (
      id          BIGINT AUTO_INCREMENT PRIMARY KEY,
      name        VARCHAR(64) NOT NULL,
      owner       VARCHAR(24) NOT NULL,
      created_at  TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS group_members (
      group_id    BIGINT NOT NULL,
      login       VARCHAR(24) NOT NULL,
      PRIMARY KEY (group_id, login),
      KEY idx_gm_login (login)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS relations (
      login   VARCHAR(24) NOT NULL,
      target  VARCHAR(24) NOT NULL,
      type    VARCHAR(8) NOT NULL,
      PRIMARY KEY (login, target, type),
      KEY idx_rel_login (login)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
  `);
}

// --- Друзья / блокировки ---
export async function setRelation(login, target, type) {
  await execute("INSERT IGNORE INTO relations (login, target, type) VALUES (?,?,?)", [login, target, type]);
}
export async function removeRelation(login, target, type) {
  await execute("DELETE FROM relations WHERE login=? AND target=? AND type=?", [login, target, type]);
}
export async function getRelations(login) {
  const rows = await query(
    `SELECT r.target, r.type, u.name FROM relations r JOIN users u ON u.login = r.target WHERE r.login = ?`,
    [login]
  );
  const friends = [], blocks = [];
  for (const r of rows) (r.type === "friend" ? friends : blocks).push({ login: r.target, name: r.name });
  return { friends, blocks };
}

// --- Группы ---
export async function createGroup(name, owner, memberLogins) {
  let valid = [owner];
  if (memberLogins.length) {
    const rows = await query("SELECT login FROM users WHERE login IN (?)", [memberLogins]);
    valid = [...new Set([owner, ...rows.map((r) => r.login)])];
  }
  const res = await execute("INSERT INTO chat_groups (name, owner) VALUES (?, ?)", [name, owner]);
  const id = res.insertId;
  for (const m of valid) await execute("INSERT IGNORE INTO group_members (group_id, login) VALUES (?, ?)", [id, m]);
  return { id, name, members: valid };
}
export async function getUserGroups(login) {
  return query(
    `SELECT g.id, g.name FROM chat_groups g
     JOIN group_members m ON m.group_id = g.id WHERE m.login = ? ORDER BY g.id DESC`,
    [login]
  );
}
export async function isGroupMember(groupId, login) {
  const r = await query("SELECT 1 FROM group_members WHERE group_id = ? AND login = ?", [groupId, login]);
  return r.length > 0;
}
export async function getGroupMembers(groupId) {
  const r = await query("SELECT login FROM group_members WHERE group_id = ?", [groupId]);
  return r.map((x) => x.login);
}
export async function getGroup(id) {
  const r = await query("SELECT id, name, owner FROM chat_groups WHERE id = ?", [id]);
  return r[0] || null;
}

// --- Профиль ---
export async function updateProfile(login, { name, avatar }) {
  if (typeof name === "string" && name.trim()) {
    await execute("UPDATE users SET name = ? WHERE login = ?", [name.trim().slice(0, 32), login]);
  }
  if (typeof avatar === "string") {
    await execute("UPDATE users SET avatar = ? WHERE login = ?", [avatar.slice(0, 400000), login]);
  }
}
export async function getAvatar(login) {
  const r = await query("SELECT avatar FROM users WHERE login = ?", [login]);
  return r[0] ? r[0].avatar : null;
}
// Токены пользователя — чтобы сбросить кэш профиля при смене ника
export async function tokensForLogin(login) {
  const r = await query("SELECT token FROM sessions WHERE login = ?", [login]);
  return r.map((x) => x.token);
}

// --- История сообщений ---
export async function saveMessage(m) {
  const result = await execute(
    `INSERT INTO messages (room, from_login, name, ts, type, text, media, media_name)
     VALUES (?,?,?,?,?,?,?,?)`,
    [m.room, m.fromLogin, m.name, m.ts, m.type, m.text, m.media, m.mediaName]
  );
  await cacheDel("hist:" + m.room); // история комнаты изменилась — сбрасываем кэш
  return result.insertId;
}

// Последние `limit` сообщений комнаты в хронологическом порядке.
export async function recentMessages(room, limit = 100) {
  const cached = await cacheGet("hist:" + room);
  if (cached) { try { return JSON.parse(cached); } catch { /* битый кэш — читаем БД */ } }

  const lim = Math.max(1, Math.min(500, parseInt(limit, 10) || 100)); // безопасный целый LIMIT
  const rows = await query(
    `SELECT id, from_login AS fromLogin, name, ts, type, text, media, media_name AS mediaName
     FROM messages WHERE room = ? ORDER BY id DESC LIMIT ${lim}`,
    [room]
  );
  rows.reverse();
  const json = JSON.stringify(rows);
  if (json.length < HIST_MAX_CACHE) await cacheSet("hist:" + room, json, HIST_TTL);
  return rows;
}

// Проверка доступности БД с ретраями (контейнер мог ещё подниматься).
export async function waitForDb(retries = 30, delayMs = 1000) {
  for (let i = 0; i < retries; i++) {
    try {
      await pool.query("SELECT 1");
      return true;
    } catch (e) {
      if (i === retries - 1) throw e;
      await new Promise((r) => setTimeout(r, delayMs));
    }
  }
}

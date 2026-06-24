import mysql from "mysql2/promise";
import { cacheGet, cacheSet, cacheDel } from "./cache.js";

const HIST_TTL = 60;              // история комнаты живёт в кэше до 60с
const HIST_MAX_CACHE = 256 * 1024; // не кэшируем тяжёлые (медиа) комнаты

// Конфиг подключения: либо отдельные DB_HOST/DB_USER/... (удобно для TiDB —
// не надо URL-кодировать пароль), либо единый DATABASE_URL, либо localhost по умолчанию.
let config;
if (process.env.DB_HOST) {
  config = {
    host: process.env.DB_HOST,
    port: Number(process.env.DB_PORT || 4000),
    user: process.env.DB_USER || "root",
    password: process.env.DB_PASS || "",
    database: process.env.DB_NAME || "test",
  };
} else {
  const u = new URL(process.env.DATABASE_URL || "mysql://dialog:dialog@localhost:3306/dialog");
  config = {
    host: u.hostname,
    port: u.port ? Number(u.port) : 3306,
    user: decodeURIComponent(u.username),
    password: decodeURIComponent(u.password),
    database: u.pathname.replace(/^\//, ""),
  };
}
config.charset = "utf8mb4";
config.connectionLimit = Number(process.env.DB_POOL || 10);
config.waitForConnections = true;
// Managed MySQL/TiDB требует TLS — включается через DB_SSL=true.
if (process.env.DB_SSL === "true") config.ssl = { minVersion: "TLSv1.2", rejectUnauthorized: false };

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
  // Для уже существующих БД добавляем колонки (идемпотентно)
  try { await pool.query("ALTER TABLE users ADD COLUMN avatar LONGTEXT NULL"); } catch {}
  try { await pool.query("ALTER TABLE users ADD COLUMN description VARCHAR(280) NULL"); } catch {}
  try { await pool.query("ALTER TABLE users ADD COLUMN status VARCHAR(12) NOT NULL DEFAULT 'online'"); } catch {}
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
  try { await pool.query("ALTER TABLE messages ADD COLUMN reactions TEXT NULL"); } catch {}
  try { await pool.query("ALTER TABLE messages ADD COLUMN edited TINYINT NOT NULL DEFAULT 0"); } catch {}
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
  for (const r of rows) (r.type === "friend" ? friends : r.type === "block" ? blocks : friends).push({ login: r.target, name: r.name });
  return { friends, blocks };
}

// Полные отношения: друзья, блок, входящие/исходящие заявки
export async function getRelationsFull(login) {
  const friends = await query("SELECT r.target login, u.name FROM relations r JOIN users u ON u.login=r.target WHERE r.login=? AND r.type='friend'", [login]);
  const blocks = await query("SELECT r.target login, u.name FROM relations r JOIN users u ON u.login=r.target WHERE r.login=? AND r.type='block'", [login]);
  const outgoing = await query("SELECT r.target login, u.name FROM relations r JOIN users u ON u.login=r.target WHERE r.login=? AND r.type='request'", [login]);
  const incoming = await query("SELECT r.login login, u.name FROM relations r JOIN users u ON u.login=r.login WHERE r.target=? AND r.type='request'", [login]);
  return { friends, blocks, outgoing, incoming };
}
export async function areFriends(a, b) {
  const r = await query("SELECT 1 FROM relations WHERE login=? AND target=? AND type='friend'", [a, b]);
  return r.length > 0;
}
export async function shareGroup(a, b) {
  const r = await query("SELECT 1 FROM group_members m1 JOIN group_members m2 ON m1.group_id=m2.group_id WHERE m1.login=? AND m2.login=? LIMIT 1", [a, b]);
  return r.length > 0;
}
export async function isBlockedBy(a, b) { // a заблокирован пользователем b
  const r = await query("SELECT 1 FROM relations WHERE login=? AND target=? AND type='block'", [b, a]);
  return r.length > 0;
}
export async function acceptFriend(me, other) {
  await execute("DELETE FROM relations WHERE type='request' AND ((login=? AND target=?) OR (login=? AND target=?))", [other, me, me, other]);
  await execute("INSERT IGNORE INTO relations (login,target,type) VALUES (?,?,'friend')", [me, other]);
  await execute("INSERT IGNORE INTO relations (login,target,type) VALUES (?,?,'friend')", [other, me]);
}
export async function declineFriend(me, other) {
  await execute("DELETE FROM relations WHERE login=? AND target=? AND type='request'", [other, me]);
}
export async function removeFriend(me, other) {
  await execute("DELETE FROM relations WHERE type='friend' AND ((login=? AND target=?) OR (login=? AND target=?))", [me, other, other, me]);
}
// Возвращает 'friend' | 'requested' | 'noop'
export async function sendFriendRequest(from, to) {
  if (await areFriends(from, to)) return "friend";
  if (await isBlockedBy(from, to)) return "noop"; // он нас заблокировал
  const reverse = await query("SELECT 1 FROM relations WHERE login=? AND target=? AND type='request'", [to, from]);
  if (reverse.length) { await acceptFriend(from, to); return "friend"; }
  await execute("INSERT IGNORE INTO relations (login,target,type) VALUES (?,?,'request')", [from, to]);
  return "requested";
}
export async function clearRequests(a, b) {
  await execute("DELETE FROM relations WHERE type='request' AND ((login=? AND target=?) OR (login=? AND target=?))", [a, b, b, a]);
}
export async function leaveGroup(id, login) {
  await execute("DELETE FROM group_members WHERE group_id=? AND login=?", [id, login]);
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
export async function updateProfile(login, { name, avatar, description, status }) {
  if (typeof name === "string" && name.trim()) await execute("UPDATE users SET name = ? WHERE login = ?", [name.trim().slice(0, 32), login]);
  if (typeof avatar === "string") await execute("UPDATE users SET avatar = ? WHERE login = ?", [avatar.slice(0, 400000), login]);
  if (typeof description === "string") await execute("UPDATE users SET description = ? WHERE login = ?", [description.slice(0, 280), login]);
  if (typeof status === "string" && ["online", "dnd", "invisible"].includes(status)) await execute("UPDATE users SET status = ? WHERE login = ?", [status, login]);
}
export async function getAvatar(login) {
  const r = await query("SELECT avatar FROM users WHERE login = ?", [login]);
  return r[0] ? r[0].avatar : null;
}
// Карточка профиля (мини-профиль)
export async function getProfileCard(login) {
  const r = await query("SELECT login, name, description, created_at FROM users WHERE login = ?", [login]);
  return r[0] || null;
}
export async function getStatus(login) {
  const r = await query("SELECT status FROM users WHERE login = ?", [login]);
  return r[0] ? r[0].status : "online";
}
export async function getFriendLogins(login) {
  const r = await query("SELECT target FROM relations WHERE login = ? AND type = 'friend'", [login]);
  return r.map((x) => x.target);
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
    `SELECT id, from_login AS fromLogin, name, ts, type, text, media, media_name AS mediaName, reactions, edited
     FROM messages WHERE room = ? ORDER BY id DESC LIMIT ${lim}`,
    [room]
  );
  rows.reverse();
  rows.forEach((r) => { try { r.reactions = r.reactions ? JSON.parse(r.reactions) : {}; } catch { r.reactions = {}; } r.edited = !!r.edited; });
  const json = JSON.stringify(rows);
  if (json.length < HIST_MAX_CACHE) await cacheSet("hist:" + room, json, HIST_TTL);
  return rows;
}

// Удаление своего сообщения. Возвращает room при успехе.
export async function deleteMessage(id, login) {
  const rows = await query("SELECT room FROM messages WHERE id=? AND from_login=?", [id, login]);
  if (!rows.length) return null;
  await execute("DELETE FROM messages WHERE id=?", [id]);
  await cacheDel("hist:" + rows[0].room);
  return rows[0].room;
}
// Редактирование своего текстового сообщения. Возвращает room при успехе.
export async function editMessage(id, login, text) {
  const rows = await query("SELECT room FROM messages WHERE id=? AND from_login=? AND type='text'", [id, login]);
  if (!rows.length) return null;
  await execute("UPDATE messages SET text=?, edited=1 WHERE id=?", [text, id]);
  await cacheDel("hist:" + rows[0].room);
  return rows[0].room;
}
// Тоггл реакции. Возвращает {room, reactions} или null.
export async function toggleReaction(id, login, emoji, room) {
  const rows = await query("SELECT room, reactions FROM messages WHERE id=?", [id]);
  if (!rows.length || rows[0].room !== room) return null;
  let r = {}; try { r = JSON.parse(rows[0].reactions || "{}"); } catch {}
  const arr = r[emoji] || [];
  const i = arr.indexOf(login);
  if (i === -1) arr.push(login); else arr.splice(i, 1);
  if (arr.length) r[emoji] = arr; else delete r[emoji];
  await execute("UPDATE messages SET reactions=? WHERE id=?", [JSON.stringify(r), id]);
  await cacheDel("hist:" + rows[0].room);
  return { room: rows[0].room, reactions: r };
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

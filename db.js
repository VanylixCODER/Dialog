import mysql from "mysql2/promise";
import { cacheGet, cacheSet, cacheDel } from "./cache.js";

const HIST_TTL = 60;                // история комнаты живёт в кэше до 60с
const HIST_MAX_CACHE = 256 * 1024;  // не кэшируем тяжёлые (медиа) комнаты

// Конфиг подключения: только через отдельные env vars (DB_HOST, DB_PORT, DB_USER,
// DB_PASS, DB_NAME). URL-форма с credentials в явном виде не поддерживается — такие
// строки попадают в логи и stack traces.
// SECURITY: DB credentials are configured via individual env vars ONLY. We intentionally
// do NOT support DATABASE_URL-style connection strings where the username and password
// are embedded in the URL — they get logged, cached, and exposed in stack traces, which
// is the leak we are explicitly avoiding here.
if (process.env.DATABASE_URL) {
  console.warn("[db] DATABASE_URL is set but ignored — use DB_HOST/DB_PORT/DB_USER/DB_PASS/DB_NAME instead. URL-form credentials leak via logs and stack traces.");
}
let config;
if (!process.env.DB_HOST) {
  throw new Error(
    "DB_HOST is required. Set DB_HOST, DB_PORT, DB_USER, DB_PASS, DB_NAME env vars " +
    "(see server.js header for examples). Do not use a DATABASE_URL with embedded " +
    "credentials — it is not supported."
  );
}
config = {
  host:     process.env.DB_HOST,
  port:     Number(process.env.DB_PORT || 3306),   // 3306 is the MySQL standard; the old env-var branch defaulted to 4000 (typo, corrected)
  user:     process.env.DB_USER || "root",
  password: process.env.DB_PASS || "",
  database: process.env.DB_NAME || "test",
};
config.charset = "utf8mb4";
config.connectionLimit = Number(process.env.DB_POOL || 10);
config.waitForConnections = true;
// Managed MySQL/TiDB требует TLS — включается через DB_SSL=true.
if (process.env.DB_SSL === "true") config.ssl = { minVersion: "TLSv1.2", rejectUnauthorized: false };

export const pool = mysql.createPool(config);
pool.on("error", (e) => console.error("MySQL pool:", e.message));

export async function query(sql, params) { const [rows] = await pool.query(sql, params); return rows; }
export async function execute(sql, params) { const [res] = await pool.query(sql, params); return res; }

// Ожидание доступности БД с ретраями (контейнер мог ещё подниматься).
export async function waitForDb(retries = 30, delayMs = 1000) {
  for (let i = 0; i < retries; i++) {
    try { await pool.query("SELECT 1"); return; }
    catch (e) {
      console.error("Не удалось подключиться к MySQL:", e.message);
      console.error("Проверьте DB_HOST/DB_USER/DB_PASS/DB_NAME или запустите контейнер dialog-mysql.");
      await new Promise((r) => setTimeout(r, delayMs));
    }
  }
  throw new Error("MySQL недоступен");
}

// Создаём таблицы при старте (идемпотентно).
export async function initSchema() {
  await pool.query(`CREATE TABLE IF NOT EXISTS users (
    login VARCHAR(24) PRIMARY KEY, name VARCHAR(64) NOT NULL,
    salt CHAR(32) NOT NULL, hash CHAR(128) NOT NULL,
    avatar LONGTEXT NULL, description VARCHAR(280) NULL,
    status VARCHAR(12) NOT NULL DEFAULT 'online',
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;`);

  await pool.query(`CREATE TABLE IF NOT EXISTS messages (
    id BIGINT AUTO_INCREMENT PRIMARY KEY, room VARCHAR(64) NOT NULL,
    from_login VARCHAR(24), name VARCHAR(64) NOT NULL, ts BIGINT NOT NULL,
    type VARCHAR(16) NOT NULL, text TEXT, media LONGTEXT, media_name VARCHAR(255),
    reactions TEXT NULL, edited TINYINT NOT NULL DEFAULT 0,
    KEY idx_messages_room (room, id)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;`);

  await pool.query(`CREATE TABLE IF NOT EXISTS sessions (
    token VARCHAR(64) PRIMARY KEY, login VARCHAR(24) NOT NULL,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP, KEY idx_sessions_login (login)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;`);

  await pool.query(`CREATE TABLE IF NOT EXISTS chat_groups (
    id BIGINT AUTO_INCREMENT PRIMARY KEY, name VARCHAR(64) NOT NULL,
    owner VARCHAR(24) NOT NULL, avatar LONGTEXT NULL, created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;`);
  try { await pool.query("ALTER TABLE chat_groups ADD COLUMN avatar LONGTEXT NULL"); } catch {}

  await pool.query(`CREATE TABLE IF NOT EXISTS group_members (
    group_id BIGINT NOT NULL, login VARCHAR(24) NOT NULL,
    PRIMARY KEY (group_id, login), KEY idx_gm_login (login)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;`);

  await pool.query(`CREATE TABLE IF NOT EXISTS relations (
    login VARCHAR(24) NOT NULL, target VARCHAR(24) NOT NULL, type VARCHAR(8) NOT NULL,
    PRIMARY KEY (login, target, type), KEY idx_rel_login (login)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;`);

  await pool.query(`CREATE TABLE IF NOT EXISTS push_subs (
    endpoint VARCHAR(512) PRIMARY KEY, login VARCHAR(24) NOT NULL, sub TEXT NOT NULL,
    KEY idx_push_login (login)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;`);

  // Курсоры доставки/просмотра для каждого участника каждой комнаты.
  // Запись идемпотентна: «доставлено до id X» / «просмотрено до id Y».
  // Это масштабируется лучше JSON-массивов per-message и не вызывает write amplification.
  await pool.query(`CREATE TABLE IF NOT EXISTS watermarks (
    room VARCHAR(64) NOT NULL, login VARCHAR(24) NOT NULL,
    delivered_max BIGINT NOT NULL DEFAULT 0, seen_max BIGINT NOT NULL DEFAULT 0,
    updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    PRIMARY KEY (room, login), KEY idx_wm_login (login)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;`);

  // Шарабельные коды приглашений в группу. Сервер хранит только SHA-256 хеш кода — plaintext
  // показывается клиенту ОДИН РАЗ при создании, как пароль. Хеш уникален, поэтому поиск при
  // /api/groups/redeem — точечный по индексу UNIQUE, без скана таблицы.
  await pool.query(`CREATE TABLE IF NOT EXISTS group_invites (
    id BIGINT AUTO_INCREMENT PRIMARY KEY,
    group_id BIGINT NOT NULL,
    creator_login VARCHAR(24) NOT NULL,
    code_hash CHAR(64) NOT NULL UNIQUE,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    KEY idx_invites_group (group_id)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;`);

  // Очередь ожидающих заявок на вступление (от in-app suggestions и от redemption кодов).
  // UNIQUE KEY на паре (group_id, login) — запрещает дубли: повторный suggest/redeem одного и того
  // юзера не плодит очереди. revoked/approved/declined строки удаляются (а не помечаются) — таблица
  // и так мала, и проще логика, чем чистить старые флаги.
  await pool.query(`CREATE TABLE IF NOT EXISTS group_pending (
    id BIGINT AUTO_INCREMENT PRIMARY KEY,
    group_id BIGINT NOT NULL,
    login VARCHAR(24) NOT NULL,
    invited_by VARCHAR(24) NOT NULL,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE KEY idx_pending_group_login (group_id, login),
    KEY idx_pending_group (group_id)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;`);
}

// ---------- Пользователи / профиль ----------
export async function createUser(login, name, salt, hash) {
  await execute("INSERT INTO users (login, name, salt, hash) VALUES (?,?,?,?)", [login, name, salt, hash]);
}
export async function getUser(login) {
  const r = await query("SELECT login, name, salt, hash, description, status, created_at FROM users WHERE login=?", [login]);
  return r[0] || null;
}
export async function updateProfile(login, { name, avatar, description, status }) {
  const sets = [], vals = [];
  if (name !== undefined) { sets.push("name=?"); vals.push(name); }
  if (avatar !== undefined) { sets.push("avatar=?"); vals.push(avatar); }
  if (description !== undefined) { sets.push("description=?"); vals.push(description); }
  if (status !== undefined) { sets.push("status=?"); vals.push(status); }
  if (!sets.length) return;
  vals.push(login);
  await execute(`UPDATE users SET ${sets.join(", ")} WHERE login=?`, vals);
}
export async function getAvatar(login) {
  const r = await query("SELECT avatar FROM users WHERE login=?", [login]);
  return r[0] ? r[0].avatar : null;
}
export async function getProfileCard(login) {
  const r = await query("SELECT login, name, description, status, created_at FROM users WHERE login=?", [login]);
  return r[0] || null;
}
export async function getStatus(login) {
  const r = await query("SELECT status FROM users WHERE login=?", [login]);
  return r[0] ? r[0].status : "offline";
}

// ---------- Сессии ----------
export async function saveSession(token, login) { await execute("INSERT INTO sessions (token, login) VALUES (?,?)", [token, login]); }
export async function sessionLogin(token) { const r = await query("SELECT login FROM sessions WHERE token=?", [token]); return r[0] ? r[0].login : null; }
export async function deleteSession(token) { await execute("DELETE FROM sessions WHERE token=?", [token]); }
export async function tokensForLogin(login) { const r = await query("SELECT token FROM sessions WHERE login=?", [login]); return r.map((x) => x.token); }

// ---------- Сообщения ----------
export async function saveMessage(m) {
  const res = await execute(
    `INSERT INTO messages (room, from_login, name, ts, type, text, media, media_name) VALUES (?,?,?,?,?,?,?,?)`,
    [m.room, m.fromLogin, m.name, m.ts, m.type, m.text, m.media, m.mediaName]
  );
  await cacheDel("hist:" + m.room);
  return res.insertId;
}
export async function recentMessages(room, limit = 100) {
  const cached = await cacheGet("hist:" + room);
  if (cached) { try { return JSON.parse(cached); } catch {} }
  const lim = Math.max(1, Math.min(500, parseInt(limit, 10) || 100));
  const rows = await query(
    `SELECT id, from_login AS fromLogin, name, ts, type, text, media, media_name AS mediaName, reactions, edited
     FROM messages WHERE room=? ORDER BY id DESC LIMIT ${lim}`, [room]
  );
  rows.reverse();
  rows.forEach((r) => { try { r.reactions = r.reactions ? JSON.parse(r.reactions) : {}; } catch { r.reactions = {}; } r.edited = !!r.edited; });
  const json = JSON.stringify(rows);
  if (json.length < HIST_MAX_CACHE) await cacheSet("hist:" + room, json, HIST_TTL);
  return rows;
}
export async function deleteMessage(id, login) {
  const r = await query("SELECT room FROM messages WHERE id=? AND from_login=?", [id, login]);
  if (!r.length) return null;
  await execute("DELETE FROM messages WHERE id=?", [id]);
  await cacheDel("hist:" + r[0].room);
  return r[0].room;
}
export async function editMessage(id, login, text) {
  const r = await query("SELECT room FROM messages WHERE id=? AND from_login=? AND type='text'", [id, login]);
  if (!r.length) return null;
  await execute("UPDATE messages SET text=?, edited=1 WHERE id=?", [text, id]);
  await cacheDel("hist:" + r[0].room);
  return r[0].room;
}
export async function toggleReaction(id, login, emoji, room) {
  const r = await query("SELECT room, reactions FROM messages WHERE id=?", [id]);
  if (!r.length || r[0].room !== room) return null;
  let map = {}; try { map = JSON.parse(r[0].reactions || "{}"); } catch {}
  const arr = map[emoji] || [];
  const i = arr.indexOf(login);
  if (i === -1) arr.push(login); else arr.splice(i, 1);
  if (arr.length) map[emoji] = arr; else delete map[emoji];
  await execute("UPDATE messages SET reactions=? WHERE id=?", [JSON.stringify(map), id]);
  await cacheDel("hist:" + r[0].room);
  return { room: r[0].room, reactions: map };
}

// ---------- Группы ----------
export async function createGroup(name, owner, memberLogins) {
  const res = await execute("INSERT INTO chat_groups (name, owner) VALUES (?,?)", [name, owner]);
  const id = res.insertId;
  const members = [...new Set([owner, ...memberLogins])];
  for (const login of members) await execute("INSERT IGNORE INTO group_members (group_id, login) VALUES (?,?)", [id, login]);
  return id;
}
export async function getUserGroups(login) {
  return await query(
    `SELECT g.id, g.name, g.owner FROM chat_groups g
     JOIN group_members m ON m.group_id=g.id WHERE m.login=? ORDER BY g.id DESC`, [login]
  );
}
export async function isGroupMember(groupId, login) {
  const r = await query("SELECT 1 FROM group_members WHERE group_id=? AND login=?", [groupId, login]);
  return r.length > 0;
}
export async function getGroupMembers(groupId) {
  const r = await query("SELECT login FROM group_members WHERE group_id=?", [groupId]);
  return r.map((x) => x.login);
}
export async function getGroup(id) { const r = await query("SELECT id, name, owner FROM chat_groups WHERE id=?", [id]); return r[0] || null; }
export async function leaveGroup(id, login) { await execute("DELETE FROM group_members WHERE group_id=? AND login=?", [id, login]); }
export async function isGroupOwner(id, login) { const r = await query("SELECT 1 FROM chat_groups WHERE id=? AND owner=?", [id, login]); return r.length > 0; }
export async function getGroupAvatar(id) { const r = await query("SELECT avatar FROM chat_groups WHERE id=?", [id]); return r[0] ? r[0].avatar : null; }
// Участники с именами/статусами (для боковой панели и настроек)
export async function getGroupMembersDetailed(id) {
  return await query(
    `SELECT u.login, u.name, u.status FROM group_members m JOIN users u ON u.login=m.login WHERE m.group_id=? ORDER BY u.name`, [id]
  );
}
export async function addGroupMembers(id, logins) {
  for (const login of logins) { if (await getUser(login)) await execute("INSERT IGNORE INTO group_members (group_id, login) VALUES (?,?)", [id, login]); }
}
export async function removeGroupMember(id, login) { await execute("DELETE FROM group_members WHERE group_id=? AND login=?", [id, login]); }
export async function renameGroup(id, name) { await execute("UPDATE chat_groups SET name=? WHERE id=?", [name, id]); }
export async function setGroupAvatar(id, avatar) { await execute("UPDATE chat_groups SET avatar=? WHERE id=?", [avatar, id]); }
// Смена владельца (используется при /api/groups/:id/leave, когда уходит овнер с другими участниками).
// chat_groups.owner — единственный VARCHAR, поэтому при уходе овнера надо явно передать владение
// кому-то из оставшихся, иначе все owner-only маршруты начнут возвращать 403.
export async function setGroupOwner(id, owner) { await execute("UPDATE chat_groups SET owner=? WHERE id=?", [owner, id]); }
export async function deleteGroup(id) {
  await execute("DELETE FROM group_members WHERE group_id=?", [id]);
  await execute("DELETE FROM chat_groups WHERE id=?", [id]);
  try { await execute("DELETE FROM messages WHERE room=?", ["@grp:" + id]); } catch {}
  await cacheDel("hist:@grp:" + id);
  // Каскадно чистим заявки и активные коды удалённой группы.
  try { await execute("DELETE FROM group_pending WHERE group_id=?", [id]); } catch {}
  try { await execute("DELETE FROM group_invites WHERE group_id=?", [id]); } catch {}
}

// ---------- Приглашения в группу (invite-codes + suggestion queue) ----------
// server.js хранит SHA-256 хеш кода; здесь просто INSERT/SELECT/DELETE хеша.
// UNIQUE KEY на code_hash в group_invites даёт O(log n) lookup при redeem.
export async function createGroupInvite(groupId, creatorLogin, hash) {
  const res = await execute("INSERT INTO group_invites (group_id, creator_login, code_hash) VALUES (?,?,?)", [groupId, creatorLogin, hash]);
  return res.insertId;
}
export async function getGroupInvites(groupId) {
  return await query("SELECT id, creator_login, created_at FROM group_invites WHERE group_id=? ORDER BY id DESC", [groupId]);
}
export async function revokeGroupInvite(invId) {
  const r = await query("SELECT group_id FROM group_invites WHERE id=?", [invId]);
  if (!r.length) return null;
  await execute("DELETE FROM group_invites WHERE id=?", [invId]);
  return r[0].group_id;
}
// Поиск по хешу — использует UNIQUE(code_hash), ровно одна строка. Без хеша функция бесполезна.
export async function getInviteByHash(hash) {
  const r = await query("SELECT id, group_id, creator_login FROM group_invites WHERE code_hash=?", [hash]);
  return r[0] || null;
}
// Создать заявку на вступление. INSERT IGNORE: повторный вызов (suggest/redeem для того же логина)
// не плодит дубликатов. Возвращает {duplicate: bool}, чтобы вызывающий мог выбрать ответ.
export async function createPendingInvite(groupId, targetLogin, invitedBy) {
  const r = await execute("INSERT IGNORE INTO group_pending (group_id, login, invited_by) VALUES (?,?,?)", [groupId, targetLogin, invitedBy]);
  return { duplicate: r.affectedRows === 0 };
}
// Возвращает pending-заявки с именами/аватарами для UI овнера — ровно то, что нужно в #gsPendingList.
export async function getGroupPending(groupId) {
  return await query(
    `SELECT p.id, p.login, p.invited_by, p.created_at, u.name, u.avatar IS NOT NULL AS has_avatar
     FROM group_pending p JOIN users u ON u.login=p.login WHERE p.group_id=? ORDER BY p.id ASC`,
    [groupId]
  );
}
export async function deletePendingInvite(pid) {
  const r = await query("SELECT group_id, login FROM group_pending WHERE id=?", [pid]);
  if (!r.length) return null;
  await execute("DELETE FROM group_pending WHERE id=?", [pid]);
  return r[0]; // {group_id, login}
}

// ---------- Друзья / блокировки (relations: friend|block|request) ----------
export async function setRelation(login, target, type) { await execute("INSERT IGNORE INTO relations (login, target, type) VALUES (?,?,?)", [login, target, type]); }
export async function removeRelation(login, target, type) { await execute("DELETE FROM relations WHERE login=? AND target=? AND type=?", [login, target, type]); }
export async function getRelationsFull(login) {
  const out = await query("SELECT target, type FROM relations WHERE login=?", [login]);
  const inc = await query("SELECT login AS src FROM relations WHERE target=? AND type='request'", [login]);
  return {
    friends: out.filter((r) => r.type === "friend").map((r) => r.target),
    blocked: out.filter((r) => r.type === "block").map((r) => r.target),
    sent: out.filter((r) => r.type === "request").map((r) => r.target),
    incoming: inc.map((r) => r.src),
  };
}
export async function getFriendLogins(login) {
  const r = await query("SELECT target FROM relations WHERE login=? AND type='friend'", [login]);
  return r.map((x) => x.target);
}
export async function areFriends(a, b) {
  const r = await query("SELECT 1 FROM relations WHERE login=? AND target=? AND type='friend'", [a, b]);
  return r.length > 0;
}
export async function shareGroup(a, b) {
  const r = await query(
    `SELECT 1 FROM group_members m1 JOIN group_members m2 ON m1.group_id=m2.group_id
     WHERE m1.login=? AND m2.login=? LIMIT 1`, [a, b]
  );
  return r.length > 0;
}
export async function isBlockedBy(a, b) { // a заблокирован пользователем b?
  const r = await query("SELECT 1 FROM relations WHERE login=? AND target=? AND type='block'", [b, a]);
  return r.length > 0;
}
export async function sendFriendRequest(from, to) {
  if (await areFriends(from, to)) return "friend";
  await execute("INSERT IGNORE INTO relations (login, target, type) VALUES (?,?, 'request')", [from, to]);
  return "request";
}
export async function acceptFriend(me, other) { // me принимает заявку от other
  await execute("DELETE FROM relations WHERE login=? AND target=? AND type='request'", [other, me]);
  await execute("DELETE FROM relations WHERE login=? AND target=? AND type='request'", [me, other]);
  await setRelation(me, other, "friend");
  await setRelation(other, me, "friend");
}
export async function declineFriend(me, other) { await execute("DELETE FROM relations WHERE login=? AND target=? AND type='request'", [other, me]); }
export async function removeFriend(me, other) {
  await execute("DELETE FROM relations WHERE login=? AND target=? AND type='friend'", [me, other]);
  await execute("DELETE FROM relations WHERE login=? AND target=? AND type='friend'", [other, me]);
}

// ---------- Web Push подписки ----------
export async function savePushSub(login, sub) {
  await execute(
    "INSERT INTO push_subs (endpoint, login, sub) VALUES (?,?,?) ON DUPLICATE KEY UPDATE login=VALUES(login), sub=VALUES(sub)",
    [sub.endpoint.slice(0, 512), login, JSON.stringify(sub)]
  );
}
export async function getPushSubs(login) {
  const r = await query("SELECT sub FROM push_subs WHERE login=?", [login]);
  return r.map((x) => { try { return JSON.parse(x.sub); } catch { return null; } }).filter(Boolean);
}
export async function deletePushSub(endpoint) { await execute("DELETE FROM push_subs WHERE endpoint=?", [endpoint.slice(0, 512)]); }

// ---------- Курсоры доставки / просмотра (per-user, per-room) ----------
// Возвращает {login: {delivered, seen}} для всех членов комнаты (или [] если пусто).
export async function getRoomWatermarks(room) {
  const r = await query("SELECT login, delivered_max AS delivered, seen_max AS seen FROM watermarks WHERE room=?", [room]);
  const out = {};
  for (const row of r) out[row.login] = { delivered: Number(row.delivered), seen: Number(row.seen) };
  return out;
}
// Идемпотентное обновление (GREATEST). «delivered» или «seen» могут быть null, тогда не трогаем.
export async function bumpWatermarks(room, logins, { delivered, seen } = {}) {
  if (!logins.length) return;
  const placeholders = logins.map(() => "(?,?,?,?)").join(",");
  const params = [];
  for (const l of logins) {
    const d = delivered != null ? Number(delivered) : 0;
    const s = seen != null ? Number(seen) : 0;
    params.push(room, l, d, s);
  }
  // GREATEST(x, VALUES(x)) — берём максимум из существующего и нового, идемпотентно.
  await execute(
    `INSERT INTO watermarks (room, login, delivered_max, seen_max) VALUES ${placeholders}
     ON DUPLICATE KEY UPDATE
       delivered_max = GREATEST(delivered_max, VALUES(delivered_max)),
       seen_max      = GREATEST(seen_max,      VALUES(seen_max))`,
    params
  );
}

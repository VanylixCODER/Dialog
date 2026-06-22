import mysql from "mysql2/promise";

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
      created_at  TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
  `);
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
}

// --- История сообщений ---
export async function saveMessage(m) {
  const result = await execute(
    `INSERT INTO messages (room, from_login, name, ts, type, text, media, media_name)
     VALUES (?,?,?,?,?,?,?,?)`,
    [m.room, m.fromLogin, m.name, m.ts, m.type, m.text, m.media, m.mediaName]
  );
  return result.insertId;
}

// Последние `limit` сообщений комнаты в хронологическом порядке.
export async function recentMessages(room, limit = 100) {
  const lim = Math.max(1, Math.min(500, parseInt(limit, 10) || 100)); // безопасный целый LIMIT
  const rows = await query(
    `SELECT id, from_login AS fromLogin, name, ts, type, text, media, media_name AS mediaName
     FROM messages WHERE room = ? ORDER BY id DESC LIMIT ${lim}`,
    [room]
  );
  return rows.reverse();
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

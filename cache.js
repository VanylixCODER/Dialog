import Redis from "ioredis";

// Redis опционален: включается только если задан REDIS_URL.
// Без него все операции — no-op, приложение работает на чистом MySQL.
const url = process.env.REDIS_URL;
export const enabled = !!url;

let client = null;
if (enabled) {
  client = new Redis(url, {
    maxRetriesPerRequest: 2,
    enableOfflineQueue: false, // если Redis недоступен — команды падают сразу, мы откатимся на БД
    tls: url.startsWith("rediss://") ? {} : undefined,
  });
  client.on("error", (e) => console.error("Redis error:", e.message));
  client.on("connect", () => console.log("Redis подключён"));
}

export async function cacheGet(key) {
  if (!client) return null;
  try { return await client.get(key); } catch { return null; }
}

export async function cacheSet(key, val, ttlSec) {
  if (!client) return;
  try {
    if (ttlSec) await client.set(key, val, "EX", ttlSec);
    else await client.set(key, val);
  } catch { /* кэш не критичен — молча игнорируем */ }
}

export async function cacheDel(key) {
  if (!client) return;
  try { await client.del(key); } catch { /* no-op */ }
}

export { client as redis };

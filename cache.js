// Опциональный кэш через Redis (ioredis). Включается только при наличии REDIS_URL.
// Без него все операции — no-op, приложение работает напрямую с MySQL.
import Redis from "ioredis";

let redis = null;
if (process.env.REDIS_URL) {
  try {
    redis = new Redis(process.env.REDIS_URL, { maxRetriesPerRequest: 2 });
    redis.on("ready", () => console.log("Redis подключён"));
    redis.on("error", (e) => console.error("Redis:", e.message));
  } catch (e) {
    console.error("Redis init:", e.message);
    redis = null;
  }
}

export const cacheEnabled = () => !!redis;

export async function cacheGet(key) {
  if (!redis) return null;
  try { return await redis.get(key); } catch { return null; }
}
export async function cacheSet(key, val, ttlSec) {
  if (!redis) return;
  try { ttlSec ? await redis.set(key, val, "EX", ttlSec) : await redis.set(key, val); } catch {}
}
export async function cacheDel(key) {
  if (!redis) return;
  try { await redis.del(key); } catch {}
}

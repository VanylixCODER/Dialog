#!/usr/bin/env node
/**
 * Register seed users so a fresh machine can populate a DM with:
 *   npm run seed:register && npm run seed:chat
 *
 * Defaults: registers perfa + perfb with password testpass1234 and names "<Capitalized login> (seed)".
 * Idempotent: 400/409 errors with "login taken" / "exists" / "already" / "duplicate" in the message
 * are treated as success — the row already exists and `seed:chat` only needs the users to be present.
 *
 * Env overrides:
 *   BASE_URL              — default http://localhost:3000
 *   SEED_PWD              — default testpass1234
 *   SEED_SENDER           — default perfa
 *   SEED_RECEIVER         — default perfb
 *   SEED_NAME_SENDER      — default "<Cap login> (seed)"
 *   SEED_NAME_RECEIVER    — default "<Cap login> (seed)"
 */
const BASE_URL = process.env.BASE_URL || "http://localhost:3000";
const PWD = process.env.SEED_PWD || "testpass1234";

const cap = (s) => (s || "").charAt(0).toUpperCase() + (s || "").slice(1);
const loginOrDefault = (env, fallback) => (process.env[env] || fallback);

const pairs = [
  { login: loginOrDefault("SEED_SENDER", "perfa"), name: process.env.SEED_NAME_SENDER || `${cap(loginOrDefault("SEED_SENDER", "perfa"))} (seed)` },
  { login: loginOrDefault("SEED_RECEIVER", "perfb"), name: process.env.SEED_NAME_RECEIVER || `${cap(loginOrDefault("SEED_RECEIVER", "perfb"))} (seed)` },
];

async function registerOne(loginName, name) {
  const r = await fetch(BASE_URL + "/api/register", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ login: loginName, name, password: PWD }),
  });
  const data = await r.json().catch(() => ({}));
  if (r.ok) return { ok: true, created: true };
  const err = (data && data.error) || "";
  if (/taken|exists|already|duplicate/i.test(err)) return { ok: true, created: false };
  return { ok: false, error: err || `HTTP ${r.status}` };
}

async function main() {
  console.log(`seed-register: ${pairs.map((p) => p.login).join(", ")} on ${BASE_URL}`);
  let created = 0, existed = 0, failed = 0;
  for (const p of pairs) {
    const res = await registerOne(p.login, p.name);
    if (res.created) { console.log(`  ✓ ${p.login} created`); created++; }
    else if (res.ok) { console.log(`  · ${p.login} already exists (skipped)`); existed++; }
    else { console.error(`  ✗ ${p.login}: ${res.error}`); failed++; }
  }
  console.log(`seed-register: created=${created}, existed=${existed}, failed=${failed}`);
  if (failed) process.exit(1);
}

main().catch((e) => { console.error("seed-register failed:", e.message); process.exit(1); });

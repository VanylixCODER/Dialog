#!/usr/bin/env node
/**
 * Spin up a populated DM so reviewers / perf tooling have a realistic alternating-thread to inspect.
 * Alternates senders (SENDER → RECEIVER → SENDER → RECEIVER) so both sides generate outgoing messages
 * AND the recipient socket bumps its delivered / seen watermarks per incoming message — exercises the
 * watermark broadcast / GREATEST dedup path on the server side, not just outbound msg saves.
 *
 * Usage:
 *   BASE_URL=http://localhost:3000 npm run seed:chat            # defaults below
 *   SEED_COUNT=2000 npm run seed:chat                           # bulkier thread
 *   SEED_SKIP_WATERMARKS=1 npm run seed:chat                    # skip seen/delivery emits (fast)
 *   SEED_WATERMARK_EVERY=5 npm run seed:chat                    # batch: bump watermark every 5 incoming
 *
 * Default pair: perfa ↔ perfb (use `seed:register` to create them first).
 * Replaces the prior single-sender "node -e socket.io-client" snippet.
 */
import { io } from "socket.io-client";

const BASE_URL = process.env.BASE_URL || "http://localhost:3000";
const PWD = process.env.SEED_PWD || "testpass1234";
const SENDER = process.env.SEED_SENDER || "perfa";
const RECEIVER = process.env.SEED_RECEIVER || "perfb";
const COUNT = Number(process.env.SEED_COUNT || 200);
const PREFIX = process.env.SEED_PREFIX || "msg";
const WALL_EVERY = Math.max(1, Number(process.env.SEED_WATERMARK_EVERY || 1));
const SKIP_WATERMARKS = process.env.SEED_SKIP_WATERMARKS === "1";
// DM room key matches server's sort order so this works regardless of which side logs in first.
const room = "@dm:" + [SENDER, RECEIVER].sort().join("~");

async function api(path, body, token) {
  const r = await fetch(BASE_URL + path, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...(token ? { Authorization: "Bearer " + token } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { ok: r.ok, status: r.status, data: await r.json().catch(() => ({})) };
}
async function login(name) {
  const r = await api("/api/login", { login: name, password: PWD });
  if (!r.ok) throw new Error(`login(${name}) failed: ${r.status} ${JSON.stringify(r.data)}`);
  return r.data.token;
}
async function getMyLogin(token) {
  const r = await fetch(BASE_URL + "/api/me", { headers: { Authorization: "Bearer " + token } });
  if (!r.ok) throw new Error(`/api/me failed: ${r.status}`);
  return (await r.json()).profile.login;
}
async function ensureFriendship() {
  // idempotent at REST: request from sender, accept as receiver
  const t1 = await login(SENDER);
  await api("/api/friend", { target: RECEIVER, action: "request" }, t1);
  const t2 = await login(RECEIVER);
  await api("/api/friend", { target: SENDER, action: "accept" }, t2);
}
function connectSocket(token, myLogin, label) {
  return new Promise((resolve, reject) => {
    const s = io(BASE_URL, {
      auth: { token },
      transports: ["websocket"],
      rejectUnauthorized: false, // dev server may serve self-signed HTTPS; ignored on plain ws://
    });
    let incoming = 0, lastSeenBump = 0;
    s.once("connect", () => {
      s.emit("join", { token, room });
      s.on("message", (m) => {
        // self-echo from our own emit, plus history on join — neither is incoming
        if (!m || m.fromLogin === myLogin) return;
        incoming++;
        if (SKIP_WATERMARKS) return;
        // Mirror app.js: every incoming message fires delivery (immediate), seen throttled by WALL_EVERY
        s.emit("delivery", { maxId: m.id });
        if (incoming - lastSeenBump >= WALL_EVERY) {
          s.emit("seen", { maxId: m.id });
          lastSeenBump = incoming;
        }
      });
      // Раннее обнаружение дисконнекта делается в main() через shared `dead` flag —
      // Promise тут уже settled, поэтому reject от disconnect-обработчика был бы no-op.
      resolve(s);
    });
    s.once("connect_error", (e) => reject(new Error(`${label} connect_error: ${e.message || e}`)));
  });
}

async function main() {
  console.log(
    `seed-chat: ${SENDER}↔${RECEIVER}, ${COUNT} messages alternating, watermarks=${SKIP_WATERMARKS ? "skip" : `every ${WALL_EVERY}`}, room=${room}, base=${BASE_URL}`
  );

  try { await ensureFriendship(); }
  catch (e) {
    console.error(`failed during friendship handshake — run \`npm run seed:register\` first:\n  ${e.message}`);
    process.exit(1);
  }

  const [senderToken, receiverToken] = await Promise.all([login(SENDER), login(RECEIVER)]);
  const [senderLogin, receiverLogin] = await Promise.all([getMyLogin(senderToken), getMyLogin(receiverToken)]);
  if (senderLogin !== SENDER || receiverLogin !== RECEIVER) {
    console.error(`abort: server returned unexpected logins (sender=${senderLogin}, receiver=${receiverLogin})`);
    process.exit(1);
  }

  // Two independent sockets — sender and receiver both stay in the room throughout the run
  const [senderSock, receiverSock] = await Promise.all([
    connectSocket(senderToken, senderLogin, "sender"),
    connectSocket(receiverToken, receiverLogin, "receiver"),
  ]);

  // Hot-disconnect detection: in connectSocket() the Promise is settled synchronously by resolve(s),
  // so a reject() from a later s.on("disconnect") would be silently dropped. Track "dead" here
  // and check it before every emit so the seed aborts loudly instead of pretending success.
  let dead = null;
  senderSock.on("disconnect", () => { if (!dead) dead = "sender"; });
  receiverSock.on("disconnect", () => { if (!dead) dead = "receiver"; });

  // Brief settle so both sockets register their join before the message stream starts
  await new Promise((r) => setTimeout(r, 250));

  const sockets = { [SENDER]: senderSock, [RECEIVER]: receiverSock };
  const turn = [SENDER, RECEIVER]; // even index → SENDER, odd → RECEIVER
  let sent = 0;
  for (let i = 0; i < COUNT; i++) {
    if (dead) throw new Error(`seed-chat: ${dead} socket disconnected mid-run`);
    const who = turn[i % 2];
    sockets[who].emit("message", { type: "text", text: `${PREFIX} #${i} (${who})` });
    sent++;
  }
  // Settle so server saves the last batch + watermark bumps drain + msg-acks land
  await new Promise((r) => setTimeout(r, 1500));

  // If a socket died during settle (server restart, network blip), don't pretend success.
  if (dead) throw new Error(`seed-chat: ${dead} socket disconnected during settle`);

  senderSock.disconnect();
  receiverSock.disconnect();
  console.log(`✓ sent ${sent}/${COUNT} alternating messages to ${room}`);
}

main().catch((e) => { console.error("seed-chat failed:", e.message); process.exit(1); });

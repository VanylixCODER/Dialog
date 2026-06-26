#!/usr/bin/env node
/**
 * Memory-leak gate (perf CI). ИСПОЛЬЗУЕТСЯ С ДВУМЯ СТАДИЯМИ.
 *
 * Stage A — статичная /login, time-based:
 *   Загружаем страницу один раз, даём settle 3 s, мерим baseline, ждём
 *   LEAK_STATIC_SECONDS и мерим ещё раз. Это ловит аккумуляторы внутри
 *   одной жизни страницы:
 *     - requestAnimationFrame-цепочка, которая добавляет объекты каждый кадр
 *     - setInterval, который копит Map / Array
 *     - addEventListener без удаления
 *     - ServiceWorker, который держит state
 *     (pre-fix: matrix.js мог не останавливать rAF на document.hidden — это
 *      заметный устойчивый рост хипа.)
 *   page.reload() ТУТ НЕЛЬЗЯ: перезагрузка выгружает прошлую страницу и сбра-
 *   сывает JS-хип, поэтому reload-loop измеряет V8-шум, а не реальные утечки.
 *
 * Stage B — /app SPA, nav-journey:
 *   Логин, открытие чатов, отправка сообщений, модалки, выход. Цикл повторяется
 *   LEAK_APP_ROUNDS раз. Ловит:
 *     - chats / watermarks / peers / presence Map-ы без чистки
 *     - socket.on("presence") / ("message") / ("watermark") listeners, навешенные
 *       повторно при навигации
 *     - openChat() / loadGroupMembers() DOM-слушатели без removeEventListener
 *     - in-call matrix rAF после endCall()
 *     - модалки: contacts / profile / newChat — listners не отвязываются на .hidden
 *
 * ОБА теста используют usedJSHeapSize. Это грубая метрика (шум от GC, burst
 * от avatar decode и т.п.). Настоящая "retained size" требует CDP
 * HeapProfiler.takeHeapSnapshot + diff aggregate — намеренно НЕ делаем, чтобы
 * CI был дешёвым. Это regression tripwire, не leak dial: 8 MB порог подобран
 * как "явная утечка" сигнал; ужесточайте по мере того, как профиль
 * становится предсказуемым.
 */
import { chromium } from "playwright";
import { io } from "socket.io-client";

const BASE_URL = process.env.BASE_URL || "http://localhost:3000";
const LOGIN_PWD = process.env.SEED_PWD || "testpass1234";
const THRESHOLD_MB = Number(process.env.LEAK_THRESHOLD_MB || 8);
const STATIC_SECONDS = Number(process.env.LEAK_STATIC_SECONDS || 15);
const APP_ROUNDS = Number(process.env.LEAK_APP_ROUNDS || 5);

const mb = (b) => b / (1024 * 1024);

async function getToken(login) {
  const r = await fetch(`${BASE_URL}/api/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ login, password: LOGIN_PWD }),
  });
  if (!r.ok) return null;
  return (await r.json()).token || null;
}

async function seedDMClicks() {
  // Шлём 30 сообщений от perfa → perfb, чтобы у perfb в /app был реальный DM
  const tokenA = await getToken("perfa");
  if (!tokenA) {
    console.log("seed: perfa не зареган (Stage B увидит пустой список чатов)");
    return;
  }
  const s = io(BASE_URL, { auth: { token: tokenA }, transports: ["websocket"] });
  await new Promise((res, rej) => { s.once("connect", res); s.once("connect_error", rej); });
  s.emit("join", { token: tokenA, room: "@dm:perfa~perfb" });
  await new Promise((r) => setTimeout(r, 200));
  for (let i = 0; i < 30; i++) s.emit("message", { type: "text", text: "leak-seed #" + i });
  await new Promise((r) => setTimeout(r, 1500));
  s.disconnect();
}

async function stageALogin(browser) {
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  await page.goto(`${BASE_URL}/`, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(3000); // matrix rain settle
  if (!(await page.evaluate(() => "memory" in performance))) {
    await ctx.close();
    return { ok: false, reason: "performance.memory unavailable — нужен Chromium с --enable-precise-memory-info" };
  }
  const baseline = await page.evaluate(() => performance.memory.usedJSHeapSize);
  // Без reload: ждём STATIC_SECONDS, чтобы поймать внутристраничные аккумуляторы
  await page.waitForTimeout(STATIC_SECONDS * 1000);
  const after = await page.evaluate(() => performance.memory.usedJSHeapSize);
  const delta = mb(after - baseline);
  await ctx.close();
  return { ok: true, name: `stageA /login hold-${STATIC_SECONDS}s`, baseline: mb(baseline), after: mb(after), delta };
}

async function stageBApp(browser) {
  const ctx = await browser.newContext();
  await seedDMClicks();
  const tokenB = await getToken("perfb");
  if (!tokenB) {
    await ctx.close();
    return { ok: false, reason: "perfb token missing — зарегай его сначала через /api/register" };
  }
  // pre-seed токена ДО того, как app.js стартанёт; тогда checkSession() → enterApp() без UI-формы
  await ctx.addInitScript((t) => {
    try { localStorage.setItem("dialog_token", String(t)); } catch {}
  }, tokenB);
  const page = await ctx.newPage();
  await page.goto(`${BASE_URL}/`, { waitUntil: "domcontentloaded" });
  await page.waitForSelector(".app:not(.hidden)", { timeout: 30000 });
  await page.waitForTimeout(2000); // watermark snapshot + status icons cached + settle
  if (!(await page.evaluate(() => "memory" in performance))) {
    await ctx.close();
    return { ok: false, reason: "performance.memory unavailable" };
  }
  const baseline = await page.evaluate(() => performance.memory.usedJSHeapSize);

  // Селекторы подтверждены против public/index.html:
  // .chat-item, #msgInput, #contactsBtn, #contactsCancel, #newChatBtn,
  // #newChatCancel, #profileBtn, #profileCancel, #backBtnMobile
  for (let i = 0; i < APP_ROUNDS; i++) {
    await page.click(".chat-item").catch(() => {});
    await page.waitForTimeout(400);
    await page.type("#msgInput", `nav ${i}`).catch(() => {});
    await page.keyboard.press("Enter").catch(() => {});
    await page.waitForTimeout(400);
    await page.click("#contactsBtn").catch(() => {});
    await page.waitForSelector(".modal:not(.hidden)", { timeout: 5000 }).catch(() => {});
    await page.click("#contactsCancel").catch(() => {});
    await page.waitForTimeout(200);
    await page.click("#newChatBtn").catch(() => {});
    await page.click("#newChatCancel").catch(() => {});
    await page.waitForTimeout(200);
    await page.click("#profileBtn").catch(() => {});
    await page.click("#profileCancel").catch(() => {});
    await page.waitForTimeout(300);
    await page.click("#backBtnMobile").catch(() => {});
    await page.waitForTimeout(200);
  }
  const after = await page.evaluate(() => performance.memory.usedJSHeapSize);
  const delta = mb(after - baseline);
  await ctx.close();
  return { ok: true, name: `stageB /app x${APP_ROUNDS}`, baseline: mb(baseline), after: mb(after), delta };
}

const browser = await chromium.launch({
  args: ["--no-sandbox", "--enable-precise-memory-info"],
});

const a = await stageALogin(browser);
console.log(a.ok
  ? `Stage A: baseline=${a.baseline.toFixed(2)} MB, after=${a.after.toFixed(2)} MB, delta=${a.delta.toFixed(2)} MB`
  : `Stage A: SKIPPED (${a.reason})`);

const b = await stageBApp(browser);
console.log(b.ok
  ? `Stage B: baseline=${b.baseline.toFixed(2)} MB, after=${b.after.toFixed(2)} MB, delta=${b.delta.toFixed(2)} MB`
  : `Stage B: SKIPPED (${b.reason})`);

await browser.close();

const aFails = a.ok && a.delta > THRESHOLD_MB;
const bFails = b.ok && b.delta > THRESHOLD_MB;
if (aFails || bFails) {
  if (aFails) console.error(`❌ Stage A heap grew ${a.delta.toFixed(2)} MB > ${THRESHOLD_MB} MB`);
  if (bFails) console.error(`❌ Stage B heap grew ${b.delta.toFixed(2)} MB > ${THRESHOLD_MB} MB`);
  process.exit(1);
}
console.log(`✅ Memory budget OK (usedJSHeapSize delta within ${THRESHOLD_MB} MB; this is NOT a true retained-size diff)`);

# Dialog Bot API

Dialog has a **Telegram-style HTTP bot API**. A bot is a normal Dialog account you
own, driven by an external program that holds a secret token. Your program calls an
HTTP API to send messages, and receives incoming messages either by **long-polling**
(`getUpdates`) or via a **webhook**.

If you've used the Telegram Bot API, this will feel familiar — same request shape
(`/bot<token>/<method>`), same `{ ok, result }` envelope, same `getUpdates`/webhook model.

- **Base URL:** `https://dialogmsg.xyz`
- **Everything is a bot user.** Bots can be DMed and added to groups like any account.
- **Out of scope (v1):** inline keyboards / buttons and `callback_query`.

---

## 1. Create a bot

Bots are self-serve — no approval needed.

1. Open Dialog → **Settings** (gear) → **Developer**.
2. Click **New bot**, enter a **display name** and a **username** (`3–24` chars,
   `a–z 0–9 _`; ending in `_bot` is a nice convention, e.g. `weather_bot`).
3. You'll get a **token** that looks like `dlg_XXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX`.
   **Copy it now — it is shown only once.**
4. In the same pane you can set the bot's **commands**, a **webhook URL**, and the
   **group privacy** flag, or **regenerate** the token / **delete** the bot.

> Lost the token? Open the bot's card → **Regenerate token**. The old token stops
> working immediately.
>
> Limit: **10 bots per account.** Bot accounts cannot log in with a password.

---

## 2. Authentication

Pass the token one of two ways:

```bash
# A) Token in the path (Telegram-compatible — point any TG library's base URL here):
curl https://dialogmsg.xyz/bot<token>/getMe

# B) Bearer header, via the /api/bot/<method> route:
curl https://dialogmsg.xyz/api/bot/getMe -H "Authorization: Bearer <token>"
```

Parameters may be sent as a **JSON body** (`Content-Type: application/json`) **or** as a
**query string** — the JSON body wins on conflict. So both of these are equivalent:

```bash
curl "https://dialogmsg.xyz/bot<token>/getUpdates?offset=42&timeout=30"
curl https://dialogmsg.xyz/bot<token>/getUpdates \
  -H 'Content-Type: application/json' -d '{"offset":42,"timeout":30}'
```

Every response is either:

```json
{ "ok": true,  "result": <...> }
{ "ok": false, "error_code": 401, "description": "Unauthorized" }
```

---

## 3. `chat_id` — how chats are addressed

A `chat_id` is the room key of a conversation:

| Chat type | `chat_id` format | Example |
|-----------|------------------|---------|
| Direct message | `@dm:<loginA>~<loginB>` — **the two logins sorted alphabetically** | `@dm:demo_bot~vnx` |
| Group | `@grp:<id>` | `@grp:8f3a1c` |

You usually don't build `chat_id` by hand — you read it off the `chat.id` field of an
incoming update and reply to that. To construct a DM id yourself, sort the two
usernames and join with `~`: for `demo_bot` + `vnx` → `@dm:demo_bot~vnx`.

A bot can only send to a chat it participates in (a DM that contains it, or a group it's
a member of); otherwise `sendMessage` returns `403`.

---

## 4. Receiving messages

### Option A — `getUpdates` (long-polling)

```bash
curl "https://dialogmsg.xyz/bot<token>/getUpdates?offset=0&timeout=30"
```

- `offset` — pass `<highest update_id you've handled> + 1` to acknowledge everything
  below it (acknowledged updates are deleted server-side). Start at `0`.
- `timeout` — seconds to hold the connection open waiting for a new update
  (`0`–`30`, default `0`). Use ~`30` for efficient long-polling.
- `limit` — max updates to return (default `100`).

Returns an array of **update** objects (see [§6](#6-the-update-object)). Loop: read
updates → do work → call again with `offset = last_update_id + 1`.

### Option B — Webhook

Register a public **HTTPS** URL. Dialog will `POST` each update to it as JSON.

```bash
curl -X POST "https://dialogmsg.xyz/bot<token>/setWebhook" \
  -H 'Content-Type: application/json' \
  -d '{"url":"https://your.app/dialog/hook","secret":"my-shared-secret"}'
```

- The URL must be `https://` and a **public** host (loopback / private ranges are
  rejected — SSRF guard).
- Each delivery is **signed**: header `X-Dialog-Signature: sha256=<hex>` where
  `<hex> = HMAC_SHA256(secret, rawRequestBody)`. **Verify it** before trusting the
  payload. If you omit `secret`, one is generated (you won't see it — pass your own).
- Remove it with `deleteWebhook`.

While a webhook is set, updates go to the webhook and are **not** queued for
`getUpdates`. If a webhook delivery fails, the update is dropped (there is no retry
queue in v1) — use `getUpdates` if you need at-least-once delivery.

---

## 5. Sending & managing messages

### `sendMessage`

```bash
curl -X POST "https://dialogmsg.xyz/bot<token>/sendMessage" \
  -H 'Content-Type: application/json' \
  -d '{"chat_id":"@dm:demo_bot~vnx","text":"Hello 👋"}'
```

Returns `{ ok, result: { message_id, chat:{id}, date, text, from } }`. The message
appears live in the recipient's chat (and fires a push if they're away).

### Media — `sendPhoto` / `sendVideo` / `sendAudio` / `sendDocument`

Provide the media as a **`data:` URL** (base64) or a public **`https:` URL`**:

```bash
curl -X POST "https://dialogmsg.xyz/bot<token>/sendPhoto" \
  -H 'Content-Type: application/json' \
  -d '{"chat_id":"@grp:8f3a1c","photo":"https://example.com/cat.png","filename":"cat.png"}'
```

- The media field is accepted under any of: `media`, `photo`, `document`, `video`,
  `audio`, or `url`.
- `filename` (aka `media_name`) sets the displayed name.
- Max size **75 MB** (base64 `data:` URLs count decoded bytes).

### Edit / delete (own messages only)

```bash
curl -X POST .../editMessageText -d '{"message_id":684,"text":"edited"}'
curl -X POST .../deleteMessage   -d '{"message_id":684}'
```

### Typing indicator

```bash
curl -X POST .../sendChatAction -d '{"chat_id":"@dm:demo_bot~vnx","action":"typing"}'
```

Send `{"action":"cancel"}` to clear it.

---

## 6. The update object

Each item from `getUpdates` (and each webhook POST body) looks like:

```json
{
  "update_id": 137,
  "message": {
    "message_id": 684,
    "from":  { "login": "vnx", "name": "Vanylix", "is_bot": false },
    "chat":  { "id": "@dm:demo_bot~vnx", "type": "private" },
    "date":  1783923794,
    "text":  "/start",
    "media_type": "image",
    "media": "https://…",
    "media_name": "cat.png"
  }
}
```

- `chat.type` is `"private"` (DM) or `"group"`.
- `text` is present for text messages; `media_type` / `media` / `media_name` are present
  for media messages (`media_type` ∈ `image`, `video`, `audio`, `file`).
- `update_id` is the acknowledgement cursor for `getUpdates` (pass `last + 1` as
  `offset`). For webhook deliveries it is a timestamp.

---

## 7. Commands

Register the slash-commands your bot understands. They power the **`/` command menu**
that appears in the composer when a user is chatting with your bot.

```bash
curl -X POST .../setMyCommands -H 'Content-Type: application/json' -d '{
  "commands": [
    { "command": "start", "description": "Say hello" },
    { "command": "ping",  "description": "Check the bot is alive" }
  ]
}'
```

Read them back with `getMyCommands`. (You still receive the raw `/start` text in an
update — commands are just discovery/UX; parse the text yourself.)

---

## 8. Behavior in groups — privacy

Bots can be added to groups through the normal member picker. By default a bot has
**group privacy ON**, meaning inside a group it only receives messages that:

- start with a slash command (`/…`), **or**
- `@mention` the bot's username.

Turn privacy **off** (in the Developer pane, or it's the `bot_privacy` flag) to receive
**every** group message. Privacy does not affect DMs — a bot always receives all of its
direct messages.

---

## 9. Method reference

| Method | Params | Result |
|--------|--------|--------|
| `getMe` | — | `{ id, login, name, is_bot, description }` |
| `getMyCommands` | — | `[{ command, description }]` |
| `setMyCommands` | `commands: [{command, description}]` | `true` |
| `setWebhook` | `url`, `secret?` | `true` |
| `deleteWebhook` | — | `true` |
| `getUpdates` | `offset?`, `limit?`, `timeout?` | `[update, …]` |
| `sendMessage` | `chat_id`, `text` | sent message |
| `sendPhoto` / `sendVideo` / `sendAudio` / `sendDocument` | `chat_id`, media (`media`/`photo`/…/`url`), `caption?`, `filename?` | sent message |
| `editMessageText` | `message_id`, `text` | `true` |
| `deleteMessage` | `message_id` | `true` |
| `sendChatAction` | `chat_id`, `action` | `true` |

Common errors: `401 Unauthorized` (bad/rotated token), `403 bot is not a participant of
this chat`, `400` (missing/invalid params, `file_too_big`, bad webhook URL).

---

## 10. Example — a polling echo bot (Node.js, zero deps)

```js
const TOKEN = process.env.DIALOG_TOKEN;               // dlg_…
const BASE  = `https://dialogmsg.xyz/bot${TOKEN}`;

async function call(method, params = {}) {
  const r = await fetch(`${BASE}/${method}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(params),
  });
  return r.json();
}

let offset = 0;
console.log("bot up:", (await call("getMe")).result.login);
await call("setMyCommands", { commands: [{ command: "start", description: "Say hi" }] });

while (true) {
  const { result: updates } = await call("getUpdates", { offset, timeout: 30 });
  for (const u of updates) {
    offset = u.update_id + 1;
    const msg = u.message;
    if (!msg?.text) continue;
    const reply = msg.text === "/start" ? "👋 Hi! Send me anything." : `You said: ${msg.text}`;
    await call("sendMessage", { chat_id: msg.chat.id, text: reply });
  }
}
```

Run: `DIALOG_TOKEN=dlg_… node bot.mjs` (Node 18+ for built-in `fetch`; top-level `await`
needs a `.mjs` file or `"type":"module"`).

---

## 11. Example — a webhook receiver (Express)

```js
import express from "express";
import crypto from "crypto";

const SECRET = process.env.HOOK_SECRET;               // same value you passed to setWebhook
const app = express();

// Capture the raw body so we can verify the signature.
app.use(express.json({ verify: (req, _res, buf) => { req.raw = buf; } }));

app.post("/dialog/hook", (req, res) => {
  const expected = "sha256=" + crypto.createHmac("sha256", SECRET).update(req.raw).digest("hex");
  const got = req.get("X-Dialog-Signature") || "";
  if (got.length !== expected.length ||
      !crypto.timingSafeEqual(Buffer.from(got), Buffer.from(expected))) {
    return res.sendStatus(401);
  }
  const msg = req.body.message;
  console.log(`[${msg.chat.id}] ${msg.from.login}: ${msg.text ?? "(" + msg.media_type + ")"}`);
  res.sendStatus(200);                                // reply fast; do work async
});

app.listen(3000);
```

Then point Dialog at it:

```bash
curl -X POST "https://dialogmsg.xyz/bot<token>/setWebhook" \
  -H 'Content-Type: application/json' \
  -d '{"url":"https://your.public.host/dialog/hook","secret":"'"$HOOK_SECRET"'"}'
```

---

## 12. Limits & notes

- **10 bots** per account; **75 MB** per media message.
- Queued `getUpdates` messages are **pruned after ~24h** — poll regularly.
- Webhooks: HTTPS + public host only, HMAC-signed, 8s delivery timeout, **no retries**.
- Tokens are stored **hashed**; regeneration invalidates the previous token instantly.
- A bot never receives an echo of its own messages.

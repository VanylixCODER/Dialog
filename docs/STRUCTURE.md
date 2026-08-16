# Repository layout

Dialog is one repo holding four things: a server, a web client, two native shells, and the
material used to build them. Nothing else belongs in the root.

## Server (runs in the `app` container)

| File | Responsibility |
|---|---|
| `server.js` | Everything HTTP + Socket.IO: REST routes, the realtime handlers, calls signalling, bot API, webhooks, media offload, security headers, rate limiting. |
| `db.js` | MySQL: the schema (`initSchema`, idempotent) and every query. No SQL lives outside this file. |
| `auth.js` | Passwords (scrypt), session tokens, TOTP. |
| `cache.js` | Redis helpers (`cacheGet/Set/Del`) used for history and session caching. |
| `mail.js` | Verification and password-reset email. |

## Web client (`public/` — served as static files)

| Path | Responsibility |
|---|---|
| `public/index.html` | The whole SPA markup. Every pane, modal and overlay lives here. |
| `public/app.js` | The client. One large file by deliberate choice — see CLAUDE.md. |
| `public/css/style.css` | All app styling, including every theme. |
| `public/js/i18n.js` | Strings, `en` + `ru`. Both must be updated together. |
| `public/js/icons.js` | Lucide icon set exposed as `window.ICON.*`. |
| `public/js/imgedit.js` | Image editor (rotate/flip/zoom/resize) used before every upload. |
| `public/js/activities.js` | Call activities. Currently disabled behind an `ENABLED` flag. |
| `public/js/router.js` | URL ↔ open-chat mapping. |
| `public/js/downloads-data.js` | Installer catalogue for the landing/download pages. **Holds `VERSION`.** |
| `public/landing.html`, `download.html`, `bots.html`, `privacy.html`, … | Public marketing and docs pages. |
| `public/sw.js` | Service worker (push notifications). |

## Native shells (built into installers, not served)

| Path | Responsibility |
|---|---|
| `desktop/` | Electron wrapper that loads the hosted URL. `src/main.js` (windows, tray, updater), `src/preload.js` (the page ↔ shell bridge), `src/loader/` (terminal boot splash). **Holds the desktop version in `package.json`.** |
| `android/` | Native WebView wrapper. `MainActivity.kt`, `WebAppInterface.kt` (the JS bridge), `BootLoader.kt` + `res/layout/loader.xml` (terminal boot screen). **Holds `versionCode` / `versionName` in `app/build.gradle.kts`.** |

## Infrastructure

| Path | Responsibility |
|---|---|
| `Dockerfile`, `docker-compose*.yml` | The production stack: app · MySQL · Redis · Caddy. |
| `Caddyfile` | TLS termination and reverse proxy. |
| `.dockerignore` | What must **not** reach the image — secrets included. Keep it strict; `COPY . .` trusts it. |
| `.github/` | CI: macOS and Android builds, perf budgets. |
| `scripts/`, `certs/`, `data/`, `.env` | Local-only. Gitignored. |

## Not shipped

| Path | Responsibility |
|---|---|
| `dev/` | Design handoffs, references, scratch space. See `dev/README.md`. |
| `docs/` | Written documentation (this file, `bots.md`). |

## Releasing

Three files carry the version and must agree: `desktop/package.json`,
`public/js/downloads-data.js`, `android/app/build.gradle.kts`. The full procedure is in
CLAUDE.md.

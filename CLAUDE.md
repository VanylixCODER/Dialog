# Dialog — notes for Claude sessions

Dialog is a self-hosted messenger (chat · group calls · screen share) live at
**https://dialogmsg.xyz**. This file captures the commands/gotchas that aren't
obvious from the code. Repo is public: `VanylixCODER/Dialog`.

## Architecture (one glance)
- **Backend:** Node/Express + Socket.IO (`server.js`), MySQL 8 (`db.js`), Redis,
  behind Caddy — all Docker via `docker-compose.prod.yml`. Prod is a 1 GB / 1 vCPU box.
- **Calls/screen share:** offloaded to **LiveKit Cloud** (SFU); the app only does
  ringing/signalling. TURN via Metered/openrelay.
- **Frontend:** static SPA in `public/` — `app.js` (one big file), `css/style.css`,
  `index.html`, `js/i18n.js` (en + ru), `js/icons.js` (**Lucide** outline set,
  `window.ICON.*`).
- **Desktop app:** Electron thin shell in `desktop/` that loads the hosted URL
  (does NOT bundle `public/`). **Android:** native WebView in `android/`.
  Both are wrappers → web changes reach them automatically once deployed.

## Deploy (this is the whole flow)
Pushing to `main` fires a **webhook** (`/webhook` in `server.js`) that does
`git reset --hard origin/main` and rebuilds **only the `app` container**
(`docker compose up -d --build app`). So for any `public/` or `server.js` change:

```bash
git add … && git commit -m "…" && git push origin main
```

Then **verify it's actually live** (build takes ~2–3 min; static files are
cache-busted):

```bash
curl -s "https://dialogmsg.xyz/app.js?cb=$RANDOM" | grep -c "<some new symbol>"
# poll until it returns ≥1
```

Notes:
- The webhook does NOT recreate `mysql`, `caddy`, or `redis`. To apply a
  `docker-compose.prod.yml` change to those, SSH and run e.g.
  `docker compose -f docker-compose.prod.yml up -d mysql` (data is in a volume).
- Prod SSH host is `ubuntu@89.168.31.113`; the key is provided by the user
  per-session — never commit it or store it in the repo.
- `Co-Authored-By` trailer on commits; `main` is the default/deploy branch.

## Desktop build + publish (GitHub Releases, electron-updater)
Version must match in **three** places: `desktop/package.json`,
`public/js/downloads-data.js` (`VERSION`), and `android/app/build.gradle.kts`
(`versionName`/`versionCode`). Then:

```bash
# Linux + Windows are built locally (wine is installed for the nsis .exe):
cd desktop
env -u ELECTRON_RUN_AS_NODE CSC_IDENTITY_AUTO_DISCOVERY=false \
  ./node_modules/.bin/electron-builder --linux AppImage deb pacman --publish never
env -u ELECTRON_RUN_AS_NODE CSC_IDENTITY_AUTO_DISCOVERY=false WINEDEBUG=-all \
  ./node_modules/.bin/electron-builder --win nsis --publish never
./publish-dist.sh            # creates release v<version> + uploads dist/* (incl. latest*.yml)

# macOS + Android build on CI (no local toolchain) — dispatch after pushing the bump:
gh workflow run build-mac.yml     -f tag=v<version>
gh workflow run build-android.yml -f tag=v<version>
```

Verify the release + the three auto-update feeds resolve:
```bash
gh release view v<version> --repo VanylixCODER/Dialog --json assets --jq '.assets[].name'
for f in latest.yml latest-linux.yml latest-mac.yml; do
  curl -s -o /dev/null -w "$f %{http_code}\n" -L \
    "https://github.com/VanylixCODER/Dialog/releases/download/v<version>/$f"; done
gh api repos/VanylixCODER/Dialog/releases/latest --jq .tag_name   # must equal v<version>
```

## Gotchas learned the hard way
- **Auto-update filenames must have no spaces** — GitHub rewrites spaces to dots
  and breaks the `latest.yml` URL. nsis `artifactName` is `Dialog-Setup-${version}.exe`.
- **Native fullscreen hides body-level modals** behind the fullscreened element.
  While a call is fullscreen, reparent modals INTO `#callStage` (see `fsReparent`
  in `app.js`); all fullscreen CSS is keyed off `.fs-call` (works for the iOS
  `.manual-fs` overlay too — iOS Safari has no element Fullscreen API).
- **Button hover tooltips are the CSS `[data-tip]` pill**, set once in `setIcons()`
  — updating only the native `title` won't change what the user sees.
- **Chat history loads in chunks of 25** (`HISTORY_LIMIT` server, `CHUNK` client —
  keep them equal). Prepend older chunks before a FIXED anchor, never by shifting
  indices.
- The desktop tray talks to the page via `desktop/src/preload.js` ↔ `window.__dialogSetStatus`
  / the `dialog-presence` event. Preload changes need a **desktop rebuild** to ship;
  `public/` changes do not.
- Perf-budget CI (`perf.yml`) may show red on pushes — it's a budget check, not the build.

## Quick checks
```bash
node --check public/app.js && node --check server.js   # app.js is browser JS but parses under node
curl -s -o /dev/null -w "%{http_code}\n" https://dialogmsg.xyz/login   # 200 = app up
```

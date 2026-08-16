# Releasing Dialog apps

Installers + auto-update are served from this **public** repo's GitHub
Releases: [`VanylixCODER/Dialog`](https://github.com/VanylixCODER/Dialog).
Download links on the site and `electron-updater` both read them.

---

## Cutting a release `vX.Y.Z`

### 1. Bump the version in all three places (must match!)
| File | Field |
|------|-------|
| `desktop/package.json` | `"version": "X.Y.Z"` |
| `public/js/downloads-data.js` | `const VERSION = "X.Y.Z"` |
| `android/app/build.gradle.kts` | `versionName = "X.Y.Z"` (and bump `versionCode`) |

Commit + push these to `main` (deploys the updated download page).

### 2. Build the installers into `desktop/dist/`
- **Linux** (local): `cd desktop && npm run dist` → AppImage + deb + pacman + `latest-linux.yml`.
- **Windows**: `npm run dist:win` (needs Wine or a Windows box) → the `Dialog-Setup-X.Y.Z.exe`
  installer, the `Dialog-Portable-X.Y.Z.exe` portable build, and `latest.yml`.
- **Flatpak** (local): electron-builder's flatpak target needs a native
  `flatpak-builder`. Where there isn't one, build the bundle from the Flathub
  manifest instead — same manifest, so this doubles as a check that it still
  builds:

  ```bash
  cd desktop/flatpak
  B=../.fpbuild && rm -rf $B && mkdir -p $B
  flatpak run org.flatpak.Builder --force-clean --user \
    --state-dir=$B/state --repo=$B/repo $B/build xyz.dialogmsg.app.yml
  flatpak build-bundle $B/repo ../dist/Dialog-X.Y.Z.flatpak xyz.dialogmsg.app
  rm -rf $B
  ```
  The manifest pulls the payload tarball from the release, so publish that first
  (see `desktop/flatpak/README.md`).
- **macOS** (CI): push tag `mac-X.Y.Z` → the `Build macOS` workflow builds the
  universal `.dmg`/`.zip` + `latest-mac.yml`. Download the `dialog-macos`
  artifact and drop its files into `desktop/dist/`.
- **Android** (CI): push tag `apk-X.Y.Z` → the `Build Android` workflow builds
  `Dialog-X.Y.Z.apk`. Download the `dialog-android` artifact into `desktop/dist/`.

  ```bash
  git tag mac-X.Y.Z && git push origin mac-X.Y.Z
  git tag apk-X.Y.Z && git push origin apk-X.Y.Z
  # when the runs finish:
  gh run download <run-id> -n dialog-macos   -D desktop/dist
  gh run download <run-id> -n dialog-android -D desktop/dist
  ```

### 3. Publish to the dist repo
```bash
cd desktop && ./publish-dist.sh
```
Creates release `vX.Y.Z` on the public Dialog repo and uploads every installer +
`latest-*.yml`. (Tag is derived from `desktop/package.json`.)

### 4. Verify
- Download page: <https://dialogmsg.xyz/download> — each platform link resolves.
- Auto-update: an installed older build prompts to update within a few minutes
  (or via tray → **Check for updates**).

> **Never re-upload `latest*.yml` from a partial build.** Building a single
> target (say `--win portable`) regenerates the feed listing only that artifact,
> which would point every installed Windows client at the portable build.
> Upload the `.yml` files only from a full `dist:win` / `dist` run.
>
> The portable and Flatpak builds do not self-update — `updater.js` disables
> itself when `PORTABLE_EXECUTABLE_DIR` or `FLATPAK_ID` is set — so neither
> belongs in a `latest*.yml` feed anyway.

---

## Windows code signing
Builds are signed when `CSC_LINK` (path to the `.pfx`) is set; otherwise they're
unsigned. We use the **system** `osslsigncode` (electron-builder's bundled one is
linked against OpenSSL 1.1 and crashes on modern distros) via `scripts/win-sign.js`.

One-time:
```bash
sudo pacman -S osslsigncode            # Arch/EndeavourOS (Debian: apt install osslsigncode)
cd desktop && ./scripts/gen-win-cert.sh   # self-signed cert -> dialog-selfsign.pfx
```
Build signed:
```bash
CSC_LINK="$PWD/dialog-selfsign.pfx" CSC_KEY_PASSWORD=dialog npm run dist:win
```
- **Self-signed signs the binary but is NOT trusted** — Windows SmartScreen still
  shows "Unknown publisher". To remove the warning, replace the `.pfx` with a
  CA-issued Authenticode cert (keep CN = `Dialog Messanger App` to match
  `win.publisherName`). The `.pfx` is git-ignored — never commit it.

## Notes / gotchas
- **Keep every platform at the same `X.Y.Z`** — the download links and updater
  feeds are version-pinned, so a missing platform build = 404 for that link.
- **Linux auto-update** only covers the **AppImage** (electron-updater can't
  update `.deb`/`.pacman`/`.flatpak`). Windows `.exe` + macOS `.zip` update fine.
- **Code signing**: builds are unsigned — Windows SmartScreen / macOS Gatekeeper
  show a one-time warning, and macOS silent auto-update really wants a signed +
  notarized build. Add certs later if you want a clean install.
- **Filenames**: GitHub turns spaces into dots, so the Windows installer is
  published as `Dialog.Setup.X.Y.Z.exe` (matches `downloads-data.js`).
- **CI cross-repo**: the build workflows currently attach to the *private* repo
  for storage; publishing to the public the public Dialog repo is done by
  `publish-dist.sh` with your local `gh` auth (no PAT-in-CI needed).

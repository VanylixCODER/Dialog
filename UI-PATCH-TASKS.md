# Dialog — Classic UI patch pass (task tracker)

Working checklist for the UI patches on the rolled-back header-based design. Ship batch by
batch; deploy + verify each before moving on. Status: `[ ]` todo · `[~]` in progress · `[x]` done.

## Locked decisions
- **Matrix rain:** ON by default only for the Matrix theme (behind chat, ~0.8 opacity + light
  blur, messages readable). Global toggle, OFF by default on all other themes; exposes speed +
  character color. A user custom background hides the rain.
- **Flashbang:** KEEP the name AND the "you're about to get blinded" easter-egg + confirm popup
  (user loves it). Only restyle the resulting light theme to look clean/professional.
- **No global dark/white switch anywhere.**
- **Appearances:** a new tab in the main Settings overlay with subtabs (Themes = defaults +
  workshop favorites; Appearance = glow + custom borders + matrix toggle + call visualizer toggle).
- **Glow slider:** shown 0–100%, maps to real 0–50% (`--glow-strength` 0–0.5).
- **Voice:** send+mic merged (empty input ⇒ mic). Mobile: hold-record, swipe-up lock, tap-send,
  swipe-left cancel, live timer, 60s cap. PC: click start / click stop+send.
- **Calls:** remake incoming-call buttons; Cava-style per-tile voice visualizer (bottom of each
  tile, full width, amplitude-reactive per participant) + keep the speaking glow; toggleable in
  Appearances. Incoming-card bars are ambient (not ringtone-driven).

## Files in play
`public/index.html` · `public/app.js` · `public/css/style.css` · `public/js/matrix.js` · `public/js/i18n.js`

---

## Batch 1 — Labels escaping bubbles/buttons + off-center icons  [x]
- [x] Control icons render as blocks (`… > svg { display:block }`) so they center instead of sitting on the baseline.
- [x] Icon-only buttons centered: `.icon-btn`, `.hicon-btn`, `.ma-btn`, `.tile-expand`, `.call-btn`, `.ci-btn` → grid/place-items:center.
- [x] Icon+label buttons (`.btn-primary`/`.btn-ghost` → flex center; `.cm-item`, `.chat-menu/.account-menu/.me-status-menu button` → flex) with label spans `overflow:hidden; ellipsis; min-width:0`.
- [x] Bubbles: `min-width:0; word-break:break-word; overflow-wrap:anywhere`; links break too.
- [~] Deploy + verify (long unbroken message, open menus, icons centered).

## Batch 2 — Flat minimalist themes + flashbang restyle  [x]
- [x] Root cause of "green border everywhere" = `--border-*` and `--shadow-*` inset-rings were primary-tinted. Redefined `--border-1/2/3` neutral white + `--shadow-*` to plain drop shadows (no green inset ring).
- [x] `.btn-primary` flattened: flat accent fill, no gradient/bevel/shimmer sweep; subtle hover shadow.
- [x] `--glow-strength` (default 0) gates `--glow-sm/md/lg`; Appearances slider will raise it (Batch 3).
- [x] Flattened `.chat-item.active` (accent bar, no ring/gradient), `.msg.me .bubble` (neutral border, no glow), `.field:focus` (subtle 2px ring), `.chatlist` (flat, no neon strip).
- [x] Flashbang restyled to a professional layered light theme (off-white/grey depth). Name + easter-egg + confirm popup untouched (they live in app.js).
- [x] Deploy + verify — live.

## Batch 3 — Settings → Appearances tab (subtabs)  [x]
- [x] Relabel Settings "Themes" tab → "Appearances"; added subtab nav (Themes / Appearance).
- [x] Themes subtab: `#themeGrid` + Favorites list (localStorage `dialog_fav_themes`, populated on Workshop apply) + Theme Studio + background section.
- [x] Appearance subtab: Glow slider (0–100% → `--glow-strength` 0–0.5), custom border color+width (`--ui-border-*` + `body.custom-border`).
- [x] `applyAppearance()` + `initAppearanceControls()` run on load; persisted to localStorage.
- [~] matrix toggle + call-visualizer toggle live here too — added in Batch 5 / 6.
- [~] Deploy + verify.

## Batch 4 — WhatsApp-style voice composer  [ ]
- [ ] Context-aware `#sendBtn` (empty ⇒ mic, text ⇒ send); retire standalone mic; keep emoji/gif/attach in mobile ⋮.
- [ ] Recording overlay (timer, slide-to-cancel, lock indicator, stop/send).
- [ ] Mobile: hold-record, swipe-up lock, tap-send, swipe-left cancel, 60s cap.
- [ ] Desktop: click start / click stop+send; Esc cancel.
- [ ] Reuse MediaRecorder→`socket.emit(audio)`; generalize `resetVoice()`.
- [ ] Deploy + verify on phone + desktop.

## Batch 5 — Matrix-rain chat background  [x]
- [x] `#chatMatrix` canvas behind messages (z-index:-1 inside isolated `.chat`); ~0.8 opacity + blur(2px).
- [x] `updateChatMatrix()` hooked into `applyWallpaper()` (covers chat open, bg change, theme change) + user-theme apply + visibilitychange.
- [x] `matrixEffective()` = ON by default for Matrix theme, OFF elsewhere (stored on/off overrides); hidden when a custom bg is set.
- [x] Appearance subtab: matrix toggle + speed + character-color, persisted; en+ru strings.
- [~] Deploy + verify.

## Batch 6 — Calls: incoming buttons + Cava voice visualizer  [ ]
- [ ] Remake incoming-call buttons (`#toastJoin`/`#toastClose` `.ci-btn`) — flat, centered icons.
- [ ] Ambient Cava bar background on the incoming card.
- [ ] Per-tile voice visualizer: AnalyserNode per participant (in `attachTrack`) + local mic for "me"; bottom-of-tile full-width bars; keep `.speaking` glow.
- [ ] Wire the Appearances toggle to enable/disable it.
- [ ] Deploy + verify a real call.

---

## Log
- (start) Rolled back remake (9ae0d7b). Plan approved. Starting Batch 1.

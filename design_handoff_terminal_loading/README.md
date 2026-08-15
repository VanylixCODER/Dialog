# Handoff: Terminal Boot Loading Screen (mobile)

## Overview
A full-screen mobile loading/splash screen styled as a Linux TTY session. On mount it "types" a command at a root prompt, streams a `systemd`-style boot log, and advances an ASCII progress bar to 100%. The only moving imagery is an animated GIF logo centered on the screen; the only other motion is the block cursor blink. Intended as the app-launch / session-restore screen for a messaging app ("Dialog").

## About the Design Files
The files in this bundle are **design references created in HTML** — a prototype showing the intended look and behavior, not production code to copy directly. The task is to **recreate this design in the target codebase's existing environment** (React Native, SwiftUI, Jetpack Compose, Flutter, web/React, etc.) using its established patterns, component library and theming. If no environment exists yet, choose the framework most appropriate to the project and implement it there.

`Terminal Loading Screen.dc.html` is a streaming "Design Component" file: markup with `{{ value }}` holes plus a small logic class. Read it as (a) a static layout spec and (b) a description of the timing/state machine. `support.js` is the harness that renders it in the browser and is **not** part of the design — do not port it.

## Fidelity
**High-fidelity.** Colors, type sizes, spacing and timing below are final. Recreate pixel-accurately, but source values from the target codebase's tokens where equivalents exist.

## Screens / Views

### Screen: Boot Loader (single screen, no navigation)
**Purpose:** Occupy the user for the ~4-6s of session restore, and signal "work is happening" with real, legible progress.

**Layout** — designed at **390 × 844** (iPhone 14 logical size), corner radius 38px in the mock (that radius is the *device frame* of the prototype; in a real app the screen is edge-to-edge and needs no radius). Background `#0a0e0b`. Four vertical zones, all absolute/flow as noted:

1. **Status strip** — height 52px, content bottom-aligned with 8px bottom padding, 26px horizontal padding. `display:flex; justify-content:space-between`. Left: `tty1`. Right: a flex row, gap 10px, with `▂▄▆` and `84%`. 12px type, letter-spacing 0.04em, color `#3aa85c`. (In production, replace with the platform status bar in light-content mode; keep the `tty1` label only if you want the conceit.)
2. **Boot log** — flow content, padding `10px 20px 0`. Font-size 12.5px, line-height 1.75.
   - **Prompt line**: flex row, gap 8px — `root@dialog` in `#3aa85c`, `:~#` in `#1f6b3a`, then the typed command in `#7cf59c`.
   - 14px spacer.
   - **Log lines**: vertical flex. Each line is a flex row, gap 8px, `white-space: pre` (the tag padding is significant). Tag `[  OK  ]` in `#28e05a`; tag `[ INFO ]` in `#1f6b3a`. Message text in `#4fb96f`.
3. **Loader block** — absolutely positioned, `top: 398px`, full width, column flex, center-aligned, gap 26px.
   - **GIF logo**: 132 × 132 (tweakable 80–220), no border, no filter, transparent background — it sits directly on the terminal ground.
   - **Progress group**: column flex, center, gap 10px, letter-spacing 0.06em, 12.5px.
     - ASCII bar: `[` + `█`×filled + `░`×(22−filled) + `]`, 22 cells total, color `#28e05a`, `white-space: pre`.
     - Status line: `" 42%  loading dialog"` (percentage right-padded to 3 chars) in `#3aa85c`; at 100% it reads `100%  ready — press any key`.
4. **Footer** — absolute, `left/right: 20px`, `bottom: 34px`. 12.5px, line-height 1.75.
   - Tail line: flex row, gap 8px — `-->` in `#1f6b3a`, current sub-task text in `#4fb96f`, suffixed `…`.
   - Prompt + cursor, margin-top 6px: `root@dialog` `:~#` then an **8 × 15px solid block** `#28e05a` blinking.
   - Home-indicator bar: margin-top 22px, 132 × 5px, radius 3px, `#1c2a20`, horizontally centered. (Prototype affordance — drop it on a real device.)

**Typography (everything):** JetBrains Mono, weights 400/500, fallback `ui-monospace, Menlo, monospace`. Two sizes only: 12px (status strip) and 12.5px (all terminal text). No headings, no non-mono type anywhere.

## Interactions & Behavior
- **No tap targets.** The screen is non-interactive; it exists until loading resolves.
- **Tick loop:** one interval at **42ms**.
  - Phase 1 — *typing*: reveal one more character of the command per tick until complete (`dialog --boot --profile=mobile` = 29 chars ≈ 1.2s).
  - Phase 2 — *progress*: each tick adds `speed * (0.55 + random() * 1.1)` percent, clamped at 100. With `speed = 1` that averages ~1.1%/tick ⇒ ~3.8s to full, with natural jitter. The jitter is the point: even pacing reads as fake.
- **Log reveal:** number of visible lines `= floor(pct / 100 * (BOOT.length + 0.6))`, so lines appear as progress crosses thresholds and the last line lands just before 100%. Lines never animate in — they simply exist on the next frame (matches real console output).
- **Tail line:** `TAILS[min(4, floor(pct / 20))]`; at 100% it becomes `session established`.
- **Cursor:** `@keyframes blink { 0%,49% {opacity:1} 50%,100% {opacity:0} }`, 1.05s, `step-end`, infinite.
- **Explicitly no other effects** — no CRT scanlines, glow, flicker, gradient, scale or fade. The GIF and the cursor are the only animation. Keep it that way.
- **Real integration:** drive `pct` from actual load milestones rather than a timer when the host app can report them; keep the jittered interpolation between milestones so the bar never freezes. Ensure a minimum on-screen time (~1.5s) so the screen never flashes.
- **Responsive:** the log is top-anchored and the footer bottom-anchored, so both survive taller/shorter viewports. The loader block's `top: 398px` should become "vertically centered in the space between log and footer" in a fluid implementation. Long log lines are not wrapped in the mock — clip or wrap, but never ellipsize (a truncated console line looks broken).
- **States not designed:** error/failure state. If you need one, the natural extension is a `[FAILED]` tag in a red from the same low-chroma family plus a retry line at the prompt — get design sign-off first.

## State Management
| State | Type | Purpose |
| --- | --- | --- |
| `pct` | float 0–100 | Master clock: drives bar, percentage, visible log lines, tail line |
| `shown` | int | Count of visible boot log lines (derived from `pct`) |
| `typed` | int | Characters of the command revealed |

Tunable inputs (exposed as props in the prototype): `command` (string, default `dialog --boot --profile=mobile`), `speed` (0.25–3, default 1), `logoSize` (80–220px, default 132).

No data fetching in the prototype. In production the only dependency is the host app's load-progress signal.

## Design Tokens
**Colors** (a deliberate 6-step green ramp on near-black — the project's Nocturne design system is dark/blurple, but this screen intentionally overrides the accent to terminal green per the brief; keep Nocturne's *structure* — dark ground, low chroma outside the accent, no pure black or white):
| Token | Hex | Use |
| --- | --- | --- |
| ground | `#0a0e0b` | Screen background |
| ground-outer | `#07090a` | Page backdrop behind the device mock only |
| green-500 | `#28e05a` | Bar fill, `[ OK ]` tag, cursor, base terminal green |
| green-300 | `#7cf59c` | Typed command (brightest — the user's own input) |
| green-600 | `#4fb96f` | Log message text |
| green-700 | `#3aa85c` | Status strip, percentage line, `user@host` |
| green-800 | `#1f6b3a` | Punctuation `:~#`, `-->`, `[ INFO ]` tag |
| surface-dim | `#1c2a20` | Home indicator bar |

**Spacing:** 6, 8, 10, 14, 20, 22, 26, 34 px. **Type scale:** 12, 12.5 px. **Line-height:** 1.75. **Letter-spacing:** 0.04em (status), 0.06em (progress). **Radius:** 3px (indicator), 38px (device frame only). **Shadows:** none in-screen; the mock's frame uses `0 40px 90px rgba(0,0,0,.7)` + `0 0 0 1px rgba(40,224,90,.16)` — do not port.

## Assets
- `assets/3Dialog.gif` — 300 × 300 animated GIF, 150 frames, transparent background, supplied by the user. Rendered at 132 × 132. Ship it at 2×/3× density (or as an APNG/WebP/Lottie equivalent) so it stays crisp; preserve transparency and do not place it on a card or tinted plate.
- **Fonts:** JetBrains Mono 400/500 (Google Fonts, OFL). Bundle it locally in production; fall back to the platform monospace (SF Mono / Roboto Mono) if adding a font is not worth it.
- Phosphor icons are the design system's icon set, but **this screen uses no icons** — the `▂▄▆` glyphs are text.

## Files
- `Terminal Loading Screen.dc.html` — the design (markup + timing logic). The reference implementation.
- `support.js` — prototype runtime harness. Not part of the design; do not port.
- `assets/3Dialog.gif` — the logo asset.
- `nocturne/styles.css` — the project's design-system token sheet, for context on the surrounding app's ground, ramps, spacing scale and interaction states.

To view the prototype, serve the folder over HTTP and open the `.dc.html` file (`python3 -m http.server`); opening it from `file://` will not load the harness.

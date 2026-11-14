# Sounds

Drop a file here named after a slot and Dialog plays it instead of the built-in tone.
Push to `main` and it's live after the deploy. No code change is needed, because the server
lists this folder at `/src/sounds/manifest.json`.

- **Name** = the slot name below + an extension: `.mp3`, `.ogg`, `.wav`, `.m4a` or `.webm`.
  Lowercase letters, digits, `_` and `-` only (e.g. `mic_off.mp3`). If a slot has two
  formats, the first one listed alphabetically wins, so keep one file per slot.
- **Slots without a file** keep the built-in synth tone (or stay silent where noted).
- **One-shots** are decoded up front, so they play instantly. Keep them short (under ~1.5 s)
  and small (under ~100 KB). Trim the leading silence, or the sound will feel late.
- **Loops** (`ringtone`, `ringback`) stream and repeat. Make them loop cleanly.

| Slot | When it plays | If the file is removed |
|---|---|---|
| `ringtone` | Incoming call (loops until answered/dismissed) | `public/ringtone.mp3` |
| `ringback` | Outgoing call: you're alone in a DM call waiting for them to pick up (loops, max 60 s) | soft dual tone every 3 s |
| `message` | New message in an open or unmuted chat | beep |
| `mention` | You were @-mentioned / pinged | higher beep |
| `call_start` | You joined a call | rising 3-note chime |
| `call_end` | You left / the call ended | falling 2-note chime |
| `user_join` | Someone joined the call you're in | 2-note up |
| `user_leave` | Someone left the call you're in | 2-note down |
| `mic_on` | You unmuted your mic | click |
| `mic_off` | You muted your mic | lower click |
| `deafen_on` | Headphones off (you deafened) | 2-note down |
| `deafen_off` | Headphones back on (undeafened) | 2-note up |
| `camera_on` | You turned your camera on | silent |
| `camera_off` | You turned your camera off | silent |
| `screen_start` | You started sharing your screen | 2-note up |
| `screen_stop` | You stopped sharing your screen | 2-note down |

Deafening also mutes your mic, but only the deafen sound plays, not both.

## The sound set

Every sound shares the ringtone's voice: an NES-style 4-bit staircase triangle (like the original
`public/ringtone.mp3`), sample-and-hold at 22 kHz, a darkening echo, and the mix crushed to 8 bits.
The notes come from the ringtone melody in `ultrabox/ringtone.mid` (A, C, D, G).

| Sound | Notes | Echo / length |
|---|---|---|
| `ringtone` | the .mid note for note: phrase · 8 beats · phrase · 8 beats (13.7 s loop) | 0.75 s, wraps over the loop point |
| `ringback` | the melody's "A A" pickup, then quiet (3.4 s loop) | 0.75 s, wraps |
| `message` / `mention` | A→C / A A C (the melody's opening) | 0.12 s, ~0.5–0.65 s total |
| `call_start` / `call_end` | A C D rising / D C A G (the phrase ending) | 0.12 s, ~0.65–0.7 s total |
| `user_join` / `user_leave` | A→D / D→A | 0.12 s, ~0.55 s total |
| `mic_on` / `mic_off` | D / A | 0.12 s, ~0.45 s total |
| `deafen_on` / `deafen_off` | D→G / G→D | 0.12 s, ~0.55 s total |
| `camera_on` / `camera_off` | C D / D C | 0.12 s, ~0.55 s total |
| `screen_start` / `screen_stop` | G A C D / D C A G | 0.12 s, ~0.65 s total |

The short sounds use quick notes (65 ms, last one 110 ms) and a little 0.12 s echo with a couple
of fading repeats, so they're over well inside a second. `ultrabox/` holds the older UltraBox projects and the
ringtone's source .mid.

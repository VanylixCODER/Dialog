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
`public/ringtone.mp3`), sample-and-hold at 22 kHz, a 0.75 s echo whose repeats get a little darker,
and the mix crushed to 8 bits. The notes come from the ringtone melody in `ultrabox/ringtone.mid`
(A, C, D, G at 140 bpm):

| Sound | Notes | Echo |
|---|---|---|
| `ringtone` | the .mid note for note: phrase · 8 beats · phrase · 8 beats (13.7 s loop) | full, wraps over the loop point |
| `ringback` | the melody's "A A" pickup, then quiet (3.4 s loop) | full, wraps |
| `message` / `mention` | A→C / A A C (the melody's opening) | full |
| `call_start` / `call_end` | A C D rising / D C A G (the phrase ending) | full |
| `user_join` / `user_leave` | A→D / D→A | one faint repeat |
| `mic_on` / `mic_off` | D / A | one faint repeat |
| `deafen_on` / `deafen_off` | D→G / G→D | one faint repeat |
| `camera_on` / `camera_off` | C D / D C | one faint repeat |
| `screen_start` / `screen_stop` | G A C D / D C A G | one faint repeat |

Quick toggles get a single quiet repeat at the same 0.75 s delay, so they keep the voice without
sounding like they were pressed twice. `ultrabox/` holds the older UltraBox projects and the
ringtone's source .mid.

# UltraBox projects

Everything is built around **your** `ringtone.json` / `ringback.json`. Every other sound uses that
exact instrument: a Picked String with "fifth" unison (each note sounds as a power chord), very
short sustain, a "punch" envelope on the filter, a high-pass at 177 Hz and a half-beat echo.
They also share your key (D♯, two octaves up) and tempo (125 bpm). Every sound is one voice
built from root, fifth and octave, like your ringtone's pattern. Pitches below are written the
way UltraBox shows them, relative to the key (tonic shown as D).

The echo is turned down on the small sounds (20–57% instead of your 71%) and the tails are cut
after a couple of repeats, so they stay 0.3–1 s long.

Click a name to open it in [UltraBox](https://ultraabox.github.io); the whole song is in the
link. Each `.json` is the same project, for **File → Import JSON**. After editing, **File →
Export → .mp3** and save it over `../<slot>.mp3`. The app plays the `.mp3`, not the `.json`.

| Sound | Notes |
|---|---|
| [`ringtone`](https://ultraabox.github.io/#u5N06Dialogn100s0k34l00e03t1Za3g03j03r1O_U00i0o3T7v0puh7f021672o500q1A010r8000O055d040HTi0706gf001086h5I1E1c0b2basp1VFAu12F4s55wYAbAxqn68bwwI5AxsAbiVIbBxr6i5OgJbyEn0Nrei5OgJ8) | **yours**: 4 bars, root–fifth–octave pluck pattern over D – B♭ – G – A |
| [`ringback`](https://ultraabox.github.io/#u5N06Dialogn100s0k34l00e00t1Za3g03j03r1O_U00i0o3T7v0pu07f021672o500q1A010r8000O045d040HTi0706gf001086h5I1E1c0b2basp1cFyUkpsChM9yw) | **yours**: F♯ … D – E, one bar |
| [`message`](https://ultraabox.github.io/#u5N06Dialogn100s0k34l00e00t1Za3g00j00r1O_U00i0o0T7v0pu07f021672o500q1A010r8000O035d040HTi0706gf001086h5I1E1c0b2bwp1bFiQQ2p7x3Bg) | fifth → octave (A → D) |
| [`mention`](https://ultraabox.github.io/#u5N06Dialogn100s0k34l00e00t1Za3g00j00r1O_U00i0o0T7v0pu07f021672o500q1A010r8000O045d040HTi0706gf001086h5I1E1c0b2bwp1eFyUOikJ6iEW8su) | root – fifth – octave (the ringtone's cell) |
| [`call_start`](https://ultraabox.github.io/#u5N06Dialogn100s0k34l00e00t1Za3g00j00r1O_U00i0o0T7v0pu07f021672o500q1A010r8000O045d040HTi0706gf001086h5I1E1c0b2bwp1iFyUOigI6iBEypjwPwM) | root – fifth – octave, landing on the major third |
| [`call_end`](https://ultraabox.github.io/#u5N06Dialogn100s0k34l00e00t1Za3g00j00r1O_U00i0o0T7v0pu07f021672o500q1A010r8000O045d040HTi0706gf001086h5I1E1c0b2bwp1eFyURikJkiGqIsi) | octave – fifth – root |
| [`user_join`](https://ultraabox.github.io/#u5N06Dialogn100s0k34l00e00t1Za3g00j00r1O_U00i0o0T7v0pu07f021672o500q1A010r8000O025d040HTi0706gf001086h5I1E1c0b2bwp1bFiQOip7xzBg) | root → fifth |
| [`user_leave`](https://ultraabox.github.io/#u5N06Dialogn100s0k34l00e00t1Za3g00j00r1O_U00i0o0T7v0pu07f021672o500q1A010r8000O025d040HTi0706gf001086h5I1E1c0b2bwp1bFiQQ2l7lzBg) | fifth → root |
| [`mic_on`](https://ultraabox.github.io/#u5N06Dialogn100s0k34l00e00t1Za1g00j00r1O_U00i0o0T7v0pu07f021672o500q1A010r8000O015d040HTi0706gf001086h5I1E1c0b2bwp17Fktdkpo) | single note, D |
| [`mic_off`](https://ultraabox.github.io/#u5N06Dialogn100s0k34l00e00t1Za1g00j00r1O_U00i0o0T7v0pu07f021672o500q1A010r8000O015d040HTi0706gf001086h5I1E1c0b2bwp17Fktd0po) | single note, A (lower) |
| [`deafen_on`](https://ultraabox.github.io/#u5N06Dialogn100s0k34l00e00t1Za3g00j00r1O_U00i0o0T7v0pu07f021672o500q1A010r8000O025d040HTi0706gf001086h5I1E1c0b2bwp1bFiQRil7kPBg) | D → B♭ (drops to the ringtone's dark chord) |
| [`deafen_off`](https://ultraabox.github.io/#u5N06Dialogn100s0k34l00e00t1Za3g00j00r1O_U00i0o0T7v0pu07f021672o500q1A010r8000O025d040HTi0706gf001086h5I1E1c0b2bwp1bFiQQip7wPBg) | B♭ → D |
| [`camera_on`](https://ultraabox.github.io/#u5N06Dialogn100s0k34l00e00t1Za3g00j00r1O_U00i0o0T7v0pu07f021672o500q1A010r8000O025d040HTi0706gf001086h5I1E1c0b2bwp1bFiQOOp7wjBg) | E → F♯ (borrowed from your ringback) |
| [`camera_off`](https://ultraabox.github.io/#u5N06Dialogn100s0k34l00e00t1Za3g00j00r1O_U00i0o0T7v0pu07f021672o500q1A010r8000O025d040HTi0706gf001086h5I1E1c0b2bwp1bFiQPil7kjBg) | F♯ → E |
| [`screen_start`](https://ultraabox.github.io/#u5N06Dialogn100s0k34l00e00t1Za3g00j00r1O_U00i0o0T7v0pu07f021672o500q1A010r8000O035d040HTi0706gf001086h5I1E1c0b2bwp1gFiQOigI6MhczMNN8) | D – A – D – A climbing |
| [`screen_stop`](https://ultraabox.github.io/#u5N06Dialogn100s0k34l00e00t1Za3g00j00r1O_U00i0o0T7v0pu07f021672o500q1A010r8000O035d040HTi0706gf001086h5I1E1c0b2bwp1gFiQT4IAb54GeH74w) | the same climb, falling |

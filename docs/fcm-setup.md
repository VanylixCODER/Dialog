# FCM push — setup (what's built, what I need from you)

FCM lets the server wake a phone and post a notification **even when the app is fully
closed**, without the battery cost of the always-on background service. The server and web
halves are built and live (inert until Firebase is configured). Two things only you can
create in Firebase are the remaining blockers.

## ✅ Already built & deployed (server + web)

- **DB:** `fcm_tokens` table (device token → login).
- **Server:** `sendFcm(login, payload)` — dependency-free FCM HTTP v1 sender (signs an
  OAuth2 JWT with the service-account key via `node:crypto`; caches the access token). It's
  fanned into the existing `sendPush(login, …)`, so **every message/call notification that
  already goes to Web Push now also goes to FCM**. No-op until `FCM_SA` is set.
- **Endpoints:** `POST /api/push/fcm` (register token), `POST /api/push/fcm/delete`
  (unregister on logout), `GET /api/push/fcm/status` (`{enabled}`).
- **Web:** registers the device token (delivered by the native app via
  `window.dialogFcmToken(tk)`) on login; unregisters on logout.

## �� What I need from you (Firebase — ~10 min)

1. **Create a Firebase project** at <https://console.firebase.google.com> (or reuse one).
2. **Add an Android app** to it:
   - Package name: **`xyz.dialogmsg.app`** (must match exactly).
   - Download the generated **`google-services.json`** → send it to me (or drop it in
     `android/app/google-services.json`).
3. **Service account key** (so the server can send): Project settings → **Service accounts**
   → **Generate new private key** → download the JSON → send it to me privately. This
   becomes the server env var **`FCM_SA`** (raw JSON) — I'll set it on the prod box; it is a
   secret and will **not** be committed.

That's it. With those two files I finish the Android side and flip it on.

## What I'll do once I have them

**Server (prod):** add `FCM_SA=<service-account JSON>` to the app container env
(`docker-compose.prod.yml`) and restart — `sendFcm` goes live.

**Android** (`android/`), then a new release:

- `app/build.gradle.kts`: apply `com.google.gms.google-services`, add
  `implementation("com.google.firebase:firebase-messaging:24.x")`.
- Top-level `build.gradle.kts`: `classpath("com.google.gms:google-services:4.4.x")`.
- Drop in `app/google-services.json`.
- New `FcmService.kt`:

```kotlin
package xyz.dialogmsg.app

import com.google.firebase.messaging.FirebaseMessagingService
import com.google.firebase.messaging.RemoteMessage

class FcmService : FirebaseMessagingService() {
    // New/rotated token → hand it to the web app to register with the server.
    override fun onNewToken(token: String) {
        MainActivity.evalJs("window.dialogFcmToken && window.dialogFcmToken('" + token + "')")
    }
    // Data-only push → render it through the same NotificationHelper the web uses.
    override fun onMessageReceived(msg: RemoteMessage) {
        val d = msg.data
        val kind = d["kind"] ?: "msg"
        val title = d["title"] ?: "Dialog"
        val body = d["body"] ?: ""
        val room = d["room"] ?: ""
        val n = NotificationHelper(this)
        if (kind == "call") n.showIncomingCall(room, title, room.startsWith("@grp:")) else n.show(title, body, room)
    }
}
```

- `WebAppInterface.getFcmToken()` bridge → `FirebaseMessaging.getInstance().token` then
  `MainActivity.evalJs("window.dialogFcmToken('…')")`.
- Manifest: register `FcmService` with intent-filter
  `com.google.firebase.MESSAGING_EVENT`.

## Notes

- Data-only messages (not `notification`) are used so our own service always renders them —
  they fire when the app is backgrounded **or** killed.
- FCM and the current background service are complementary: you can keep both, or once FCM
  is proven, default "Run in background" off to save battery.
- Dead tokens (HTTP 404/400) are auto-pruned on send.

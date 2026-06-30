# Dialog Android

Native Android **WebView** wrapper for **Dialog**. It loads the hosted web app
at **https://dialogmsg.xyz** and adds:

- **No in-app permission prompts** — the WebView auto-grants mic/camera/screen
  requests (`onPermissionRequest`). OS runtime permissions are requested once up
  front (see caveats).
- **Native notifications** — the web `Notification` API is bridged to
  `NotificationCompat`; tapping reopens the app.
- **Hacker-movie boot loader** — a 3:4 framed terminal overlay with a fake
  secure-shell boot sequence and a **live status line under the logo**
  (`Connecting…` → `Authenticating` → `Online`, or **`No Internet Access`** when
  offline), fading out once the page is ready.
- File uploads, deep links (`https://dialogmsg.xyz/...`), back-navigation.

## Build

Requires the **Android SDK** (API 34) and JDK 17. Easiest path is to open the
`android/` folder in **Android Studio**, which provisions the SDK automatically.

From the command line:

```bash
cd android
echo "sdk.dir=$ANDROID_HOME" > local.properties   # path to your Android SDK
./gradlew assembleDebug        # debug APK
./gradlew assembleRelease      # release APK (configure signing first)
```

APKs are produced under `app/build/outputs/apk/`.

Change the backend URL via `buildConfigField("String", "APP_URL", ...)` in
`app/build.gradle.kts`.

> The Gradle wrapper jar/scripts are committed. If your environment lacks them,
> run `gradle wrapper --gradle-version 8.7` once, or open the project in Android
> Studio.

## Signing (release)

Add a `signingConfigs` block to `app/build.gradle.kts` referencing your keystore
and wire it into `buildTypes.release`, then `./gradlew assembleRelease` (or
`bundleRelease` for an `.aab` for Play).

## Structure

| File | Role |
|------|------|
| `MainActivity.kt` | Hosts the WebView, requests permissions, watches connectivity, drives the loader |
| `DialogWebChromeClient.kt` | Auto-grants web permissions + file chooser |
| `DialogWebViewClient.kt` | Same-origin navigation + page/error events |
| `WebAppInterface.kt` | JS bridge (`Android.ready()`, `Android.notify()`) |
| `NotificationHelper.kt` | Native notification channels + rendering |
| `BootLoader.kt` | Terminal boot animation + status line |
| `res/layout/{activity_main,loader}.xml` | WebView + loader overlay |

## Caveats

- **Runtime permissions**: Android requires the user to grant `RECORD_AUDIO` /
  `CAMERA` at the OS level once (requested on first launch). This cannot be
  bypassed; only the in-page web prompt is eliminated.
- **Screen share** (`getDisplayMedia`): Android's system "Start recording?"
  consent dialog is mandatory and OS-enforced. Mobile screenshare can be wired
  through `MediaProjection` if needed; otherwise it is desktop-first.
- **Background push**: a bare WebView does not receive Web Push when the app is
  closed. The current bridge shows native notifications while the app runs. For
  true background delivery, integrate Firebase Cloud Messaging (server changes
  required) — out of scope here.

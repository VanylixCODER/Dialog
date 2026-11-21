package xyz.dialogmsg.app

import android.content.Context
import android.content.Intent
import android.media.AudioDeviceInfo
import android.media.AudioManager
import android.os.Build
import android.webkit.JavascriptInterface

/**
 * Bridge exposed to the web app as `window.Android`.
 *  - Android.ready()                                   → dismiss the boot loader
 *  - Android.notify(title, body, id)                   → render a native notification
 *  - Android.incomingCall(room,name,login,title,group) → show the full-screen call screen
 *  - Android.cancelIncomingCall()                      → dismiss it (answered elsewhere / cancelled)
 *  - Android.friendRequest(login, name)                → notification with Accept / Decline actions
 */
class WebAppInterface(
    private val context: Context,
    private val onReady: () -> Unit,
    private val notifications: NotificationHelper
) {
    companion object {
        // Whether the web app asked to stay connected in the background (signed in +
        // background mode on). Used to resume ConnectionService after a call ends.
        @Volatile var keepAliveWanted = false
    }

    @JavascriptInterface
    fun ready() {
        onReady()
    }

    // Appearance → Loading screen. Kept in SharedPreferences because the boot splash runs
    // before the WebView exists to be asked; the value applies from the next launch.
    @JavascriptInterface
    fun setBootSpeed(v: Float) {
        context.getSharedPreferences("dialog", android.content.Context.MODE_PRIVATE)
            .edit().putFloat("boot_speed", v.coerceIn(0.25f, 6f)).apply()
    }

    // Background mode: keep the process (and its socket) alive while signed in so
    // messages/calls arrive when the app is off-screen. Called on login/logout and when
    // the user toggles "Run in background". During a call, CallService covers this, so we
    // don't double up — we resume afterwards in callEnded().
    @JavascriptInterface
    fun keepAlive(on: Boolean) {
        keepAliveWanted = on
        if (on) { if (!MainActivity.isCallActive()) ConnectionService.start(context) }
        else ConnectionService.stop(context)
    }

    // The page asks for the FCM device token on login; we resolve it async and hand it
    // back via window.dialogFcmToken(), which registers it with the server.
    @JavascriptInterface
    fun getFcmToken() {
        try {
            com.google.firebase.messaging.FirebaseMessaging.getInstance().token
                .addOnSuccessListener { tk -> if (!tk.isNullOrBlank()) FcmService.pushTokenToWeb(tk) }
        } catch (_: Exception) { /* Firebase not configured — push simply stays off */ }
    }

    // ---- In-app updates ----
    // The installed version, so the page can compare it with the latest release.
    @JavascriptInterface
    fun appVersion(): String = BuildConfig.VERSION_NAME

    // Download the new APK (only from our own GitHub releases) and open the system installer.
    // Progress and the outcome go back to the page via window.__dialogUpdate(state, pct).
    @JavascriptInterface
    fun installUpdate(url: String) {
        if (!url.startsWith("https://github.com/VanylixCODER/Dialog/releases/download/")) {
            MainActivity.evalJs("window.__dialogUpdate && window.__dialogUpdate('error', 0)"); return
        }
        // Android asks for "install unknown apps" once per app — send the user to that switch first.
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O && !context.packageManager.canRequestPackageInstalls()) {
            runCatching {
                context.startActivity(
                    Intent(android.provider.Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES, android.net.Uri.parse("package:" + context.packageName))
                        .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
                )
            }
            MainActivity.evalJs("window.__dialogUpdate && window.__dialogUpdate('needperm', 0)"); return
        }
        Thread {
            try {
                val dir = java.io.File(context.cacheDir, "updates").apply { mkdirs() }
                val file = java.io.File(dir, "dialog-update.apk")
                val conn = java.net.URL(url).openConnection() as java.net.HttpURLConnection
                conn.connectTimeout = 15000; conn.readTimeout = 30000; conn.instanceFollowRedirects = true
                val total = conn.contentLengthLong
                var done = 0L; var last = -1
                conn.inputStream.use { input ->
                    file.outputStream().use { out ->
                        val buf = ByteArray(64 * 1024)
                        while (true) {
                            val n = input.read(buf); if (n < 0) break
                            out.write(buf, 0, n); done += n
                            if (total > 0) {
                                val pct = (done * 100 / total).toInt()
                                if (pct != last) { last = pct; MainActivity.evalJs("window.__dialogUpdate && window.__dialogUpdate('downloading', $pct)") }
                            }
                        }
                    }
                }
                val uri = androidx.core.content.FileProvider.getUriForFile(context, context.packageName + ".fileprovider", file)
                val install = Intent(Intent.ACTION_VIEW).apply {
                    setDataAndType(uri, "application/vnd.android.package-archive")
                    addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_ACTIVITY_NEW_TASK)
                }
                context.startActivity(install)
                MainActivity.evalJs("window.__dialogUpdate && window.__dialogUpdate('installing', 100)")
            } catch (e: Exception) {
                MainActivity.evalJs("window.__dialogUpdate && window.__dialogUpdate('error', 0)")
            }
        }.start()
    }

    @JavascriptInterface
    fun notify(title: String, body: String, chatId: String) {
        notifications.show(title, body, chatId)
    }

    // Incoming call → ring/vibrate per ringer mode, then post a call notification with a
    // full-screen intent. Android shows the full-screen call screen when locked/idle, and a
    // heads-up Answer/Cancel notification when another app is in the foreground. DND = missed call.
    @JavascriptInterface
    fun incomingCall(room: String, name: String, login: String, title: String, isGroup: Boolean) {
        val display = if (name.isNotBlank()) name else title
        val mode = RingController.classify(context)
        if (mode == RingController.Mode.DND) {
            notifications.missedCall(display, room)
            return
        }
        RingController.start(context, mode) // NORMAL = ring+vibrate, VIBRATE = buzz only, SILENT = quiet
        notifications.showIncomingCall(room, display, isGroup)
    }

    @JavascriptInterface
    fun cancelIncomingCall() {
        RingController.stop(context)
        notifications.cancelIncoming()
        IncomingCallActivity.dismiss(context)
    }

    // Call started/ended → run a foreground service so the call survives leaving the app.
    @JavascriptInterface
    fun callStarted(title: String, sub: String) {
        MainActivity.setCallActive(true)
        ConnectionService.stop(context) // CallService keeps the process alive during the call
        CallService.start(context, title, sub)
    }

    // The page keeps the "on a call" notification current: who's in the call, mic on/off, when it began.
    @JavascriptInterface
    fun callUpdate(title: String, sub: String, micOn: Boolean, startMs: Long, room: String) {
        if (!MainActivity.isCallActive()) return
        CallService.update(context, title, sub, micOn, startMs, room)
    }

    @JavascriptInterface
    fun callEnded() {
        MainActivity.setCallActive(false)
        RingController.stop(context)
        notifications.cancelIncoming()
        CallService.stop(context)
        if (keepAliveWanted) ConnectionService.start(context) // resume background mode
    }

    // Route call audio to the loudspeaker or the earpiece. Mobile browsers don't
    // implement setSinkId, so this native hop is the only way to switch output.
    @JavascriptInterface
    fun setSpeaker(on: Boolean) {
        val am = context.getSystemService(Context.AUDIO_SERVICE) as? AudioManager ?: return
        try {
            am.mode = AudioManager.MODE_IN_COMMUNICATION
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
                // isSpeakerphoneOn is deprecated on 31+; pick the device explicitly.
                val target = if (on) AudioDeviceInfo.TYPE_BUILTIN_SPEAKER else AudioDeviceInfo.TYPE_BUILTIN_EARPIECE
                val device = am.availableCommunicationDevices.firstOrNull { it.type == target }
                if (device != null) am.setCommunicationDevice(device) else am.clearCommunicationDevice()
            } else {
                @Suppress("DEPRECATION")
                am.isSpeakerphoneOn = on
            }
        } catch (_: Exception) { /* never let audio routing crash the call */ }
    }

    @JavascriptInterface
    fun friendRequest(login: String, name: String) {
        notifications.friendRequest(login, if (name.isNotBlank()) name else login)
    }
}

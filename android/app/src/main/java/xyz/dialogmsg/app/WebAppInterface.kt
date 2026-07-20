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

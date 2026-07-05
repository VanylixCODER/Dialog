package xyz.dialogmsg.app

import android.content.Context
import android.content.Intent
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
    @JavascriptInterface
    fun ready() {
        onReady()
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
        CallService.start(context, title, sub)
    }

    @JavascriptInterface
    fun callEnded() {
        MainActivity.setCallActive(false)
        RingController.stop(context)
        notifications.cancelIncoming()
        CallService.stop(context)
    }

    @JavascriptInterface
    fun friendRequest(login: String, name: String) {
        notifications.friendRequest(login, if (name.isNotBlank()) name else login)
    }
}

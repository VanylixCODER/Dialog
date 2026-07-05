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

    // Incoming call → decide ring vs vibrate vs missed-call from the ringer/DND mode,
    // then (unless full DND) launch the over-the-lock-screen call activity.
    @JavascriptInterface
    fun incomingCall(room: String, name: String, login: String, title: String, isGroup: Boolean) {
        val mode = RingController.classify(context)
        if (mode == RingController.Mode.DND) {
            // Do-Not-Disturb: don't ring, don't buzz — just leave a missed-call notification.
            notifications.missedCall(if (name.isNotBlank()) name else title, room)
            return
        }
        RingController.start(context, mode) // NORMAL = ring+vibrate, VIBRATE = buzz only, SILENT = quiet
        val i = Intent(context, IncomingCallActivity::class.java).apply {
            addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
            putExtra(IncomingCallActivity.EXTRA_ROOM, room)
            putExtra(IncomingCallActivity.EXTRA_NAME, if (name.isNotBlank()) name else title)
            putExtra(IncomingCallActivity.EXTRA_LOGIN, login)
            putExtra(IncomingCallActivity.EXTRA_TITLE, title)
            putExtra(IncomingCallActivity.EXTRA_GROUP, isGroup)
        }
        context.startActivity(i)
    }

    @JavascriptInterface
    fun cancelIncomingCall() {
        RingController.stop(context)
        IncomingCallActivity.dismiss(context)
    }

    @JavascriptInterface
    fun friendRequest(login: String, name: String) {
        notifications.friendRequest(login, if (name.isNotBlank()) name else login)
    }
}

package xyz.dialogmsg.app

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import androidx.core.app.NotificationManagerCompat
import androidx.core.app.RemoteInput

/**
 * Handles notification action buttons and hands them to the web app via
 * MainActivity.evalJs(). Works while the app process is alive (foreground-only build).
 */
class CallActionReceiver : BroadcastReceiver() {

    companion object {
        const val ACTION_FRIEND_ACCEPT = "xyz.dialogmsg.app.FRIEND_ACCEPT"
        const val ACTION_FRIEND_DECLINE = "xyz.dialogmsg.app.FRIEND_DECLINE"
        const val ACTION_READ = "xyz.dialogmsg.app.MARK_READ"
        const val ACTION_SILENT = "xyz.dialogmsg.app.SILENT"
        const val ACTION_REPLY = "xyz.dialogmsg.app.REPLY"
    }

    override fun onReceive(context: Context, intent: Intent) {
        val arg = intent.getStringExtra("arg") ?: ""
        val a = jsStr(arg)
        when (intent.action) {
            ACTION_FRIEND_ACCEPT -> {
                MainActivity.evalJs("window.__dialogFriend && window.__dialogFriend($a,'accept')")
                cancel(context, ("fr" + arg).hashCode())
            }
            ACTION_FRIEND_DECLINE -> {
                MainActivity.evalJs("window.__dialogFriend && window.__dialogFriend($a,'decline')")
                cancel(context, ("fr" + arg).hashCode())
            }
            ACTION_READ -> {
                MainActivity.evalJs("window.__dialogMarkRead && window.__dialogMarkRead($a)")
                cancel(context, arg.hashCode())
            }
            ACTION_SILENT -> {
                MainActivity.evalJs("window.__dialogSilent && window.__dialogSilent($a)")
                cancel(context, arg.hashCode())
            }
            ACTION_REPLY -> {
                val text = RemoteInput.getResultsFromIntent(intent)?.getCharSequence(NotificationHelper.KEY_REPLY)?.toString() ?: ""
                if (text.isNotBlank()) {
                    MainActivity.evalJs("window.__dialogReply && window.__dialogReply($a, ${jsStr(text)})")
                }
                cancel(context, arg.hashCode())
            }
        }
    }

    private fun cancel(context: Context, id: Int) {
        try { NotificationManagerCompat.from(context).cancel(id) } catch (_: Exception) {}
    }

    // Safely encode a string as a JS string literal.
    private fun jsStr(s: String): String {
        val esc = s.replace("\\", "\\\\").replace("'", "\\'").replace("\n", "\\n").replace("\r", "")
        return "'$esc'"
    }
}

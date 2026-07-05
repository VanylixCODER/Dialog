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
        const val ACTION_CALL_ANSWER = "xyz.dialogmsg.app.CALL_ANSWER"
        const val ACTION_CALL_DECLINE = "xyz.dialogmsg.app.CALL_DECLINE"
        const val ACTION_CALL_MUTE = "xyz.dialogmsg.app.CALL_MUTE"
        const val ACTION_CALL_END = "xyz.dialogmsg.app.CALL_END"
    }

    override fun onReceive(context: Context, intent: Intent) {
        val arg = intent.getStringExtra("arg") ?: ""
        val a = jsStr(arg)
        when (intent.action) {
            ACTION_CALL_ANSWER -> {
                RingController.stop(context)
                MainActivity.evalJs("window.__dialogCall && window.__dialogCall.answer()")
                NotificationManagerCompat.from(context).cancel(NotificationHelper.INCOMING_ID)
                IncomingCallActivity.dismiss(context)
                runCatching {
                    context.startActivity(Intent(context, MainActivity::class.java).apply {
                        addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_REORDER_TO_FRONT or Intent.FLAG_ACTIVITY_SINGLE_TOP)
                    })
                }
            }
            ACTION_CALL_DECLINE -> {
                RingController.stop(context)
                MainActivity.evalJs("window.__dialogCall && window.__dialogCall.decline()")
                NotificationManagerCompat.from(context).cancel(NotificationHelper.INCOMING_ID)
                IncomingCallActivity.dismiss(context)
            }
            ACTION_CALL_MUTE -> MainActivity.evalJs("window.__dialogCall && window.__dialogCall.mute()")
            ACTION_CALL_END -> MainActivity.evalJs("window.__dialogCall && window.__dialogCall.end()")
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

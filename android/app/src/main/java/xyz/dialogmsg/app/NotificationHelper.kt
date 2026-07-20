package xyz.dialogmsg.app

import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.os.Build
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat
import androidx.core.app.RemoteInput

/**
 * Renders native Android notifications for messages/calls/requests that the web app
 * raises through the JS bridge. Notification actions route back through CallActionReceiver.
 */
class NotificationHelper(private val context: Context) {

    private val manager = NotificationManagerCompat.from(context)

    companion object {
        const val CHANNEL_MESSAGES = "messages"
        const val CHANNEL_CALLS = "calls"
        const val CHANNEL_SOCIAL = "social"
        const val CHANNEL_BG = "background"
        const val KEY_REPLY = "key_reply"
        const val INCOMING_ID = 4001
        private var idCounter = 1000
    }

    init {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            val nm = context.getSystemService(NotificationManager::class.java)
            nm.createNotificationChannel(
                NotificationChannel(CHANNEL_MESSAGES, "Messages", NotificationManager.IMPORTANCE_HIGH)
            )
            nm.createNotificationChannel(
                NotificationChannel(CHANNEL_CALLS, "Calls", NotificationManager.IMPORTANCE_HIGH)
                    .apply { setSound(null, null) }
            )
            nm.createNotificationChannel(
                NotificationChannel(CHANNEL_SOCIAL, "Requests", NotificationManager.IMPORTANCE_HIGH)
            )
            // Silent, low-key channel for the "running in background" ongoing notice.
            nm.createNotificationChannel(
                NotificationChannel(CHANNEL_BG, "Background connection", NotificationManager.IMPORTANCE_MIN)
                    .apply { setShowBadge(false); setSound(null, null); lockscreenVisibility = android.app.Notification.VISIBILITY_SECRET }
            )
        }
    }

    private fun openAppIntent(chatId: String): PendingIntent {
        val intent = Intent(context, MainActivity::class.java).apply {
            flags = Intent.FLAG_ACTIVITY_SINGLE_TOP or Intent.FLAG_ACTIVITY_CLEAR_TOP
            putExtra("chatId", chatId)
        }
        return PendingIntent.getActivity(
            context, chatId.hashCode(), intent,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
        )
    }

    private fun actionIntent(action: String, arg: String, mutable: Boolean = false): PendingIntent {
        val i = Intent(context, CallActionReceiver::class.java).apply {
            this.action = action
            putExtra("arg", arg)
        }
        var flags = PendingIntent.FLAG_UPDATE_CURRENT
        flags = flags or if (mutable && Build.VERSION.SDK_INT >= Build.VERSION_CODES.S)
            PendingIntent.FLAG_MUTABLE else PendingIntent.FLAG_IMMUTABLE
        return PendingIntent.getBroadcast(context, (action + arg).hashCode(), i, flags)
    }

    // Incoming chat message — with Reply / Mark read / Silent actions.
    fun show(title: String, body: String, chatId: String) {
        val b = NotificationCompat.Builder(context, CHANNEL_MESSAGES)
            .setSmallIcon(R.drawable.ic_notification)
            .setContentTitle(title.ifBlank { "Dialog" })
            .setContentText(body)
            .setAutoCancel(true)
            .setPriority(NotificationCompat.PRIORITY_HIGH)
            .setContentIntent(openAppIntent(chatId))

        if (chatId.isNotBlank()) {
            val remoteInput = RemoteInput.Builder(KEY_REPLY).setLabel("Reply").build()
            val replyAction = NotificationCompat.Action.Builder(
                R.drawable.ic_notification, "Reply", actionIntent(CallActionReceiver.ACTION_REPLY, chatId, mutable = true)
            ).addRemoteInput(remoteInput).setAllowGeneratedReplies(true).build()
            b.addAction(replyAction)
            b.addAction(R.drawable.ic_notification, "Mark read", actionIntent(CallActionReceiver.ACTION_READ, chatId))
            b.addAction(R.drawable.ic_notification, "Silent", actionIntent(CallActionReceiver.ACTION_SILENT, chatId))
        }
        safeNotify(if (chatId.isNotBlank()) chatId.hashCode() else idCounter++, b.build())
    }

    // A call we couldn't ring for (Do-Not-Disturb) → leave a missed-call note.
    fun missedCall(name: String, room: String) {
        val b = NotificationCompat.Builder(context, CHANNEL_CALLS)
            .setSmallIcon(R.drawable.ic_notification)
            .setContentTitle("Missed call")
            .setContentText(name.ifBlank { "Someone" } + " tried to call you")
            .setAutoCancel(true)
            .setPriority(NotificationCompat.PRIORITY_HIGH)
            .setContentIntent(openAppIntent(room))
        safeNotify(("missed" + room).hashCode(), b.build())
    }

    // Friend request — Accept / Decline directly from the notification.
    fun friendRequest(login: String, name: String) {
        val b = NotificationCompat.Builder(context, CHANNEL_SOCIAL)
            .setSmallIcon(R.drawable.ic_notification)
            .setContentTitle("Friend request")
            .setContentText("$name wants to add you")
            .setAutoCancel(true)
            .setPriority(NotificationCompat.PRIORITY_HIGH)
            .setContentIntent(openAppIntent(""))
            .addAction(R.drawable.ic_notification, "Accept", actionIntent(CallActionReceiver.ACTION_FRIEND_ACCEPT, login))
            .addAction(R.drawable.ic_notification, "Decline", actionIntent(CallActionReceiver.ACTION_FRIEND_DECLINE, login))
        safeNotify(("fr" + login).hashCode(), b.build())
    }

    // Incoming call → a call notification with a FULL-SCREEN intent. Android shows the
    // full-screen IncomingCallActivity when the screen is locked/idle, and a heads-up
    // notification with Answer / Cancel when another app is in the foreground.
    fun showIncomingCall(room: String, name: String, isGroup: Boolean) {
        val fs = Intent(context, IncomingCallActivity::class.java).apply {
            addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
            putExtra(IncomingCallActivity.EXTRA_ROOM, room)
            putExtra(IncomingCallActivity.EXTRA_NAME, name)
            putExtra(IncomingCallActivity.EXTRA_GROUP, isGroup)
        }
        val fsPi = PendingIntent.getActivity(
            context, INCOMING_ID, fs,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
        )
        val b = NotificationCompat.Builder(context, CHANNEL_CALLS)
            .setSmallIcon(R.drawable.ic_notification)
            .setContentTitle(if (isGroup) "Incoming group call" else "Incoming call")
            .setContentText(name)
            .setPriority(NotificationCompat.PRIORITY_MAX)
            .setCategory(NotificationCompat.CATEGORY_CALL)
            .setOngoing(true)
            .setAutoCancel(false)
            .setFullScreenIntent(fsPi, true)
            .setContentIntent(fsPi)
            .addAction(R.drawable.ic_notification, "Answer Call", actionIntent(CallActionReceiver.ACTION_CALL_ANSWER, room))
            .addAction(R.drawable.ic_notification, "Cancel Call", actionIntent(CallActionReceiver.ACTION_CALL_DECLINE, room))
        safeNotify(INCOMING_ID, b.build())
    }

    fun cancelIncoming() { manager.cancel(INCOMING_ID) }

    // Ongoing "On a call" notification used by CallService (Mute / End actions).
    fun buildOngoingCall(title: String, sub: String): android.app.Notification {
        return NotificationCompat.Builder(context, CHANNEL_CALLS)
            .setSmallIcon(R.drawable.ic_notification)
            .setContentTitle(title.ifBlank { "On a call" })
            .setContentText(sub.ifBlank { "Tap to return to the call" })
            .setPriority(NotificationCompat.PRIORITY_LOW)
            .setCategory(NotificationCompat.CATEGORY_CALL)
            .setOngoing(true)
            .setContentIntent(openAppIntent(""))
            .addAction(R.drawable.ic_notification, "Mute", actionIntent(CallActionReceiver.ACTION_CALL_MUTE, ""))
            .addAction(R.drawable.ic_notification, "End", actionIntent(CallActionReceiver.ACTION_CALL_END, ""))
            .build()
    }

    // Ongoing, minimal "running in background" notification for ConnectionService.
    fun buildOngoingConnection(): android.app.Notification {
        return NotificationCompat.Builder(context, CHANNEL_BG)
            .setSmallIcon(R.drawable.ic_notification)
            .setContentTitle("Dialog")
            .setContentText("Staying connected for calls & messages")
            .setPriority(NotificationCompat.PRIORITY_MIN)
            .setOngoing(true)
            .setShowWhen(false)
            .setContentIntent(openAppIntent(""))
            .build()
    }

    fun cancel(id: Int) { manager.cancel(id) }

    private fun safeNotify(id: Int, notif: android.app.Notification) {
        try { manager.notify(id, notif) } catch (e: SecurityException) { /* POST_NOTIFICATIONS not granted */ }
    }
}

package xyz.dialogmsg.app

import com.google.firebase.messaging.FirebaseMessagingService
import com.google.firebase.messaging.RemoteMessage

/**
 * Receives Firebase Cloud Messaging pushes. The server sends DATA-ONLY messages (see
 * sendFcm in server.js) so this service always renders them itself — which works when the
 * app is backgrounded AND when it's been killed, unlike the WebView's socket.
 *
 * Tokens are handed to the web app (window.dialogFcmToken) which registers them with
 * POST /api/push/fcm.
 */
class FcmService : FirebaseMessagingService() {

    // New or rotated device token → hand it to the web layer to register server-side.
    override fun onNewToken(token: String) {
        pushTokenToWeb(token)
    }

    override fun onMessageReceived(msg: RemoteMessage) {
        val d = msg.data
        val kind = d["kind"] ?: "msg"
        val title = d["title"] ?: "Dialog"
        val body = d["body"] ?: ""
        val room = d["room"] ?: ""
        val n = NotificationHelper(this)
        when (kind) {
            // A call push while closed → full-screen incoming-call treatment.
            "call" -> n.showIncomingCall(room, title, room.startsWith("@grp:"))
            else -> n.show(title, body, room)
        }
    }

    companion object {
        /** Deliver a token to the page; safe no-op if the WebView isn't up yet. */
        fun pushTokenToWeb(token: String) {
            val safe = token.replace("\\", "").replace("'", "")
            MainActivity.evalJs("window.dialogFcmToken && window.dialogFcmToken('$safe')")
        }
    }
}

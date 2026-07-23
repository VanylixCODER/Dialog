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
        val icon = d["icon"] ?: ""
        // onMessageReceived runs on a background thread, so the short avatar fetch is fine here.
        val avatar = if (icon.isNotBlank()) fetchCircleBitmap(icon) else null
        val n = NotificationHelper(this)
        when (kind) {
            // A call push while closed → full-screen incoming-call treatment.
            "call" -> n.showIncomingCall(room, title, room.startsWith("@grp:"), avatar)
            else -> n.show(title, body, room, avatar)
        }
    }

    // Fetch the sender/caller avatar and clip it to a circle for the notification's large icon.
    // Best-effort: any failure just yields null and the notification shows without a picture.
    private fun fetchCircleBitmap(url: String): android.graphics.Bitmap? {
        return try {
            val conn = (java.net.URL(url).openConnection() as java.net.HttpURLConnection).apply {
                connectTimeout = 4000; readTimeout = 4000; instanceFollowRedirects = true
            }
            val bmp = conn.inputStream.use { android.graphics.BitmapFactory.decodeStream(it) } ?: return null
            val size = minOf(bmp.width, bmp.height)
            val sq = android.graphics.Bitmap.createBitmap(
                bmp, (bmp.width - size) / 2, (bmp.height - size) / 2, size, size
            )
            val out = android.graphics.Bitmap.createBitmap(size, size, android.graphics.Bitmap.Config.ARGB_8888)
            val canvas = android.graphics.Canvas(out)
            val paint = android.graphics.Paint(android.graphics.Paint.ANTI_ALIAS_FLAG).apply {
                shader = android.graphics.BitmapShader(sq, android.graphics.Shader.TileMode.CLAMP, android.graphics.Shader.TileMode.CLAMP)
            }
            canvas.drawCircle(size / 2f, size / 2f, size / 2f, paint)
            out
        } catch (e: Exception) { null }
    }

    companion object {
        /** Deliver a token to the page; safe no-op if the WebView isn't up yet. */
        fun pushTokenToWeb(token: String) {
            val safe = token.replace("\\", "").replace("'", "")
            MainActivity.evalJs("window.dialogFcmToken && window.dialogFcmToken('$safe')")
        }
    }
}

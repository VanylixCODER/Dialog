package xyz.dialogmsg.app

import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.Build
import android.os.IBinder

/**
 * Foreground service that runs for the duration of a call so the app process (and its
 * WebRTC/socket connection) stays alive when the user leaves the app. Shows an ongoing
 * "On a call" notification with Mute / End actions.
 */
class CallService : Service() {

    companion object {
        const val ACTION_START = "xyz.dialogmsg.app.CALL_START"
        const val ACTION_STOP = "xyz.dialogmsg.app.CALL_STOP"
        const val ONGOING_ID = 4002

        fun start(ctx: Context, title: String, sub: String) {
            val i = Intent(ctx, CallService::class.java).apply {
                action = ACTION_START
                putExtra("title", title); putExtra("sub", sub)
            }
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) ctx.startForegroundService(i) else ctx.startService(i)
        }

        fun stop(ctx: Context) {
            ctx.startService(Intent(ctx, CallService::class.java).apply { action = ACTION_STOP })
        }
    }

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        when (intent?.action) {
            ACTION_STOP -> { stopForegroundCompat(); stopSelf(); return START_NOT_STICKY }
            else -> {
                val title = intent?.getStringExtra("title") ?: "On a call"
                val sub = intent?.getStringExtra("sub") ?: ""
                val notif = NotificationHelper(this).buildOngoingCall(title, sub)
                try {
                    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
                        startForeground(
                            ONGOING_ID, notif,
                            ServiceInfo.FOREGROUND_SERVICE_TYPE_MICROPHONE or ServiceInfo.FOREGROUND_SERVICE_TYPE_CAMERA
                        )
                    } else {
                        startForeground(ONGOING_ID, notif)
                    }
                } catch (_: Exception) {
                    try { startForeground(ONGOING_ID, notif) } catch (_: Exception) {}
                }
            }
        }
        return START_STICKY
    }

    private fun stopForegroundCompat() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.N) stopForeground(STOP_FOREGROUND_REMOVE)
        else @Suppress("DEPRECATION") stopForeground(true)
    }

    override fun onDestroy() {
        RingController.stop(this)
        super.onDestroy()
    }
}

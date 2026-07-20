package xyz.dialogmsg.app

import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.Build
import android.os.IBinder
import android.os.PowerManager

/**
 * Foreground service that keeps the app PROCESS alive while the user is signed in, so the
 * WebView's Socket.IO connection stays live in the background and messages/calls keep
 * arriving (and raising native notifications) even when the app isn't on screen.
 *
 * The WebView lives in MainActivity's process; a foreground service in that same process
 * stops Android from freezing/killing it when backgrounded. A partial wake lock keeps the
 * socket alive through screen-off/Doze. This is the "run in background" mode — the web app
 * starts/stops it via Android.keepAlive(true/false), gated by a user preference.
 */
class ConnectionService : Service() {

    private var wakeLock: PowerManager.WakeLock? = null

    companion object {
        const val ACTION_START = "xyz.dialogmsg.app.CONN_START"
        const val ACTION_STOP = "xyz.dialogmsg.app.CONN_STOP"
        const val ONGOING_ID = 4003

        fun start(ctx: Context) {
            val i = Intent(ctx, ConnectionService::class.java).apply { action = ACTION_START }
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) ctx.startForegroundService(i) else ctx.startService(i)
        }

        fun stop(ctx: Context) {
            ctx.startService(Intent(ctx, ConnectionService::class.java).apply { action = ACTION_STOP })
        }
    }

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        if (intent?.action == ACTION_STOP) {
            releaseLock(); stopForegroundCompat(); stopSelf(); return START_NOT_STICKY
        }
        val notif = NotificationHelper(this).buildOngoingConnection()
        try {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
                startForeground(ONGOING_ID, notif, ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC)
            } else {
                startForeground(ONGOING_ID, notif)
            }
        } catch (_: Exception) {
            try { startForeground(ONGOING_ID, notif) } catch (_: Exception) {}
        }
        acquireLock()
        // START_STICKY: if the OS reclaims us under memory pressure, restart when it can.
        return START_STICKY
    }

    private fun acquireLock() {
        if (wakeLock?.isHeld == true) return
        try {
            val pm = getSystemService(Context.POWER_SERVICE) as PowerManager
            wakeLock = pm.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "dialog:connection").apply {
                setReferenceCounted(false)
                acquire()
            }
        } catch (_: Exception) {}
    }

    private fun releaseLock() {
        try { if (wakeLock?.isHeld == true) wakeLock?.release() } catch (_: Exception) {}
        wakeLock = null
    }

    private fun stopForegroundCompat() {
        try {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.N) stopForeground(STOP_FOREGROUND_REMOVE)
            else @Suppress("DEPRECATION") stopForeground(true)
        } catch (_: Exception) {}
    }

    override fun onDestroy() {
        releaseLock()
        super.onDestroy()
    }
}

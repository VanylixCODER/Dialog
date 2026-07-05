package xyz.dialogmsg.app

import android.app.NotificationManager
import android.content.Context
import android.media.AudioManager
import android.media.AudioAttributes
import android.media.Ringtone
import android.media.RingtoneManager
import android.os.Build
import android.os.VibrationEffect
import android.os.Vibrator
import android.os.VibratorManager

/**
 * Plays the incoming-call ringtone / vibration, honouring the phone's ringer mode:
 *   NORMAL  → ringtone + vibrate
 *   VIBRATE → buzz only (no ringtone)  ("no sound mode")
 *   SILENT  → nothing (screen still shows)
 *   DND     → handled by the caller: no ring/buzz, just a missed-call notification
 */
object RingController {
    enum class Mode { NORMAL, VIBRATE, SILENT, DND }

    private var ringtone: Ringtone? = null
    private var vibrator: Vibrator? = null

    fun classify(ctx: Context): Mode {
        // Do-Not-Disturb takes precedence (Marshmallow+).
        val nm = ctx.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M &&
            nm.currentInterruptionFilter != NotificationManager.INTERRUPTION_FILTER_ALL &&
            nm.currentInterruptionFilter != NotificationManager.INTERRUPTION_FILTER_UNKNOWN
        ) return Mode.DND

        val am = ctx.getSystemService(Context.AUDIO_SERVICE) as AudioManager
        return when (am.ringerMode) {
            AudioManager.RINGER_MODE_NORMAL -> Mode.NORMAL
            AudioManager.RINGER_MODE_VIBRATE -> Mode.VIBRATE
            else -> Mode.SILENT
        }
    }

    fun start(ctx: Context, mode: Mode) {
        stop(ctx)
        if (mode == Mode.NORMAL) startRingtone(ctx)
        if (mode == Mode.NORMAL || mode == Mode.VIBRATE) startVibrate(ctx)
    }

    private fun startRingtone(ctx: Context) {
        try {
            val uri = RingtoneManager.getActualDefaultRingtoneUri(ctx, RingtoneManager.TYPE_RINGTONE)
                ?: RingtoneManager.getDefaultUri(RingtoneManager.TYPE_RINGTONE)
            ringtone = RingtoneManager.getRingtone(ctx, uri)?.apply {
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.LOLLIPOP) {
                    audioAttributes = AudioAttributes.Builder()
                        .setUsage(AudioAttributes.USAGE_NOTIFICATION_RINGTONE)
                        .setContentType(AudioAttributes.CONTENT_TYPE_SONIFICATION)
                        .build()
                }
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) isLooping = true
                play()
            }
        } catch (_: Exception) {}
    }

    private fun startVibrate(ctx: Context) {
        try {
            val v = getVibrator(ctx) ?: return
            vibrator = v
            val pattern = longArrayOf(0, 700, 900) // wait, buzz, gap — repeat
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                v.vibrate(VibrationEffect.createWaveform(pattern, 0))
            } else {
                @Suppress("DEPRECATION") v.vibrate(pattern, 0)
            }
        } catch (_: Exception) {}
    }

    private fun getVibrator(ctx: Context): Vibrator? {
        return if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
            (ctx.getSystemService(Context.VIBRATOR_MANAGER_SERVICE) as? VibratorManager)?.defaultVibrator
        } else {
            @Suppress("DEPRECATION") ctx.getSystemService(Context.VIBRATOR_SERVICE) as? Vibrator
        }
    }

    fun stop(ctx: Context) {
        try { ringtone?.stop() } catch (_: Exception) {}
        ringtone = null
        try { vibrator?.cancel() } catch (_: Exception) {}
        vibrator = null
    }
}

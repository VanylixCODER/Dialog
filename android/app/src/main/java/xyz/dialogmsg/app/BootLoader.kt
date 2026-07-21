package xyz.dialogmsg.app

import android.animation.ValueAnimator
import android.content.res.ColorStateList
import android.os.Handler
import android.os.Looper
import xyz.dialogmsg.app.databinding.LoaderBinding

/**
 * Drives the branded splash: a breathing logo, a slim indeterminate progress bar, and a
 * status line under the wordmark. Status is set from real network/page events.
 */
class BootLoader(private val b: LoaderBinding) {

    enum class Status(val label: String, val color: Int) {
        CONNECTING("Connecting…", 0xFFFFB000.toInt()),
        AUTHENTICATING("Authenticating…", 0xFFFFB000.toInt()),
        ONLINE("Ready", 0xFF00FF5A.toInt()),
        OFFLINE("No internet — retrying…", 0xFFFF2D4B.toInt())
    }

    private var pulse: ValueAnimator? = null

    fun start() {
        // Gentle breathing pulse on the logo while loading.
        pulse?.cancel()
        pulse = ValueAnimator.ofFloat(0.55f, 1f).apply {
            duration = 950
            repeatMode = ValueAnimator.REVERSE
            repeatCount = ValueAnimator.INFINITE
            addUpdateListener {
                val v = it.animatedValue as Float
                b.logo.alpha = v
                val s = 0.95f + v * 0.05f
                b.logo.scaleX = s
                b.logo.scaleY = s
            }
            start()
        }
    }

    fun setStatus(s: Status) {
        b.statusText.text = s.label
        b.statusText.setTextColor(s.color)
        b.progress.indeterminateTintList = ColorStateList.valueOf(s.color)
        if (s == Status.ONLINE) {
            pulse?.cancel(); pulse = null
            b.logo.alpha = 1f; b.logo.scaleX = 1f; b.logo.scaleY = 1f
        }
    }
}

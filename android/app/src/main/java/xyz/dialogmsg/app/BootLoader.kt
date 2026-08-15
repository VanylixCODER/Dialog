package xyz.dialogmsg.app

import android.content.Context
import android.graphics.ImageDecoder
import android.graphics.drawable.AnimatedImageDrawable
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.text.Html
import android.view.View
import xyz.dialogmsg.app.databinding.LoaderBinding
import kotlin.math.floor
import kotlin.math.min
import kotlin.random.Random

/**
 * Terminal boot screen (design handoff: "Terminal Boot Loading Screen").
 *
 * One 42 ms tick drives everything: first it types the command a character at a time, then it
 * advances a jittered progress bar. The jitter is deliberate — perfectly even pacing reads as
 * fake. Log lines appear as progress crosses thresholds rather than animating in, the way real
 * console output behaves.
 *
 * Pace comes from the web app's Appearance setting, persisted in SharedPreferences so the
 * splash — which runs before the WebView exists — already knows it at launch.
 */
class BootLoader(private val b: LoaderBinding, private val ctx: Context) {

    enum class Status(val label: String, val color: Int) {
        CONNECTING("connecting to relay", 0xFF4fb96f.toInt()),
        AUTHENTICATING("authenticating session", 0xFF4fb96f.toInt()),
        ONLINE("session established", 0xFF28e05a.toInt()),
        OFFLINE("no route to host — retrying", 0xFFff6b6b.toInt())
    }

    private companion object {
        const val CMD = "dialog --boot --profile=mobile"
        const val CELLS = 22
        const val TICK_MS = 42L
        val BOOT = listOf(
            "[  OK  ]" to "mounted /dev/dialog",
            "[  OK  ]" to "started session daemon",
            "[  OK  ]" to "keyring unlocked",
            "[ INFO ]" to "resolving relay endpoints",
            "[  OK  ]" to "handshake tls1.3 · 41ms",
            "[ INFO ]" to "syncing messages",
            "[  OK  ]" to "cache warm",
            "[ INFO ]" to "restoring threads",
            "[  OK  ]" to "presence online"
        )
        val TAILS = listOf(
            "linking channels", "verifying signatures", "rebuilding index",
            "fetching avatars", "finalizing session"
        )
    }

    private val handler = Handler(Looper.getMainLooper())
    private var typed = 0
    private var pct = 0.0
    private var override: String? = null
    private var cursorOn = true
    private var running = false

    /** 1.0 = the designed cinematic pace (~5 s). The app writes this when the user changes it. */
    private val speed: Double
        get() = ctx.getSharedPreferences("dialog", Context.MODE_PRIVATE)
            .getFloat("boot_speed", 1f).toDouble().coerceIn(0.25, 6.0)

    private val tick = object : Runnable {
        override fun run() {
            if (!running) return
            if (typed < CMD.length) typed++
            else if (pct < 100.0) pct = min(100.0, pct + speed * (0.55 + Random.nextDouble() * 1.1))
            render()
            handler.postDelayed(this, TICK_MS)
        }
    }

    // The cursor is a separate, slower beat: 1.05 s, step-end — on for half, off for half.
    private val blink = object : Runnable {
        override fun run() {
            if (!running) return
            cursorOn = !cursorOn
            b.cursor.visibility = if (cursorOn) View.VISIBLE else View.INVISIBLE
            handler.postDelayed(this, 525)
        }
    }

    fun start() {
        running = true
        loadLogo()
        render()
        handler.post(tick)
        handler.postDelayed(blink, 525)
    }

    fun stop() {
        running = false
        handler.removeCallbacks(tick)
        handler.removeCallbacks(blink)
    }

    fun setStatus(s: Status) {
        override = s.label
        b.statusText.setTextColor(s.color)
        // A finished session should not sit at 61% while the app is already up.
        if (s == Status.ONLINE) pct = 100.0
        render()
    }

    /** The animated logo: ImageDecoder on API 28+, a still frame below it. */
    private fun loadLogo() {
        try {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
                val src = ImageDecoder.createSource(ctx.resources, R.drawable.boot_logo)
                val d = ImageDecoder.decodeDrawable(src)
                b.logo.setImageDrawable(d)
                (d as? AnimatedImageDrawable)?.start()
            } else {
                b.logo.setImageResource(R.drawable.boot_logo)
            }
        } catch (_: Throwable) {
            b.logo.setImageResource(R.drawable.dialog_logo)
        }
    }

    private fun render() {
        val p = floor(pct).toInt()

        b.promptLine.text = html(
            "<font color='#3aa85c'>root@dialog</font> <font color='#1f6b3a'>:~#</font> " +
                "<font color='#7cf59c'>" + esc(CMD.take(typed)) + "</font>"
        )

        // Lines appear as progress crosses thresholds; the last lands just before 100%.
        val shown = min(BOOT.size, floor(pct / 100.0 * (BOOT.size + 0.6)).toInt())
        b.bootLog.text = html(BOOT.take(shown).joinToString("<br>") { (tag, text) ->
            val c = if (tag.contains("OK")) "#28e05a" else "#1f6b3a"
            "<font color='$c'>" + esc(tag) + "</font>&#160;<font color='#4fb96f'>" + esc(text) + "</font>"
        })

        val filled = (pct / 100.0 * CELLS).toInt()
        b.bar.text = "[" + "█".repeat(filled) + "░".repeat(CELLS - filled) + "]"
        b.statusText.text =
            if (p >= 100) "100%  ready" else p.toString().padStart(3, ' ') + "%  loading dialog"
        b.stripPct.text = min(99, 84 + p / 8).toString() + "%"

        val tail = override
            ?: if (p >= 100) "session established" else TAILS[min(TAILS.size - 1, p / 20)] + "…"
        b.tailLine.text = html(
            "<font color='#1f6b3a'>--&gt;</font>&#160;<font color='#4fb96f'>" + esc(tail) + "</font>"
        )
    }

    private fun esc(s: String) = s.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")
        .replace(" ", "&#160;")   // console spacing is significant; keep it from collapsing

    @Suppress("DEPRECATION")
    private fun html(s: String) =
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.N) Html.fromHtml(s, Html.FROM_HTML_MODE_LEGACY)
        else Html.fromHtml(s)
}

package xyz.dialogmsg.app

import android.os.Handler
import android.os.Looper
import xyz.dialogmsg.app.databinding.LoaderBinding

/**
 * Drives the "hacker boot" overlay: an animated terminal log plus a live status
 * line under the logo. Status is set from real network/page events.
 */
class BootLoader(private val b: LoaderBinding) {

    enum class Status(val label: String, val color: Int) {
        CONNECTING("CONNECTING…", 0xFFFFB000.toInt()),
        AUTHENTICATING("AUTHENTICATING", 0xFFFFB000.toInt()),
        ONLINE("ONLINE", 0xFF00FF5A.toInt()),
        OFFLINE("NO INTERNET ACCESS", 0xFFFF2D4B.toInt())
    }

    private val main = Handler(Looper.getMainLooper())
    private val lines = StringBuilder()
    private var i = 0
    private var booting = false
    private var status = Status.CONNECTING

    private val script = listOf(
        "[ DIALOG SECURE SHELL v1.0.0 ]",
        "booting kernel modules ............ OK",
        "mounting encrypted volume /dev/dlg0  OK",
        "initializing crypto core (aes-256) . OK",
        "loading certificate chain ......... OK",
        "probing network interfaces ........ OK",
        "resolving relay @ dialogmsg.xyz ... OK",
        "establishing relay tunnel ......... OK",
        "performing TLS handshake .......... OK",
        "negotiating realtime socket ....... OK",
        "authenticating session token ...... OK",
        "syncing presence + channels ....... OK",
        "spawning interface ................ READY"
    )

    fun start() {
        booting = true
        i = 0
        lines.setLength(0)
        step()
        blinkCaret()
    }

    private fun step() {
        if (!booting || i >= script.size) return
        if (status == Status.OFFLINE) {
            // Pause the sequence while offline and surface a retry line.
            appendLine("network unreachable — retrying")
            main.postDelayed({ step() }, 1400)
            return
        }
        appendLine(script[i])
        b.progress.progress = ((i + 1) * 100 / script.size)
        i++
        main.postDelayed({ step() }, 230)
    }

    private fun appendLine(text: String) {
        if (lines.isNotEmpty()) lines.append("\n")
        lines.append(text)
        // keep the visible buffer bounded
        val all = lines.toString().split("\n")
        val trimmed = if (all.size > 40) all.takeLast(40).joinToString("\n") else lines.toString()
        b.log.text = trimmed
    }

    private fun blinkCaret() {
        var on = true
        val r = object : Runnable {
            override fun run() {
                b.caret.alpha = if (on) 1f else 0f
                on = !on
                main.postDelayed(this, 500)
            }
        }
        main.post(r)
    }

    fun setStatus(s: Status) {
        status = s
        b.statusText.text = s.label
        b.statusText.setTextColor(s.color)
        b.statusDot.setTextColor(s.color)
        if (s == Status.ONLINE) {
            b.progress.progress = 100
            appendLine("interface ready — welcome to Dialog")
            booting = false
        }
    }
}

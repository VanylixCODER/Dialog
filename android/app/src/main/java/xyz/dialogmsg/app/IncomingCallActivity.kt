package xyz.dialogmsg.app

import android.app.Activity
import android.app.KeyguardManager
import android.content.Context
import android.content.Intent
import android.graphics.Color
import android.graphics.drawable.GradientDrawable
import android.os.Build
import android.os.Bundle
import android.view.Gravity
import android.view.View
import android.view.ViewGroup
import android.view.WindowManager
import android.widget.Button
import android.widget.LinearLayout
import android.widget.TextView
import androidx.core.app.NotificationManagerCompat
import java.lang.ref.WeakReference

/**
 * Full-screen incoming-call screen that shows over the lock screen (Telegram-style).
 * Three actions drive the web app back through MainActivity.evalJs():
 *   Answer         → window.__dialogCall.answer()   + bring the app forward
 *   Decline        → window.__dialogCall.decline()
 *   Decline + DND  → window.__dialogCall.declineDnd()
 */
class IncomingCallActivity : Activity() {

    companion object {
        const val EXTRA_ROOM = "room"
        const val EXTRA_NAME = "name"
        const val EXTRA_LOGIN = "login"
        const val EXTRA_TITLE = "title"
        const val EXTRA_GROUP = "group"
        private var current: WeakReference<IncomingCallActivity>? = null
        // Called when the call is answered elsewhere / cancelled.
        fun dismiss(ctx: Context) { current?.get()?.let { runCatching { it.finish() } } }
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        current = WeakReference(this)
        showOverLockScreen()

        val name = intent.getStringExtra(EXTRA_NAME) ?: "Incoming call"
        val isGroup = intent.getBooleanExtra(EXTRA_GROUP, false)

        val root = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            gravity = Gravity.CENTER_HORIZONTAL
            setBackgroundColor(Color.parseColor("#050b06"))
            setPadding(dp(28), dp(72), dp(28), dp(48))
        }

        val caller = TextView(this).apply {
            text = name
            setTextColor(Color.WHITE)
            textSize = 30f
            gravity = Gravity.CENTER
        }
        val sub = TextView(this).apply {
            text = if (isGroup) "Incoming group call" else "Incoming call"
            setTextColor(Color.parseColor("#88ffaa"))
            textSize = 15f
            gravity = Gravity.CENTER
            setPadding(0, dp(8), 0, 0)
        }
        val brand = TextView(this).apply {
            text = "DIALOG"
            setTextColor(Color.parseColor("#3a5a48"))
            textSize = 13f
            letterSpacing = 0.3f
            gravity = Gravity.CENTER
            setPadding(0, dp(10), 0, dp(40))
        }

        val spacer = View(this).apply { layoutParams = LinearLayout.LayoutParams(0, 0, 1f) }

        val buttons = LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = Gravity.CENTER
        }
        buttons.addView(actionButton("Decline", "#ff5252") { onDecline() })
        buttons.addView(actionButton("Answer", "#2ec96b") { onAnswer() })

        val dnd = actionButton("Decline & Do Not Disturb", "#1a2a20") { onDeclineDnd() }.apply {
            setTextColor(Color.parseColor("#cfe6d8"))
            val lp = LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, dp(52))
            lp.topMargin = dp(16); lp.leftMargin = dp(8); lp.rightMargin = dp(8)
            layoutParams = lp
        }

        root.addView(brand)
        root.addView(spacer)
        root.addView(caller)
        root.addView(sub)
        val spacer2 = View(this).apply { layoutParams = LinearLayout.LayoutParams(0, 0, 1f) }
        root.addView(spacer2)
        root.addView(buttons)
        root.addView(dnd)
        setContentView(root)
    }

    private fun actionButton(label: String, colorHex: String, onClick: () -> Unit): Button {
        val b = Button(this)
        b.text = label
        b.isAllCaps = false
        b.textSize = 15f
        b.setTextColor(Color.WHITE)
        val bg = GradientDrawable().apply {
            cornerRadius = dp(28).toFloat()
            setColor(Color.parseColor(colorHex))
        }
        b.background = bg
        val lp = LinearLayout.LayoutParams(0, dp(56), 1f)
        lp.leftMargin = dp(8); lp.rightMargin = dp(8)
        b.layoutParams = lp
        b.setOnClickListener { onClick() }
        return b
    }

    private fun clearNotif() {
        runCatching { NotificationManagerCompat.from(this).cancel(NotificationHelper.INCOMING_ID) }
    }

    private fun onAnswer() {
        RingController.stop(this)
        clearNotif()
        MainActivity.evalJs("window.__dialogCall && window.__dialogCall.answer()")
        // Bring the chat app to the front so the user lands in the call.
        runCatching {
            startActivity(Intent(this, MainActivity::class.java).apply {
                addFlags(Intent.FLAG_ACTIVITY_REORDER_TO_FRONT or Intent.FLAG_ACTIVITY_SINGLE_TOP)
            })
        }
        finish()
    }

    private fun onDecline() {
        RingController.stop(this)
        clearNotif()
        MainActivity.evalJs("window.__dialogCall && window.__dialogCall.decline()")
        finish()
    }

    private fun onDeclineDnd() {
        RingController.stop(this)
        clearNotif()
        MainActivity.evalJs("window.__dialogCall && window.__dialogCall.declineDnd()")
        finish()
    }

    override fun onDestroy() {
        RingController.stop(this)
        super.onDestroy()
    }

    private fun showOverLockScreen() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O_MR1) {
            setShowWhenLocked(true)
            setTurnScreenOn(true)
            (getSystemService(Context.KEYGUARD_SERVICE) as? KeyguardManager)?.requestDismissKeyguard(this, null)
        } else {
            @Suppress("DEPRECATION")
            window.addFlags(
                WindowManager.LayoutParams.FLAG_SHOW_WHEN_LOCKED or
                    WindowManager.LayoutParams.FLAG_TURN_SCREEN_ON or
                    WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON
            )
        }
    }

    private fun dp(v: Int): Int = (v * resources.displayMetrics.density).toInt()
}

package xyz.dialogmsg.app

import android.webkit.JavascriptInterface

/**
 * Bridge exposed to the web app as `window.Android`.
 *  - Android.ready()                 → dismiss the boot loader
 *  - Android.notify(title, body, id) → render a native notification
 */
class WebAppInterface(
    private val onReady: () -> Unit,
    private val notifications: NotificationHelper
) {
    @JavascriptInterface
    fun ready() {
        onReady()
    }

    @JavascriptInterface
    fun notify(title: String, body: String, chatId: String) {
        notifications.show(title, body, chatId)
    }
}

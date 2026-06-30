package xyz.dialogmsg.app

import android.graphics.Bitmap
import android.webkit.WebResourceError
import android.webkit.WebResourceRequest
import android.webkit.WebView
import android.webkit.WebViewClient

/**
 * Keeps navigation inside the Dialog origin in the WebView and forwards
 * lifecycle/error events to MainActivity to drive the boot loader status.
 */
class DialogWebViewClient(
    private val onPageStarted: () -> Unit,
    private val onPageFinished: () -> Unit,
    private val onError: () -> Unit
) : WebViewClient() {

    private val appHost = "dialogmsg.xyz"

    override fun shouldOverrideUrlLoading(
        view: WebView,
        request: WebResourceRequest
    ): Boolean {
        val host = request.url.host ?: return false
        // Same-origin (and its subdomains) load in the WebView; everything else
        // opens in the system browser.
        if (host == appHost || host.endsWith(".$appHost")) return false
        return try {
            val intent = android.content.Intent(
                android.content.Intent.ACTION_VIEW, request.url
            )
            view.context.startActivity(intent)
            true
        } catch (e: Exception) {
            false
        }
    }

    override fun onPageStarted(view: WebView, url: String?, favicon: Bitmap?) {
        onPageStarted()
    }

    override fun onPageFinished(view: WebView, url: String?) {
        onPageFinished()
    }

    override fun onReceivedError(
        view: WebView,
        request: WebResourceRequest,
        error: WebResourceError
    ) {
        // Only react to main-frame failures.
        if (request.isForMainFrame) onError()
    }
}

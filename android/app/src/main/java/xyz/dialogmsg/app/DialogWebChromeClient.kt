package xyz.dialogmsg.app

import android.app.Activity
import android.content.Intent
import android.net.Uri
import android.webkit.PermissionRequest
import android.webkit.ValueCallback
import android.webkit.WebChromeClient
import android.webkit.WebView
import androidx.activity.result.ActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.appcompat.app.AppCompatActivity

/**
 * Auto-grants web permission requests (mic, camera, screen capture, MIDI...)
 * so the in-page browser prompt never appears. The OS-level runtime permission
 * for mic/camera is requested up front in MainActivity; Android's mandatory
 * screen-capture consent dialog (for getDisplayMedia) is enforced by the system
 * and cannot be suppressed.
 */
class DialogWebChromeClient(activity: AppCompatActivity) : WebChromeClient() {

    private var filePathCallback: ValueCallback<Array<Uri>>? = null

    private val fileChooserLauncher = activity.registerForActivityResult(
        ActivityResultContracts.StartActivityForResult()
    ) { result: ActivityResult ->
        val uris = parseFileChooserResult(result)
        filePathCallback?.onReceiveValue(uris)
        filePathCallback = null
    }

    override fun onPermissionRequest(request: PermissionRequest) {
        // Grant everything the page asks for, including
        // RESOURCE_AUDIO_CAPTURE, RESOURCE_VIDEO_CAPTURE, RESOURCE_MIDI_SYSEX.
        request.grant(request.resources)
    }

    override fun onShowFileChooser(
        webView: WebView,
        callback: ValueCallback<Array<Uri>>,
        params: FileChooserParams
    ): Boolean {
        filePathCallback?.onReceiveValue(null)
        filePathCallback = callback
        return try {
            val intent = params.createIntent()
            fileChooserLauncher.launch(intent)
            true
        } catch (e: Exception) {
            filePathCallback = null
            false
        }
    }

    private fun parseFileChooserResult(result: ActivityResult): Array<Uri>? {
        if (result.resultCode != Activity.RESULT_OK) return null
        val data: Intent = result.data ?: return null
        data.clipData?.let { clip ->
            return Array(clip.itemCount) { clip.getItemAt(it).uri }
        }
        data.data?.let { return arrayOf(it) }
        return null
    }
}

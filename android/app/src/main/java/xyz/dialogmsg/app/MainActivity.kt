package xyz.dialogmsg.app

import android.Manifest
import android.animation.ObjectAnimator
import android.annotation.SuppressLint
import android.content.pm.PackageManager
import android.net.ConnectivityManager
import android.net.Network
import android.net.NetworkCapabilities
import android.net.NetworkRequest
import android.os.Build
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.view.View
import android.webkit.WebView
import androidx.activity.result.contract.ActivityResultContracts
import androidx.appcompat.app.AppCompatActivity
import androidx.core.content.ContextCompat
import xyz.dialogmsg.app.databinding.ActivityMainBinding

class MainActivity : AppCompatActivity() {

    private lateinit var binding: ActivityMainBinding
    private lateinit var webView: WebView
    private lateinit var loader: BootLoader
    private lateinit var notifications: NotificationHelper

    private val main = Handler(Looper.getMainLooper())
    private var pageReady = false
    private var connected = true

    private val connectivityManager by lazy {
        getSystemService(ConnectivityManager::class.java)
    }

    // Up-front runtime permissions so calls work without the in-page web prompt.
    private val permissionLauncher =
        registerForActivityResult(
            ActivityResultContracts.RequestMultiplePermissions()
        ) { /* result ignored — WebChromeClient grants the web layer regardless */ }

    @SuppressLint("SetJavaScriptEnabled")
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        binding = ActivityMainBinding.inflate(layoutInflater)
        setContentView(binding.root)

        notifications = NotificationHelper(this)
        loader = BootLoader(binding.loader)

        webView = binding.webview
        configureWebView()

        requestStartupPermissions()
        registerConnectivityCallback()

        loader.start()
        loader.setStatus(BootLoader.Status.CONNECTING)

        if (isOnline()) {
            webView.loadUrl(BuildConfig.APP_URL)
        } else {
            loader.setStatus(BootLoader.Status.OFFLINE)
            scheduleReload()
        }
    }

    @SuppressLint("SetJavaScriptEnabled")
    private fun configureWebView() {
        webView.settings.apply {
            javaScriptEnabled = true
            domStorageEnabled = true
            databaseEnabled = true
            mediaPlaybackRequiresUserGesture = false
            allowFileAccess = true
            allowContentAccess = true
            cacheMode = android.webkit.WebSettings.LOAD_DEFAULT
            userAgentString = userAgentString + " DialogApp/1.0.0"
            javaScriptCanOpenWindowsAutomatically = true
            setSupportMultipleWindows(false)
        }

        if (BuildConfig.DEBUG) {
            WebView.setWebContentsDebuggingEnabled(true)
        }

        // JS bridge: page can call Android.notify(...) / Android.ready() etc.
        webView.addJavascriptInterface(
            WebAppInterface(
                onReady = { runOnUiThread { onPageReady() } },
                notifications = notifications
            ),
            "Android"
        )

        webView.webChromeClient = DialogWebChromeClient(this)
        webView.webViewClient = DialogWebViewClient(
            onPageStarted = {
                if (connected) loader.setStatus(BootLoader.Status.CONNECTING)
            },
            onPageFinished = {
                loader.setStatus(BootLoader.Status.AUTHENTICATING)
                injectNotificationShim()
                // Fallback reveal if the page never calls Android.ready().
                main.postDelayed({ if (!pageReady) onPageReady() }, 4000)
            },
            onError = {
                loader.setStatus(BootLoader.Status.OFFLINE)
                scheduleReload()
            }
        )
    }

    // Maps the web Notification API to the native bridge so messages surface as
    // real Android notifications while the app is running.
    private fun injectNotificationShim() {
        val js = """
            (function(){
              if (window.__dialogShim) return; window.__dialogShim = true;
              try {
                var N = window.Notification;
                function Wrapped(title, opts){
                  opts = opts || {};
                  var chatId = (opts.data && opts.data.chatId) || '';
                  try { Android.notify(String(title||'Dialog'), String(opts.body||''), String(chatId)); } catch(e){}
                  return new N(title, opts);
                }
                Wrapped.requestPermission = function(cb){ var p = Promise.resolve('granted'); if (cb) cb('granted'); return p; };
                Object.defineProperty(Wrapped, 'permission', { get: function(){ return 'granted'; } });
                window.Notification = Wrapped;
              } catch(e){}
              try { Android.ready(); } catch(e){}
            })();
        """.trimIndent()
        webView.evaluateJavascript(js, null)
    }

    private fun onPageReady() {
        if (pageReady) return
        pageReady = true
        loader.setStatus(BootLoader.Status.ONLINE)
        main.postDelayed({ fadeOutLoader() }, 700)
    }

    private fun fadeOutLoader() {
        val v: View = binding.loader.root
        ObjectAnimator.ofFloat(v, "alpha", 1f, 0f).apply {
            duration = 700
            start()
        }
        main.postDelayed({ v.visibility = View.GONE }, 720)
    }

    // ---- Permissions ----
    private fun requestStartupPermissions() {
        val needed = mutableListOf(Manifest.permission.RECORD_AUDIO, Manifest.permission.CAMERA)
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            needed.add(Manifest.permission.POST_NOTIFICATIONS)
        }
        val toAsk = needed.filter {
            ContextCompat.checkSelfPermission(this, it) != PackageManager.PERMISSION_GRANTED
        }
        if (toAsk.isNotEmpty()) permissionLauncher.launch(toAsk.toTypedArray())
    }

    // ---- Connectivity ----
    private fun isOnline(): Boolean {
        val n = connectivityManager?.activeNetwork ?: return false
        val caps = connectivityManager?.getNetworkCapabilities(n) ?: return false
        return caps.hasCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET)
    }

    private fun registerConnectivityCallback() {
        val req = NetworkRequest.Builder()
            .addCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET)
            .build()
        connectivityManager?.registerNetworkCallback(req, object :
            ConnectivityManager.NetworkCallback() {
            override fun onAvailable(network: Network) {
                connected = true
                if (!pageReady) main.post {
                    loader.setStatus(BootLoader.Status.CONNECTING)
                    webView.loadUrl(BuildConfig.APP_URL)
                }
            }

            override fun onLost(network: Network) {
                connected = false
                if (!pageReady) main.post { loader.setStatus(BootLoader.Status.OFFLINE) }
            }
        })
    }

    private fun scheduleReload() {
        main.postDelayed({
            if (!pageReady && isOnline()) {
                loader.setStatus(BootLoader.Status.CONNECTING)
                webView.loadUrl(BuildConfig.APP_URL)
            } else if (!pageReady) {
                scheduleReload()
            }
        }, 3000)
    }

    override fun onBackPressed() {
        if (webView.canGoBack()) webView.goBack() else super.onBackPressed()
    }

    override fun onDestroy() {
        webView.destroy()
        super.onDestroy()
    }
}

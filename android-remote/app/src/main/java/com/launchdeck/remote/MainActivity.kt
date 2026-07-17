package com.launchdeck.remote

import android.annotation.SuppressLint
import android.graphics.Color
import android.graphics.Typeface
import android.os.Bundle
import android.util.TypedValue
import android.webkit.ConsoleMessage
import android.webkit.WebChromeClient
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.Button
import android.widget.LinearLayout
import android.widget.ScrollView
import android.widget.TextView
import androidx.appcompat.app.AppCompatActivity
import androidx.webkit.WebViewAssetLoader
import org.json.JSONObject
import java.io.File

/**
 * Launch Deck Remote v2 — native shell.
 *
 * The entire visible UI is the Launch Deck web bundle rendered in this
 * WebView; the Moonlight engine underneath is driven headlessly by
 * [StreamOrchestrator] and only ever surfaces as the fullscreen game video.
 *
 * Boot is deliberately minimal (just the WebView); the engine service is
 * bound lazily on the first stream request. If anything ever crashes, the
 * trace recorded by [RemoteApp] is displayed on the next launch.
 */
class MainActivity : AppCompatActivity() {

    lateinit var webView: WebView
        private set
    private var orchestrator: StreamOrchestrator? = null

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        try {
            val crashFile = File(filesDir, RemoteApp.CRASH_FILE)
            if (crashFile.exists()) {
                showCrashReport(crashFile)
                return
            }
            bootWebUi()
        } catch (e: Throwable) {
            android.util.Log.e("LDRemote", "boot failed", e)
            showFatal(android.util.Log.getStackTraceString(e))
        }
    }

    /** Lazily create the engine driver (binds the Moonlight service). UI thread only. */
    fun orchestrator(): StreamOrchestrator {
        return orchestrator ?: StreamOrchestrator(this).also { orchestrator = it }
    }

    @SuppressLint("SetJavaScriptEnabled")
    private fun bootWebUi() {
        android.util.Log.i("LDRemote", "boot: creating WebView")
        webView = WebView(this)
        setContentView(webView)

        webView.settings.apply {
            javaScriptEnabled = true
            domStorageEnabled = true
            mediaPlaybackRequiresUserGesture = false
        }

        val assetLoader = WebViewAssetLoader.Builder()
            .addPathHandler("/assets/", WebViewAssetLoader.AssetsPathHandler(this))
            .build()

        webView.webViewClient = object : WebViewClient() {
            override fun shouldInterceptRequest(
                view: WebView,
                request: WebResourceRequest,
            ): WebResourceResponse? = assetLoader.shouldInterceptRequest(request.url)
        }
        webView.webChromeClient = object : WebChromeClient() {
            override fun onConsoleMessage(message: ConsoleMessage): Boolean {
                android.util.Log.d(
                    "LDRemoteWeb",
                    "${message.messageLevel()} ${message.message()} @${message.sourceId()}:${message.lineNumber()}",
                )
                return true
            }
        }

        webView.addJavascriptInterface(NativeBridge(this), "LaunchDeckNative")

        android.util.Log.i("LDRemote", "boot: loading web bundle")
        webView.loadUrl("https://appassets.androidplatform.net/assets/www/index.html")
    }

    /** Dispatch an event object into the web UI (always on the UI thread). */
    fun emitToWeb(type: String, payload: JSONObject = JSONObject()) {
        payload.put("type", type)
        val js = "window.dispatchEvent(new CustomEvent('ld-native', { detail: $payload }))"
        runOnUiThread { webView.evaluateJavascript(js, null) }
    }

    private fun showCrashReport(crashFile: File) {
        val text = try { crashFile.readText() } catch (e: Exception) { "unreadable: $e" }
        android.util.Log.e("LDRemote", "previous crash:\n$text")
        showFatal(text) {
            crashFile.delete()
            try {
                bootWebUi()
            } catch (e: Throwable) {
                showFatal(android.util.Log.getStackTraceString(e))
            }
        }
    }

    /** Full-screen scrollable crash view — screenshot-friendly, no adb required. */
    private fun showFatal(trace: String, onContinue: (() -> Unit)? = null) {
        val pad = (12 * resources.displayMetrics.density).toInt()
        val root = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setBackgroundColor(Color.parseColor("#04060B"))
            setPadding(pad, pad * 2, pad, pad)
        }
        root.addView(TextView(this).apply {
            setTextColor(Color.parseColor("#FF5C7A"))
            setTypeface(Typeface.DEFAULT_BOLD)
            setTextSize(TypedValue.COMPLEX_UNIT_SP, 16f)
            text = "Launch Deck Remote hit a problem — please screenshot this screen"
        })
        if (onContinue != null) {
            root.addView(Button(this).apply {
                text = "Continue to app"
                setOnClickListener { onContinue() }
            })
        }
        root.addView(ScrollView(this).apply {
            addView(TextView(this@MainActivity).apply {
                setTextColor(Color.parseColor("#C9D4E5"))
                typeface = Typeface.MONOSPACE
                setTextSize(TypedValue.COMPLEX_UNIT_SP, 11f)
                setTextIsSelectable(true)
                text = trace
            })
        }, LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, 0, 1f))
        setContentView(root)
    }

    override fun onDestroy() {
        orchestrator?.shutdown()
        super.onDestroy()
    }
}

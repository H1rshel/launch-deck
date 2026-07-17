package com.launchdeck.remote

import android.annotation.SuppressLint
import android.os.Bundle
import android.webkit.ConsoleMessage
import android.webkit.WebChromeClient
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebView
import android.webkit.WebViewClient
import androidx.appcompat.app.AppCompatActivity
import androidx.webkit.WebViewAssetLoader
import org.json.JSONObject

/**
 * Launch Deck Remote v2 — native shell.
 *
 * The entire visible UI is the Launch Deck web bundle (console-mode styled)
 * rendered in this WebView; the Moonlight engine underneath is driven
 * headlessly by [StreamOrchestrator] and only ever surfaces as the
 * fullscreen game video.
 */
class MainActivity : AppCompatActivity() {

    lateinit var webView: WebView
        private set
    private lateinit var orchestrator: StreamOrchestrator

    @SuppressLint("SetJavaScriptEnabled")
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)

        orchestrator = StreamOrchestrator(this)

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

        webView.addJavascriptInterface(NativeBridge(this, orchestrator), "LaunchDeckNative")

        webView.loadUrl("https://appassets.androidplatform.net/assets/www/index.html")
    }

    /** Dispatch an event object into the web UI (always on the UI thread). */
    fun emitToWeb(type: String, payload: JSONObject = JSONObject()) {
        payload.put("type", type)
        val js = "window.dispatchEvent(new CustomEvent('ld-native', { detail: $payload }))"
        runOnUiThread { webView.evaluateJavascript(js, null) }
    }

    override fun onDestroy() {
        orchestrator.shutdown()
        super.onDestroy()
    }
}

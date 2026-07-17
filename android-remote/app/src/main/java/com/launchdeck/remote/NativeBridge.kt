package com.launchdeck.remote

import android.content.Intent
import android.net.Uri
import android.webkit.JavascriptInterface

/**
 * The entire native↔web contract. Deliberately tiny: everything else the
 * remote does (auth, library, command bus) is plain web code.
 */
class NativeBridge(
    private val activity: MainActivity,
) {

    private val updater by lazy { UpdateInstaller(activity) }

    /** Marker the web UI probes to detect the v2 native shell. */
    @JavascriptInterface
    fun shellVersion(): String = "2"

    /** The installed APK version (e.g. "2.1.2") for update checks. */
    @JavascriptInterface
    fun appVersion(): String = BuildConfig.VERSION_NAME

    /**
     * Downloads the APK at `url` and opens the system installer.
     * Progress arrives as `update-progress` events; `update-ready` fires
     * when the installer opens, `update-error` on failure.
     */
    @JavascriptInterface
    fun installUpdate(url: String) {
        updater.install(url.trim())
    }

    /**
     * Streams `appName` from the host at `hostIp`. Fully headless: adds the
     * PC to the engine if unknown, pairs invisibly (PIN is emitted to the
     * web layer, which relays it to the host for auto-approval), resolves
     * the app, and launches the video activity.
     * Progress/errors arrive as `ld-native` window events.
     */
    @JavascriptInterface
    fun startStream(hostIp: String, appName: String) {
        // Called from the WebView's JS thread; the orchestrator (and its
        // service binding) must be created on the UI thread.
        activity.runOnUiThread {
            activity.orchestrator().startStream(hostIp.trim(), appName.trim())
        }
    }

    /**
     * Registers + pairs the host ahead of a stream so the eventual tap is
     * near-instant. Idempotent; safe to call whenever an online host is known.
     */
    @JavascriptInterface
    fun prewarm(hostIp: String) {
        activity.runOnUiThread { activity.orchestrator().prewarm(hostIp.trim()) }
    }

    /** Cancels an in-flight startStream (best effort). */
    @JavascriptInterface
    fun cancelStream() {
        activity.runOnUiThread { activity.orchestrator().cancel() }
    }

    @JavascriptInterface
    fun openUrl(url: String) {
        try {
            activity.startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(url)))
        } catch (_: Exception) {
            // No handler for the URL — ignore
        }
    }
}

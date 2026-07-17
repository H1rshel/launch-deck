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
    private val orchestrator: StreamOrchestrator,
) {

    /** Marker the web UI probes to detect the v2 native shell. */
    @JavascriptInterface
    fun shellVersion(): String = "2"

    /**
     * Streams `appName` from the host at `hostIp`. Fully headless: adds the
     * PC to the engine if unknown, pairs invisibly (PIN is emitted to the
     * web layer, which relays it to the host for auto-approval), resolves
     * the app, and launches the video activity.
     * Progress/errors arrive as `ld-native` window events.
     */
    @JavascriptInterface
    fun startStream(hostIp: String, appName: String) {
        orchestrator.startStream(hostIp.trim(), appName.trim())
    }

    /** Cancels an in-flight startStream (best effort). */
    @JavascriptInterface
    fun cancelStream() {
        orchestrator.cancel()
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

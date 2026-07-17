package com.launchdeck.remote

import android.content.Intent
import androidx.core.content.FileProvider
import org.json.JSONObject
import java.io.File
import java.net.HttpURLConnection
import java.net.URL

/**
 * In-app self-update: downloads a release APK and hands it to the system
 * package installer. Android still shows its own install confirmation (and,
 * the first time, an "allow installs from this app" prompt) — that's the
 * platform's requirement for sideloaded apps, not something we can skip.
 */
class UpdateInstaller(private val activity: MainActivity) {

    @Volatile private var running = false

    fun install(url: String) {
        if (running) return
        running = true
        Thread {
            try {
                val file = File(activity.cacheDir, "launch-deck-remote-update.apk")
                download(url, file)
                val uri = FileProvider.getUriForFile(
                    activity,
                    "com.launchdeck.remote.fileprovider",
                    file,
                )
                activity.emitToWeb("update-ready")
                val intent = Intent(Intent.ACTION_VIEW).apply {
                    setDataAndType(uri, "application/vnd.android.package-archive")
                    addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_ACTIVITY_NEW_TASK)
                }
                activity.startActivity(intent)
            } catch (e: Exception) {
                activity.emitToWeb(
                    "update-error",
                    JSONObject().put("message", (e.message ?: e.toString()).take(140)),
                )
            } finally {
                running = false
            }
        }.start()
    }

    private fun download(url: String, dest: File) {
        var conn = URL(url).openConnection() as HttpURLConnection
        conn.connectTimeout = 15_000
        conn.readTimeout = 60_000
        // GitHub asset downloads redirect to object storage; follow manually
        // so cross-host hops are always handled.
        var redirects = 0
        while (conn.responseCode in 301..308 && redirects < 6) {
            val next = conn.getHeaderField("Location") ?: break
            conn.disconnect()
            conn = URL(next).openConnection() as HttpURLConnection
            conn.connectTimeout = 15_000
            conn.readTimeout = 60_000
            redirects++
        }
        if (conn.responseCode != 200) {
            throw IllegalStateException("Download failed (HTTP ${conn.responseCode})")
        }
        val total = conn.contentLength.toLong()
        conn.inputStream.use { input ->
            dest.outputStream().use { out ->
                val buf = ByteArray(64 * 1024)
                var done = 0L
                var lastPct = -1
                while (true) {
                    val n = input.read(buf)
                    if (n < 0) break
                    out.write(buf, 0, n)
                    done += n
                    if (total > 0) {
                        val pct = (done * 100 / total).toInt()
                        if (pct >= lastPct + 4) {
                            lastPct = pct
                            activity.emitToWeb("update-progress", JSONObject().put("pct", pct))
                        }
                    }
                }
            }
        }
    }
}

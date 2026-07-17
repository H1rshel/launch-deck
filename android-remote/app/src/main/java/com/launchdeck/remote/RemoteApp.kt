package com.launchdeck.remote

import android.app.Application
import android.content.Context
import java.io.File

/**
 * Installs a first-thing crash recorder: any uncaught exception (in the main
 * process or the :moonlight engine process) is written to [CRASH_FILE] before
 * the process dies. MainActivity shows the recorded trace on the next launch,
 * so crashes are diagnosable straight from the device with no adb.
 */
class RemoteApp : Application() {

    override fun attachBaseContext(base: Context) {
        super.attachBaseContext(base)
        val previous = Thread.getDefaultUncaughtExceptionHandler()
        Thread.setDefaultUncaughtExceptionHandler { thread, e ->
            try {
                val proc = try { getProcessName() } catch (_: Throwable) { "?" }
                File(base.filesDir, CRASH_FILE).writeText(
                    "Launch Deck Remote ${BuildConfig.VERSION_NAME} — uncaught crash\n" +
                        "process: $proc   thread: ${thread.name}\n" +
                        "time: ${java.util.Date()}\n\n" +
                        android.util.Log.getStackTraceString(e),
                )
            } catch (_: Throwable) {
                // Never let the recorder itself mask the crash
            }
            if (previous != null) previous.uncaughtException(thread, e)
            else Runtime.getRuntime().halt(1)
        }
    }

    companion object {
        const val CRASH_FILE = "last-crash.txt"
    }
}

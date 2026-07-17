package com.launchdeck.remote

import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.content.ServiceConnection
import android.os.IBinder
import com.limelight.binding.PlatformBinding
import com.limelight.computers.ComputerManagerService
import com.limelight.nvstream.http.ComputerDetails
import com.limelight.nvstream.http.NvApp
import com.limelight.nvstream.http.NvHTTP
import com.limelight.nvstream.http.PairingManager
import com.limelight.utils.ServerHelper
import org.json.JSONObject
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean

/**
 * Drives the Moonlight engine headlessly: add PC → pair (invisible PIN
 * relay) → resolve app → launch the video activity. The user only ever sees
 * Launch Deck UI and the game itself.
 */
class StreamOrchestrator(private val activity: MainActivity) {

    private val defaultHttpPort = 47989
    private var binder: ComputerManagerService.ComputerManagerBinder? = null
    private val binderLatch = CountDownLatch(1)
    private val cancelled = AtomicBoolean(false)
    @Volatile private var working = false

    private val serviceConnection = object : ServiceConnection {
        override fun onServiceConnected(name: ComponentName, service: IBinder) {
            val localBinder = service as ComputerManagerService.ComputerManagerBinder
            Thread {
                localBinder.waitForReady()
                binder = localBinder
                binderLatch.countDown()
            }.start()
        }

        override fun onServiceDisconnected(name: ComponentName) {
            binder = null
        }
    }

    init {
        activity.bindService(
            Intent(activity, ComputerManagerService::class.java),
            serviceConnection,
            Context.BIND_AUTO_CREATE,
        )
    }

    private fun emit(type: String, vararg pairs: Pair<String, String>) {
        val json = JSONObject()
        for ((k, v) in pairs) json.put(k, v)
        activity.emitToWeb(type, json)
    }

    fun cancel() {
        cancelled.set(true)
    }

    fun startStream(hostIp: String, appName: String) {
        if (working) {
            emit("stream-error", "message" to "A stream is already starting")
            return
        }
        working = true
        cancelled.set(false)
        Thread {
            try {
                runFlow(hostIp, appName)
            } catch (e: InterruptedException) {
                emit("stream-error", "message" to "Cancelled")
            } catch (e: Exception) {
                emit("stream-error", "message" to (e.message ?: e.toString()).take(160))
            } finally {
                working = false
            }
        }.start()
    }

    private fun runFlow(hostIp: String, appName: String) {
        emit("stream-status", "step" to "engine")
        if (!binderLatch.await(15, TimeUnit.SECONDS)) {
            throw IllegalStateException("Streaming engine did not start")
        }
        val mgr = binder ?: throw IllegalStateException("Streaming engine unavailable")

        // 1. Ensure the engine knows this PC (idempotent: CMS dedupes by uuid)
        emit("stream-status", "step" to "connect")
        var computer = findComputerByAddress(mgr, hostIp)
        if (computer == null) {
            val fake = ComputerDetails()
            fake.manualAddress = ComputerDetails.AddressTuple(hostIp, defaultHttpPort)
            if (!mgr.addComputerBlocking(fake)) {
                throw IllegalStateException("Could not reach the host PC at $hostIp")
            }
            computer = findComputerByAddress(mgr, hostIp)
                ?: throw IllegalStateException("Host PC did not register")
        }
        if (cancelled.get()) throw InterruptedException()

        // 2. Pair invisibly if needed
        val http = NvHTTP(
            ComputerDetails.AddressTuple(hostIp, defaultHttpPort),
            computer.httpsPort,
            mgr.uniqueId,
            computer.serverCert,
            PlatformBinding.getCryptoProvider(activity),
        )
        if (http.getPairState() != PairingManager.PairState.PAIRED) {
            emit("stream-status", "step" to "pair")
            val pin = PairingManager.generatePinString()
            // The web layer relays this PIN over the command bus; the host
            // auto-approves. The user never sees it.
            emit("pair-pin", "pin" to pin, "host" to hostIp)
            val pm = http.pairingManager
            val state = pm.pair(http.getServerInfo(true), pin)
            if (state != PairingManager.PairState.PAIRED) {
                throw IllegalStateException("Pairing failed (${state}) — is Launch Deck running on the host?")
            }
            computer.serverCert = pm.pairedCert
        }
        if (cancelled.get()) throw InterruptedException()

        // 3. Resolve the app by name
        emit("stream-status", "step" to "app")
        val apps = NvHTTP(
            ComputerDetails.AddressTuple(hostIp, defaultHttpPort),
            computer.httpsPort,
            mgr.uniqueId,
            computer.serverCert,
            PlatformBinding.getCryptoProvider(activity),
        ).appList
        val target: NvApp = apps.firstOrNull { it.appName.equals(appName, ignoreCase = true) }
            ?: apps.firstOrNull { it.appName.contains(appName, ignoreCase = true) }
            ?: throw IllegalStateException("'$appName' is not shared by the host (${apps.size} apps visible)")

        // 4. Refresh computer state and launch the video activity
        emit("stream-status", "step" to "launch")
        mgr.invalidateStateForComputer(computer.uuid)
        val ready = waitForOnline(mgr, computer.uuid, 10_000)
        if (cancelled.get()) throw InterruptedException()

        val intent = ServerHelper.createStartIntent(activity, target, ready, mgr)
        activity.runOnUiThread {
            activity.startActivity(intent)
        }
        emit("stream-started", "app" to target.appName)
    }

    private fun findComputerByAddress(
        mgr: ComputerManagerService.ComputerManagerBinder,
        hostIp: String,
    ): ComputerDetails? {
        val db = com.limelight.computers.ComputerDatabaseManager(activity)
        return try {
            db.allComputers.firstOrNull { c ->
                sequenceOf(c.manualAddress, c.localAddress, c.remoteAddress, c.activeAddress)
                    .filterNotNull()
                    .any { it.address == hostIp }
            }?.let { mgr.getComputer(it.uuid) ?: it }
        } finally {
            db.close()
        }
    }

    /** Poll until the computer is ONLINE with an active address (or timeout). */
    private fun waitForOnline(
        mgr: ComputerManagerService.ComputerManagerBinder,
        uuid: String,
        timeoutMs: Long,
    ): ComputerDetails {
        val deadline = System.currentTimeMillis() + timeoutMs
        var last: ComputerDetails? = null
        while (System.currentTimeMillis() < deadline) {
            last = mgr.getComputer(uuid)
            if (last != null && last.state == ComputerDetails.State.ONLINE && last.activeAddress != null) {
                return last
            }
            Thread.sleep(400)
        }
        return last ?: throw IllegalStateException("Host PC state unknown")
    }

    fun shutdown() {
        try {
            activity.unbindService(serviceConnection)
        } catch (_: Exception) {
            // not bound
        }
    }
}

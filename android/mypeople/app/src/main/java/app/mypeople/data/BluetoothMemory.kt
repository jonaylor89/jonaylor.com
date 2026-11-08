package app.mypeople.data

import android.Manifest
import android.bluetooth.BluetoothManager
import android.bluetooth.BluetoothSocket
import android.content.Context
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Build
import androidx.core.content.ContextCompat
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.ensureActive
import kotlinx.coroutines.withContext
import kotlinx.serialization.Serializable
import java.io.File
import java.io.FileOutputStream
import java.util.UUID
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicReference
import kotlin.coroutines.coroutineContext

@Serializable
data class BluetoothOffer(
    val type: String, val version: Int, val address: String, val service: String,
    val passphrase: String, val source: String, val token: String, val expires: Long,
    val name: String = "Your Mac",
    val publisher: String? = null,
    val wait_keepalive: Boolean = false,
    val graph_collection: String? = null,
) {
    fun validate(now: Long = System.currentTimeMillis() / 1000) {
        require(type == "sherloq-bluetooth" && version in 1..3) { "That isn’t a supported MyPeople Bluetooth QR." }
        require(Regex("([0-9A-F]{2}:){5}[0-9A-F]{2}").matches(address) && address != "00:00:00:00:00:00") { "Invalid Bluetooth address in QR." }
        UUID.fromString(service); UUID.fromString(source); publisher?.let { UUID.fromString(it) }; graph_collection?.let { require(UUID.fromString(it).toString() == it) }
        require(passphrase.length in 12..128 && passphrase.all { it.code < 128 } && Regex("[A-Za-z0-9_-]{24,64}").matches(token)) { "Invalid pairing credentials in QR." }
        require(expires > now && expires <= now + 3600) { "This QR has expired. Generate another on your Mac." }
    }
    companion object {
        fun parse(raw: String): BluetoothOffer {
            require(raw.length <= 4096) { "That QR is too large." }
            return json.decodeFromString<BluetoothOffer>(raw).also { it.validate() }
        }
    }
}

enum class BluetoothPhase { CONNECTING, SENDING_EDITS, WAITING_FOR_MAC, RECEIVING_MEMORY, IMPORTING, CONFIRMING }
data class BluetoothProgress(val phase: BluetoothPhase, val done: Long = 0, val total: Long = 0)
data class BluetoothSyncResult(val bidirectional: Boolean, val peerConfirmed: Boolean)

/** Secure RFCOMM + QR capability + encrypted, UUID-idempotent edits and return snapshot. */
class BluetoothMemory(private val context: Context, private val files: OfflineFiles) {
    private val active = AtomicReference<BluetoothSocket?>(null)
    fun cancel() { runCatching { active.getAndSet(null)?.close() } }

    @android.annotation.SuppressLint("MissingPermission")
    suspend fun sync(offer: BluetoothOffer, progress: (BluetoothProgress) -> Unit): BluetoothSyncResult = withContext(Dispatchers.IO) {
        offer.validate()
        // Reject foreign queues before connecting. Reading the queue does not mark it sent.
        val prepareStart = System.nanoTime()
        val edits = if (offer.version >= 2) files.bluetoothEdits(offer.source, offer.passphrase, offer.publisher, offer.graph_collection) else null
        if (context.applicationInfo.flags and android.content.pm.ApplicationInfo.FLAG_DEBUGGABLE != 0)
            android.util.Log.i("MyPeopleBluetooth", "prepare=${(System.nanoTime() - prepareStart) / 1_000_000}ms; kdf_provider=${javax.crypto.SecretKeyFactory.getInstance("PBKDF2WithHmacSHA256").provider.name}")
        require(edits == null || edits.size <= BluetoothWire.MAX_UPLOAD) { "Queued edits are too large for one Bluetooth sync. Use the file export instead." }
        require(Build.VERSION.SDK_INT < 31 || ContextCompat.checkSelfPermission(context, Manifest.permission.BLUETOOTH_CONNECT) == PackageManager.PERMISSION_GRANTED) { "Allow Nearby devices access to sync over Bluetooth." }
        val adapter = context.getSystemService(BluetoothManager::class.java)?.adapter
        require(adapter != null && adapter.isEnabled) { "Turn on Bluetooth, then scan the QR again." }
        val socket = adapter.getRemoteDevice(offer.address).createRfcommSocketToServiceRecord(UUID.fromString(offer.service))
        active.getAndSet(socket)?.close()
        // A blocked keepalive write must never prevent the independent watchdog closing
        // a dead socket. Keepalives contain no contact data and cannot acknowledge import.
        val timer = Executors.newScheduledThreadPool(2)
        val outputLock = Any()
        val importing = AtomicBoolean(false)
        val keepalive = timer.scheduleAtFixedRate({
            if (offer.version >= 2 && offer.wait_keepalive && importing.get()) runCatching {
                synchronized(outputLock) {
                    if (importing.get()) { socket.outputStream.write("WAIT\n".toByteArray(Charsets.US_ASCII)); socket.outputStream.flush() }
                }
            }
        }, 10, 10, TimeUnit.SECONDS)
        val deadline = BluetoothDeadline()
        val watchdog = timer.scheduleAtFixedRate({ if (deadline.expired()) runCatching { socket.close() } }, 1, 1, TimeUnit.SECONDS)
        val temp = File.createTempFile("bluetooth-memory-", ".sherloq", context.cacheDir)
        val jobContext = coroutineContext
        fun heartbeat() {
            jobContext.ensureActive()
            deadline.progress()
        }
        try {
            progress(BluetoothProgress(BluetoothPhase.CONNECTING))
            socket.connect()
            if (offer.version >= 3) BluetoothWire.readReady(socket.inputStream, ::heartbeat)
            heartbeat()
            socket.outputStream.write(("SHERLOQ${offer.version} ${offer.token}\n").toByteArray(Charsets.US_ASCII))
            socket.outputStream.flush()
            if (edits != null) {
                progress(BluetoothProgress(BluetoothPhase.SENDING_EDITS, 0, edits.size.toLong()))
                BluetoothWire.writeUpload(socket.outputStream, edits) { done, size ->
                    heartbeat(); progress(BluetoothProgress(BluetoothPhase.SENDING_EDITS, done, size))
                }
                progress(BluetoothProgress(BluetoothPhase.WAITING_FOR_MAC))
                // An older queued request may take time. This phase is explicit, not an endless Connecting label.
                deadline.waitingForMac()
            }
            val digest = FileOutputStream(temp).use { output ->
                val hash = BluetoothWire.readSnapshot(socket.inputStream, output, ::heartbeat) { done, size ->
                    progress(BluetoothProgress(BluetoothPhase.RECEIVING_MEMORY, done, size))
                }
                output.fd.sync()
                hash
            }
            progress(BluetoothProgress(BluetoothPhase.IMPORTING))
            deadline.importing()
            jobContext.ensureActive()
            // This is the only acknowledgment point: records + receipt results + queue commit atomically.
            importing.set(true)
            try { files.importMemory(Uri.fromFile(temp), offer.passphrase, expectedSource = offer.source) }
            finally { importing.set(false) }
            progress(BluetoothProgress(BluetoothPhase.CONFIRMING))
            deadline.confirming()
            val confirmed = runCatching {
                synchronized(outputLock) { BluetoothWire.acknowledge(socket.outputStream, offer.version, digest) }
                if (context.applicationInfo.flags and android.content.pm.ApplicationInfo.FLAG_DEBUGGABLE != 0) android.util.Log.i("MyPeopleBluetooth", "ack_written")
                if (offer.version >= 2) BluetoothWire.readFinished(socket.inputStream) else false
            }.onFailure {
                if (context.applicationInfo.flags and android.content.pm.ApplicationInfo.FLAG_DEBUGGABLE != 0) android.util.Log.i("MyPeopleBluetooth", "confirmation_failed=${it.javaClass.simpleName}")
            }.getOrDefault(false)
            // A lost final radio reply must not misreport an already committed import as lost data.
            BluetoothSyncResult(offer.version >= 2, confirmed)
        } finally {
            importing.set(false); keepalive.cancel(false); watchdog.cancel(false); timer.shutdownNow()
            active.compareAndSet(socket, null)
            runCatching { socket.close() }
            temp.delete()
        }
    }
}

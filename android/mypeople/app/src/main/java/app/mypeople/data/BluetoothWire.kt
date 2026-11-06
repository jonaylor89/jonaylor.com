package app.mypeople.data

import java.io.DataInputStream
import java.io.DataOutputStream
import java.io.InputStream
import java.io.OutputStream
import java.security.MessageDigest

/** Byte protocol shared with Python. Kept independent of Android for interop tests. */
object BluetoothWire {
    const val MAX_UPLOAD = Transfer.MAX_FILE
    private val uploadMagic = "SHUP0002".toByteArray(Charsets.US_ASCII)
    private val snapshotMagic = "SHBT0001".toByteArray(Charsets.US_ASCII)
    private val finished = "SHOK0002".toByteArray(Charsets.US_ASCII)

    fun hex(bytes: ByteArray): String = bytes.joinToString("") { "%02x".format(it) }

    fun writeUpload(output: OutputStream, encrypted: ByteArray, progress: (Long, Long) -> Unit = { _, _ -> }) {
        require(encrypted.size in 52..MAX_UPLOAD) { "Queued edits are too large for one Bluetooth sync. Use the encrypted file export instead." }
        val out = DataOutputStream(output)
        out.write(uploadMagic)
        out.writeLong(encrypted.size.toLong())
        out.write(MessageDigest.getInstance("SHA-256").digest(encrypted))
        var sent = 0
        while (sent < encrypted.size) {
            val size = minOf(65536, encrypted.size - sent)
            out.write(encrypted, sent, size)
            sent += size
            progress(sent.toLong(), encrypted.size.toLong())
        }
        out.flush()
    }

    fun readSnapshot(input: InputStream, destination: OutputStream, heartbeat: () -> Unit = {},
                     progress: (Long, Long) -> Unit = { _, _ -> }): String {
        val header = readExactly(input, 48, heartbeat)
        require(header.copyOfRange(0, 8).contentEquals(snapshotMagic)) { "Unsupported Bluetooth transfer." }
        val length = DataInputStream(header.copyOfRange(8, 16).inputStream()).readLong()
        require(length in 52..Transfer.MAX_FILE.toLong()) { "Invalid Bluetooth transfer size." }
        val expected = header.copyOfRange(16, 48)
        val digest = MessageDigest.getInstance("SHA-256")
        var received = 0L
        var reported = 0L
        progress(0, length)
        val buffer = ByteArray(65536)
        while (received < length) {
            val n = input.read(buffer, 0, minOf(buffer.size.toLong(), length - received).toInt())
            require(n > 0) { "Bluetooth was interrupted. Your queued edits are safe to retry." }
            heartbeat()
            destination.write(buffer, 0, n)
            digest.update(buffer, 0, n)
            received += n
            if (received == length || received - reported >= 262144) { progress(received, length); reported = received }
        }
        require(MessageDigest.isEqual(expected, digest.digest())) { "The Bluetooth file was damaged. Sync again; your queued edits were kept." }
        return hex(expected)
    }

    fun acknowledge(output: OutputStream, version: Int, digest: String) {
        require(Regex("[0-9a-f]{64}").matches(digest)) { "Invalid snapshot digest." }
        output.write((if (version >= 2) "OK $digest\n" else "OK\n").toByteArray(Charsets.US_ASCII))
        output.flush()
    }

    fun readReady(input: InputStream, heartbeat: () -> Unit = {}) {
        require(readExactly(input, 8, heartbeat).contentEquals("SHRD0003".toByteArray(Charsets.US_ASCII))) { "The Mac did not finish opening this Bluetooth connection. Generate a fresh QR." }
    }

    fun readFinished(input: InputStream): Boolean = readExactly(input, 8).contentEquals(finished)

    private fun readExactly(input: InputStream, size: Int, heartbeat: () -> Unit = {}): ByteArray {
        val out = ByteArray(size)
        var used = 0
        while (used < size) {
            val n = input.read(out, used, size - used)
            require(n > 0) { "Bluetooth connection ended before the transfer completed." }
            used += n
            heartbeat()
        }
        return out
    }
}

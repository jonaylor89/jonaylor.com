package app.mypeople.data

import java.io.DataInputStream
import java.io.DataOutputStream
import java.io.InputStream
import java.io.OutputStream
import java.nio.ByteBuffer
import java.security.SecureRandom
import javax.crypto.Cipher
import javax.crypto.spec.GCMParameterSpec

/** File envelope v2: bounded independently authenticated frames, including a
 * mandatory authenticated end frame. Never buffers an entire GCM message. */
internal object ChunkedCrypto {
    val magic = "SHERLOQ2".toByteArray(Charsets.US_ASCII)
    const val FRAME = 1024 * 1024
    const val MAX_BYTES = 4L * 1024 * 1024 * 1024
    fun encrypt(input: InputStream, output: OutputStream, password: String) {
        val random = SecureRandom()
        val salt = ByteArray(16).also(random::nextBytes)
        val prefix = ByteArray(4).also(random::nextBytes)
        val header = magic + salt + prefix
        val key = Transfer.key(password, salt)
        val out = DataOutputStream(output)
        out.write(header)
        val buffer = ByteArray(FRAME)
        var sequence = 0L; var total = 0L
        while (true) {
            var size = 0
            while (size < buffer.size) { val n = input.read(buffer, size, buffer.size - size); if (n < 0) break; size += n }
            total += size; require(total <= MAX_BYTES) { "Archive exceeds the streaming size limit." }
            val nonce = prefix + ByteBuffer.allocate(8).putLong(sequence).array()
            val aad = header + ByteBuffer.allocate(12).putLong(sequence).putInt(size).array()
            val cipher = Cipher.getInstance("AES/GCM/NoPadding")
            cipher.init(Cipher.ENCRYPT_MODE, key, GCMParameterSpec(128, nonce)); cipher.updateAAD(aad)
            out.writeInt(size); out.write(cipher.doFinal(buffer, 0, size))
            sequence++
            if (size == 0) break
        }
        out.flush()
    }
    fun decrypt(input: InputStream, output: OutputStream, password: String) {
        val source = DataInputStream(input)
        val header = ByteArray(28).also(source::readFully)
        require(header.copyOfRange(0, 8).contentEquals(magic)) { "Unsupported streaming archive." }
        val prefix = header.copyOfRange(24, 28)
        val key = Transfer.key(password, header.copyOfRange(8, 24))
        var sequence = 0L; var total = 0L
        while (true) {
            val size = source.readInt()
            require(size in 0..FRAME) { "Invalid encrypted archive frame." }
            total += size; require(total <= MAX_BYTES) { "Archive exceeds the streaming size limit." }
            val encrypted = ByteArray(size + 16).also(source::readFully)
            val nonce = prefix + ByteBuffer.allocate(8).putLong(sequence).array()
            val cipher = Cipher.getInstance("AES/GCM/NoPadding")
            cipher.init(Cipher.DECRYPT_MODE, key, GCMParameterSpec(128, nonce))
            cipher.updateAAD(header + ByteBuffer.allocate(12).putLong(sequence).putInt(size).array())
            val plain = try { cipher.doFinal(encrypted) }
            catch (_: javax.crypto.AEADBadTagException) { throw IllegalArgumentException("Incorrect passphrase or damaged streaming archive.") }
            if (size == 0) { require(source.read() == -1) { "Trailing encrypted archive data." }; break }
            output.write(plain); sequence++
        }
        output.flush()
    }
}

package app.mypeople.data

import kotlinx.coroutines.runBlocking
import kotlinx.serialization.encodeToString
import kotlinx.serialization.json.*
import org.junit.Assert.*
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import java.io.ByteArrayOutputStream
import java.io.DataInputStream
import java.io.File
import java.security.MessageDigest

class BluetoothWireTest {
    @get:Rule val temp = TemporaryFolder()
    private val source = "11111111-1111-4111-8111-111111111111"
    private val password = "synthetic-transfer-passphrase"
    private val payload = buildJsonObject { put("person_id", 1); put("name", "From Android") }
    private val pending = PendingOp("22222222-2222-4222-8222-222222222222", "rename", payload)
    private fun fixture(name: String) = javaClass.getResourceAsStream("/$name")!!.use { it.readBytes() }

    @Test fun `v3 waits for the native delegate before authentication and keeps digest acknowledgments`() {
        BluetoothWire.readReady("SHRD0003".byteInputStream())
        try { BluetoothWire.readReady("SHBT0001".byteInputStream()); fail("Require the ready marker") } catch (_: IllegalArgumentException) { }
        try { BluetoothWire.readReady("SHRD".byteInputStream()); fail("Require the complete ready marker") } catch (_: IllegalArgumentException) { }
        val ack = ByteArrayOutputStream(); val digest = "a".repeat(64)
        BluetoothWire.acknowledge(ack, 3, digest)
        assertEquals("OK $digest\n", ack.toString("US-ASCII"))
    }

    @Test fun `upload frame has Python compatible header size checksum and ciphertext`() {
        val encrypted = Transfer.encrypt(Transfer.pack(TransferManifest(type = "edits", source = source, ops = listOf(pending))), password)
        val out = ByteArrayOutputStream()
        BluetoothWire.writeUpload(out, encrypted)
        val frame = out.toByteArray()
        val input = DataInputStream(frame.inputStream())
        val magic = ByteArray(8).also(input::readFully)
        assertEquals("SHUP0002", magic.toString(Charsets.US_ASCII))
        assertEquals(encrypted.size.toLong(), input.readLong())
        val digest = ByteArray(32).also(input::readFully)
        assertArrayEquals(MessageDigest.getInstance("SHA-256").digest(encrypted), digest)
        assertArrayEquals(encrypted, input.readBytes())
        File("build/interop-upload.frame").apply { parentFile?.mkdirs(); writeBytes(frame) }
    }

    @Test fun `Python return frame validates and corrupt or partial packets fail`() {
        val frame = fixture("python-return.frame")
        val out = ByteArrayOutputStream()
        val digest = BluetoothWire.readSnapshot(frame.inputStream(), out)
        val encrypted = out.toByteArray()
        assertArrayEquals(fixture("python-roundtrip.sherloq"), encrypted)
        assertEquals(BluetoothWire.hex(MessageDigest.getInstance("SHA-256").digest(encrypted)), digest)
        val ack = ByteArrayOutputStream()
        BluetoothWire.acknowledge(ack, 2, digest)
        assertEquals("OK $digest\n", ack.toString("US-ASCII"))
        assertTrue(BluetoothWire.readFinished("SHOK0002".byteInputStream()))
        assertFalse(BluetoothWire.readFinished("WRONGACK".byteInputStream()))
        val damaged = frame.copyOf().also { it[it.lastIndex] = (it.last().toInt() xor 1).toByte() }
        try { BluetoothWire.readSnapshot(damaged.inputStream(), ByteArrayOutputStream()); fail("Reject bad checksum") } catch (_: IllegalArgumentException) { }
        try { BluetoothWire.readSnapshot(frame.copyOf(20).inputStream(), ByteArrayOutputStream()); fail("Reject partial header") } catch (_: IllegalArgumentException) { }
    }

    @Test fun `Python applied receipt clears only uploaded UUID while later edits survive`() = runBlocking {
        val dir = temp.newFolder()
        val original = DiskState(records = Records(people = mapOf(1 to Person("Sample Person"))),
            pending = listOf(pending), offlineSource = source, offlineRevision = 1)
        File(dir, "store.json").writeText(json.encodeToString(original))
        val store = Store(dir)
        assertEquals(pending.client_id, store.bluetoothEdits(source).ops.single().client_id)
        assertEquals(1, store.state.value.pending.size) // No acknowledgment on upload.
        store.enqueue("alias_add", buildJsonObject { put("person_id", 1); put("alias", "Later edit") })
        val snapshot = Transfer.unpack(Transfer.decrypt(fixture("python-roundtrip.sherloq"), password))
        store.installOffline(snapshot)
        val restarted = Store(dir)
        restarted.initialize()
        assertEquals("From Android", restarted.state.value.records.people[1]?.name)
        assertEquals(listOf("Later edit"), restarted.state.value.records.people[1]?.aliases)
        assertEquals(1, restarted.state.value.pending.size)
        assertEquals("alias_add", restarted.state.value.pending.single().kind)
    }

    @Test fun `initial pairing can send empty edits but foreign queued edits cannot leak`() = runBlocking {
        val fresh = Store(temp.newFolder())
        val first = fresh.bluetoothEdits(source)
        assertTrue(first.ops.isEmpty())
        assertNull(fresh.state.value.offlineSource) // Pairing does not switch until snapshot import.
        fresh.enqueue("rename", payload)
        try { fresh.bluetoothEdits(source); fail("Protect queue from another sync method") } catch (_: IllegalArgumentException) { }
        assertEquals(1, fresh.state.value.pending.size)
    }
}

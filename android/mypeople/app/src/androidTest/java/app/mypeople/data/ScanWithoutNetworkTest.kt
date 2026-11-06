package app.mypeople.data

import android.Manifest
import android.content.pm.PackageManager
import android.graphics.Bitmap
import android.graphics.Color
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import com.google.android.gms.tasks.Tasks
import com.google.mlkit.vision.barcode.BarcodeScannerOptions
import com.google.mlkit.vision.barcode.BarcodeScanning
import com.google.mlkit.vision.barcode.common.Barcode
import com.google.mlkit.vision.common.InputImage
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import java.util.concurrent.TimeUnit

/** Scanning has to keep working with Google's telemetry and the network permission stripped out. */
@RunWith(AndroidJUnit4::class)
class ScanWithoutNetworkTest {
    private val rows = listOf(
        ".................................",
        ".................................",
        ".................................",
        ".................................",
        "....#######.#...#####.#######....",
        "....#.....#....##.#.#.#.....#....",
        "....#.###.#...##..###.#.###.#....",
        "....#.###.#.#.#..#..#.#.###.#....",
        "....#.###.#.#.#.#.###.#.###.#....",
        "....#.....#.#.#.##....#.....#....",
        "....#######.#.#.#.#.#.#######....",
        "............#..#..##.............",
        "....#...#.###.......######..#....",
        "....#.#.##.##....#.###..#..#.....",
        "....#.#.###..#.....#.#.#.##......",
        "....#..#.#..####..##..###.#......",
        "......#.#.##.####....###..#......",
        "....#..##....##..#.###.###.#.....",
        "......##.##.###..#.#####..#......",
        "......#..#....#.#..##..#..#......",
        "....###..###..##.########.##.....",
        "............#.#.#.#.#...###......",
        "....#######.#..####.#.#.#........",
        "....#.....#..#.#.#..#...#.#......",
        "....#.###.#.##..##..#########....",
        "....#.###.#...#..##..###...##....",
        "....#.###.#..#......####.###.....",
        "....#.....#...#.#.#...#...##.....",
        "....#######.#.##.###......###....",
        ".................................",
        ".................................",
        ".................................",
        ".................................",
    )

    @Test fun theAppCannotReachTheNetwork() {
        val context = InstrumentationRegistry.getInstrumentation().targetContext
        assertTrue(context.checkSelfPermission(Manifest.permission.INTERNET) == PackageManager.PERMISSION_DENIED)
    }

    @Test fun aQrCodeStillScans() {
        val scale = 8
        val bitmap = Bitmap.createBitmap(rows.size * scale, rows.size * scale, Bitmap.Config.ARGB_8888)
        for (y in 0 until bitmap.height) for (x in 0 until bitmap.width) {
            bitmap.setPixel(x, y, if (rows[y / scale][x / scale] == '#') Color.BLACK else Color.WHITE)
        }
        val scanner = BarcodeScanning.getClient(BarcodeScannerOptions.Builder().setBarcodeFormats(Barcode.FORMAT_QR_CODE).build())
        val found = Tasks.await(scanner.process(InputImage.fromBitmap(bitmap, 0)), 30, TimeUnit.SECONDS)
        scanner.close()
        assertEquals("mypeople-synthetic-qr", found.single().rawValue)
    }
}

package app.mypeople.data

import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.graphics.Color
import android.media.ExifInterface
import android.provider.MediaStore
import androidx.activity.result.contract.ActivityResultContracts
import androidx.core.content.FileProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith
import java.io.ByteArrayInputStream
import java.io.File

/** Synthetic images only; never opens the camera or reads the user's gallery. */
@RunWith(AndroidJUnit4::class)
class ContactCameraPhotoTest {
    private val context get() = InstrumentationRegistry.getInstrumentation().targetContext
    private fun image(width: Int, height: Int): File {
        val file = File.createTempFile("camera-test-", ".jpg", context.cacheDir)
        val bitmap = Bitmap.createBitmap(width, height, Bitmap.Config.ARGB_8888)
        for (y in 0 until height) for (x in 0 until width) bitmap.setPixel(x, y, when {
            y < height / 2 && x < width / 2 -> Color.RED
            y < height / 2 -> Color.GREEN
            x < width / 2 -> Color.BLUE
            else -> Color.YELLOW
        })
        file.outputStream().use { bitmap.compress(Bitmap.CompressFormat.JPEG, 95, it) }
        bitmap.recycle()
        return file
    }

    @Test fun allExifOrientationsAreAppliedAndLocationMetadataIsNotCopied() {
        val orientations = listOf(
            ExifInterface.ORIENTATION_NORMAL to Color.RED,
            ExifInterface.ORIENTATION_FLIP_HORIZONTAL to Color.GREEN,
            ExifInterface.ORIENTATION_ROTATE_180 to Color.YELLOW,
            ExifInterface.ORIENTATION_FLIP_VERTICAL to Color.BLUE,
            ExifInterface.ORIENTATION_TRANSPOSE to Color.RED,
            ExifInterface.ORIENTATION_ROTATE_90 to Color.BLUE,
            ExifInterface.ORIENTATION_TRANSVERSE to Color.YELLOW,
            ExifInterface.ORIENTATION_ROTATE_270 to Color.GREEN,
        )
        for ((orientation, expected) in orientations) {
            val file = image(100, 60)
            try {
                ExifInterface(file.path).apply {
                    setAttribute(ExifInterface.TAG_ORIENTATION, orientation.toString())
                    setAttribute(ExifInterface.TAG_GPS_LATITUDE, "10/1,0/1,0/1")
                    setAttribute(ExifInterface.TAG_GPS_LATITUDE_REF, "N")
                    saveAttributes()
                }
                val bytes = contactCameraPhoto(file)
                val bitmap = requireNotNull(BitmapFactory.decodeByteArray(bytes, 0, bytes.size))
                val swapped = orientation in 5..8
                assertEquals(if (swapped) 60 else 100, bitmap.width)
                assertEquals(if (swapped) 100 else 60, bitmap.height)
                val actual = bitmap.getPixel(bitmap.width / 4, bitmap.height / 4)
                assertTrue(kotlin.math.abs(Color.red(expected) - Color.red(actual)) < 30)
                assertTrue(kotlin.math.abs(Color.green(expected) - Color.green(actual)) < 30)
                assertTrue(kotlin.math.abs(Color.blue(expected) - Color.blue(actual)) < 30)
                bitmap.recycle()
                val exif = ExifInterface(ByteArrayInputStream(bytes))
                assertFalse(exif.hasAttribute(ExifInterface.TAG_GPS_LATITUDE))
                assertTrue(exif.getAttributeInt(ExifInterface.TAG_ORIENTATION, ExifInterface.ORIENTATION_UNDEFINED) in setOf(ExifInterface.ORIENTATION_UNDEFINED, ExifInterface.ORIENTATION_NORMAL))
                ContactCard("Photo test", photo = java.util.Base64.getEncoder().encodeToString(bytes)).validate()
            } finally { file.delete() }
        }
    }

    @Test fun largeCaptureIsResizedBelowTheContactLimit() {
        val file = image(2600, 1400)
        try {
            val bytes = contactCameraPhoto(file)
            assertTrue(bytes.size <= 2 * 1024 * 1024)
            val bounds = BitmapFactory.Options().apply { inJustDecodeBounds = true }
            BitmapFactory.decodeByteArray(bytes, 0, bytes.size, bounds)
            assertEquals(1280, bounds.outWidth)
            assertTrue(bounds.outHeight in 1..1280)
        } finally { file.delete() }
    }

    @Test fun unusableCaptureIsRejectedRatherThanReplacingTheOldPhoto() {
        val file = File.createTempFile("empty-camera-", ".jpg", context.cacheDir)
        try {
            assertThrows(IllegalArgumentException::class.java) { contactCameraPhoto(file) }
            file.writeText("not a camera photo")
            assertThrows(IllegalArgumentException::class.java) { contactCameraPhoto(file) }
        } finally { file.delete() }
    }

    @Test fun cameraUriSharesOnlyTheDedicatedCaptureDirectory() {
        val directory = File(context.cacheDir, "contact-camera").apply { mkdirs() }
        val file = File.createTempFile("capture-test-", ".jpg", directory)
        val outside = File.createTempFile("private-test-", ".jpg", context.cacheDir)
        try {
            val uri = FileProvider.getUriForFile(context, "${context.packageName}.transfers", file)
            assertEquals("content", uri.scheme)
            assertTrue(uri.path!!.startsWith("/contact-camera/"))
            val intent = ActivityResultContracts.TakePicture().createIntent(context, uri)
            assertEquals(MediaStore.ACTION_IMAGE_CAPTURE, intent.action)
            @Suppress("DEPRECATION")
            val output = intent.getParcelableExtra<android.net.Uri>(MediaStore.EXTRA_OUTPUT)
            assertEquals(uri, output)
            assertThrows(IllegalArgumentException::class.java) { FileProvider.getUriForFile(context, "${context.packageName}.transfers", outside) }
        } finally { file.delete(); outside.delete() }
    }
}

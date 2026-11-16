package app.mypeople.data

import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.graphics.Matrix
import android.media.ExifInterface
import java.io.ByteArrayOutputStream
import java.io.File

/** Camera output is temporary. The contact gets a bounded, upright JPEG without GPS/EXIF metadata. */
internal fun contactCameraPhoto(file: File): ByteArray {
    require(file.length() in 1..(64L * 1024 * 1024)) { "The camera did not return a usable photo." }
    val bounds = BitmapFactory.Options().apply { inJustDecodeBounds = true }
    BitmapFactory.decodeFile(file.path, bounds)
    require(bounds.outWidth > 0 && bounds.outHeight > 0 && bounds.outWidth.toLong() * bounds.outHeight <= 200_000_000) { "Unreadable camera photo." }
    val maxSide = 1280
    val options = BitmapFactory.Options().apply {
        inSampleSize = 1
        while (maxOf(bounds.outWidth, bounds.outHeight) / inSampleSize > maxSide * 2) inSampleSize *= 2
    }
    var bitmap = requireNotNull(BitmapFactory.decodeFile(file.path, options)) { "Unreadable camera photo." }
    try {
        val ratio = minOf(1f, maxSide.toFloat() / maxOf(bitmap.width, bitmap.height))
        if (ratio < 1f) {
            val scaled = Bitmap.createScaledBitmap(bitmap, (bitmap.width * ratio).toInt().coerceAtLeast(1), (bitmap.height * ratio).toInt().coerceAtLeast(1), true)
            if (scaled !== bitmap) { bitmap.recycle(); bitmap = scaled }
        }
        val orientation = ExifInterface(file.path).getAttributeInt(ExifInterface.TAG_ORIENTATION, ExifInterface.ORIENTATION_NORMAL)
        val matrix = Matrix().apply {
            when (orientation) {
                ExifInterface.ORIENTATION_FLIP_HORIZONTAL -> setScale(-1f, 1f)
                ExifInterface.ORIENTATION_ROTATE_180 -> setRotate(180f)
                ExifInterface.ORIENTATION_FLIP_VERTICAL -> setScale(1f, -1f)
                ExifInterface.ORIENTATION_TRANSPOSE -> { setRotate(90f); postScale(-1f, 1f) }
                ExifInterface.ORIENTATION_ROTATE_90 -> setRotate(90f)
                ExifInterface.ORIENTATION_TRANSVERSE -> { setRotate(-90f); postScale(-1f, 1f) }
                ExifInterface.ORIENTATION_ROTATE_270 -> setRotate(-90f)
            }
        }
        if (!matrix.isIdentity) {
            val upright = Bitmap.createBitmap(bitmap, 0, 0, bitmap.width, bitmap.height, matrix, true)
            if (upright !== bitmap) { bitmap.recycle(); bitmap = upright }
        }
        for (quality in listOf(88, 78, 68, 58)) {
            val output = ByteArrayOutputStream()
            check(bitmap.compress(Bitmap.CompressFormat.JPEG, quality, output))
            if (output.size() <= 2 * 1024 * 1024) return output.toByteArray()
        }
        error("The camera photo could not fit the contact photo limit.")
    } finally { bitmap.recycle() }
}

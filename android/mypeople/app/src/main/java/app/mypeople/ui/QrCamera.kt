package app.mypeople.ui

import androidx.camera.core.CameraSelector
import androidx.camera.core.ImageAnalysis
import androidx.camera.core.Preview
import androidx.camera.lifecycle.ProcessCameraProvider
import androidx.camera.view.PreviewView
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.unit.dp
import androidx.compose.ui.viewinterop.AndroidView
import androidx.compose.ui.window.Dialog
import androidx.compose.ui.window.DialogProperties
import androidx.core.content.ContextCompat
import androidx.lifecycle.compose.LocalLifecycleOwner
import com.google.mlkit.vision.barcode.BarcodeScanning
import com.google.mlkit.vision.barcode.BarcodeScannerOptions
import com.google.mlkit.vision.barcode.common.Barcode
import com.google.mlkit.vision.common.InputImage
import java.util.concurrent.Executors
import java.util.concurrent.atomic.AtomicBoolean

/** Bundled QR detector: frames remain local, and no scanner module download is required. */
@androidx.annotation.OptIn(androidx.camera.core.ExperimentalGetImage::class)
@Composable
fun QrCamera(onScanned: (String) -> Unit, onClose: () -> Unit, onError: () -> Unit) {
    val context = LocalContext.current
    val lifecycle = LocalLifecycleOwner.current
    val previewView = remember(context) { PreviewView(context).apply { scaleType = PreviewView.ScaleType.FILL_CENTER } }
    val currentScanned by rememberUpdatedState(onScanned)
    val currentError by rememberUpdatedState(onError)
    DisposableEffect(previewView, lifecycle) {
        val alive = AtomicBoolean(true)
        val detected = AtomicBoolean(false)
        val executor = Executors.newSingleThreadExecutor()
        val scanner = BarcodeScanning.getClient(BarcodeScannerOptions.Builder().setBarcodeFormats(Barcode.FORMAT_QR_CODE).build())
        val preview = Preview.Builder().build().also { it.setSurfaceProvider(previewView.surfaceProvider) }
        val analysis = ImageAnalysis.Builder().setBackpressureStrategy(ImageAnalysis.STRATEGY_KEEP_ONLY_LATEST).build()
        analysis.setAnalyzer(executor) { frame ->
            val image = frame.image
            if (!alive.get() || detected.get() || image == null) frame.close()
            else {
                val input = InputImage.fromMediaImage(image, frame.imageInfo.rotationDegrees)
                scanner.process(input).addOnSuccessListener { results ->
                    val raw = results.firstOrNull { it.rawValue != null }?.rawValue
                    if (alive.get() && raw != null && detected.compareAndSet(false, true)) currentScanned(raw)
                }.addOnCompleteListener { frame.close() }
            }
        }
        val future = ProcessCameraProvider.getInstance(context)
        var provider: ProcessCameraProvider? = null
        future.addListener({
            if (alive.get()) try {
                provider = future.get()
                provider?.bindToLifecycle(lifecycle, CameraSelector.DEFAULT_BACK_CAMERA, preview, analysis)
            } catch (_: Exception) { if (alive.get()) currentError() }
        }, ContextCompat.getMainExecutor(context))
        onDispose {
            alive.set(false)
            analysis.clearAnalyzer()
            provider?.unbind(preview, analysis)
            scanner.close()
            executor.shutdown()
        }
    }
    Dialog(onDismissRequest = onClose, properties = DialogProperties(usePlatformDefaultWidth = false)) {
        Surface(Modifier.fillMaxSize(), color = Color(0xFF111A16), contentColor = Color.White) {
            Column(Modifier.fillMaxSize().systemBarsPadding()) {
                Row(Modifier.fillMaxWidth().padding(16.dp), verticalAlignment = Alignment.CenterVertically) {
                    Text("Scan your Mac’s QR", Modifier.weight(1f), style = MaterialTheme.typography.titleLarge)
                    TextButton(onClick = onClose) { Text("Cancel", color = Color.White) }
                }
                Box(Modifier.weight(1f).fillMaxWidth(), contentAlignment = Alignment.Center) {
                    AndroidView(factory = { previewView }, modifier = Modifier.fillMaxSize())
                    Box(Modifier.padding(36.dp).fillMaxWidth().aspectRatio(1f).border(2.dp, Color.White.copy(alpha = .85f), RoundedCornerShape(28.dp)))
                }
                Text("Point at the private QR on your Mac.\nCamera images stay on this phone.", Modifier.padding(24.dp), style = MaterialTheme.typography.bodyMedium)
            }
        }
    }
}

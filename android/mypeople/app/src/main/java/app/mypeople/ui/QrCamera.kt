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
import androidx.compose.ui.draw.clipToBounds
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
    var help by remember { mutableStateOf(false) }
    val previewView = remember(context) { PreviewView(context).apply {
        // TextureView composes correctly with dialog chrome, overlays and large-text relayouts.
        implementationMode = PreviewView.ImplementationMode.COMPATIBLE
        scaleType = PreviewView.ScaleType.FILL_CENTER
    } }
    var previewReady by remember { mutableStateOf(false) }
    DisposableEffect(previewView, lifecycle) {
        val observer = androidx.lifecycle.Observer<PreviewView.StreamState> { previewReady = it == PreviewView.StreamState.STREAMING }
        previewView.previewStreamState.observe(lifecycle, observer)
        onDispose { previewView.previewStreamState.removeObserver(observer) }
    }
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
                }.addOnFailureListener {
                    if (alive.get() && detected.compareAndSet(false, true)) currentError()
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
                    Text("Scan Mac QR", Modifier.weight(1f), style = MaterialTheme.typography.titleLarge)
                    TextButton(onClick = onClose) { Text("Cancel", color = Color.White) }
                }
                Box(Modifier.weight(1f).fillMaxWidth().clipToBounds(), contentAlignment = Alignment.Center) {
                    AndroidView(factory = { previewView }, modifier = Modifier.fillMaxSize())
                    Box(Modifier.padding(KinSpace.s6).sizeIn(maxWidth = 320.dp, maxHeight = 320.dp).fillMaxSize().border(2.dp, Color.White.copy(alpha = .85f), RoundedCornerShape(KinRadius.xl)))
                    if (!previewReady) Surface(color = Color(0xFF111A16), shape = RoundedCornerShape(KinRadius.lg)) {
                        Text("Opening camera…", Modifier.padding(KinSpace.s4), color = Color.White, style = MaterialTheme.typography.bodyMedium)
                    }
                }
                Column(Modifier.padding(KinSpace.s4), verticalArrangement = Arrangement.spacedBy(KinSpace.s2)) {
                    Text("Scan the QR opened by MyPeople on your Mac.", style = MaterialTheme.typography.bodyMedium)
                    TextButton(onClick = { help = true }) { Text("Where do I find the QR?", color = Color.White) }
                }
            }
        }
    }
    if (help) MacQrHelp(onClose = { help = false })
}

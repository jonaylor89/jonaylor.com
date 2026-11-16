package app.mypeople.ui

import android.Manifest
import android.content.pm.PackageManager
import android.net.Uri
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.activity.result.PickVisualMediaRequest
import androidx.compose.foundation.layout.*
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.ui.Modifier
import androidx.core.content.ContextCompat
import androidx.core.content.FileProvider
import androidx.compose.ui.platform.LocalContext
import app.mypeople.data.Transfer
import app.mypeople.data.contactCameraPhoto
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import java.io.File
import java.util.Base64

/** Delivers photo bytes to the caller, which owns draft updates or saved-contact edits. */
@Composable
internal fun rememberContactPhotoPicker(onPhoto: suspend (String) -> Unit, loading: (Boolean) -> Unit, error: (String) -> Unit, visualPicker: Boolean = false): () -> Unit {
    val context = LocalContext.current
    val scope = rememberCoroutineScope()
    val accept by rememberUpdatedState(onPhoto)
    val setLoading by rememberUpdatedState(loading)
    val reportError by rememberUpdatedState(error)
    var choose by rememberSaveable { mutableStateOf(false) }
    var cameraPath by rememberSaveable { mutableStateOf<String?>(null) }

    suspend fun importPhoto(failure: String, read: () -> ByteArray) {
        setLoading(true)
        try {
            val encoded = withContext(Dispatchers.IO) { Base64.getEncoder().encodeToString(read()) }
            accept(encoded)
        } catch (e: CancellationException) { throw e }
        catch (_: Exception) { reportError(failure) }
        finally { setLoading(false) }
    }
    fun readLibraryPhoto(uri: Uri?) {
        if (uri != null) scope.launch {
            importPhoto("Choose a JPEG or PNG smaller than 2 MiB.") {
                requireNotNull(context.contentResolver.openInputStream(uri)).use { Transfer.readLimited(it, 2 * 1024 * 1024) }
            }
        }
    }
    val picker = rememberLauncherForActivityResult(ActivityResultContracts.OpenDocument()) { readLibraryPhoto(it) }
    val visual = rememberLauncherForActivityResult(ActivityResultContracts.PickVisualMedia()) { readLibraryPhoto(it) }
    val camera = rememberLauncherForActivityResult(ActivityResultContracts.TakePicture()) { success ->
        val file = cameraPath?.let(::File)
        cameraPath = null
        if (file != null) {
            if (success) scope.launch {
                try { importPhoto("Couldn’t add that camera photo. Try again or choose another photo.") { contactCameraPhoto(file) } }
                finally { file.delete() }
            } else file.delete()
        } else if (success) reportError("The camera photo couldn’t be recovered. Please try again.")
    }
    fun takePhoto() {
        var file: File? = null
        try {
            val directory = File(context.cacheDir, "contact-camera").apply { mkdirs() }
            // Clean only abandoned files from this feature, never any gallery or imported originals.
            directory.listFiles()?.filter { it.name.startsWith("capture-") && it.lastModified() < System.currentTimeMillis() - 86_400_000L }?.forEach { it.delete() }
            file = File.createTempFile("capture-", ".jpg", directory)
            val uri = FileProvider.getUriForFile(context, "${context.packageName}.transfers", file)
            cameraPath = file.path
            camera.launch(uri)
        } catch (_: Exception) {
            file?.delete(); cameraPath = null
            reportError("Couldn’t open the camera. You can still choose a photo from your device.")
        }
    }
    val permission = rememberLauncherForActivityResult(ActivityResultContracts.RequestPermission()) { granted ->
        if (granted) takePhoto()
        else reportError("Camera permission wasn’t granted. You can still choose a photo from your device.")
    }
    if (choose) ContactPhotoSourceChooser(
        takePhoto = {
            choose = false
            if (ContextCompat.checkSelfPermission(context, Manifest.permission.CAMERA) == PackageManager.PERMISSION_GRANTED) takePhoto()
            else permission.launch(Manifest.permission.CAMERA)
        },
        choosePhoto = {
            choose = false
            if (visualPicker) visual.launch(PickVisualMediaRequest(ActivityResultContracts.PickVisualMedia.ImageOnly))
            else picker.launch(arrayOf("image/jpeg", "image/png"))
        },
        dismiss = { choose = false },
    )
    return { choose = true }
}

@Composable
internal fun ContactPhotoSourceChooser(takePhoto: () -> Unit, choosePhoto: () -> Unit, dismiss: () -> Unit) {
    AlertDialog(onDismissRequest = dismiss, title = { Text("Contact photo") }, text = {
        Column(Modifier.fillMaxWidth(), verticalArrangement = Arrangement.spacedBy(KinSpace.s2)) {
            FilledTonalButton(onClick = takePhoto, modifier = Modifier.fillMaxWidth().heightIn(min = KinSize.touchTarget)) { Text("Take photo") }
            OutlinedButton(onClick = choosePhoto, modifier = Modifier.fillMaxWidth().heightIn(min = KinSize.touchTarget)) { Text("Choose photo") }
        }
    }, confirmButton = {}, dismissButton = { TextButton(onClick = dismiss) { Text("Cancel") } })
}

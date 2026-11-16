package app.mypeople.data

import androidx.compose.runtime.*
import androidx.compose.ui.semantics.SemanticsActions
import androidx.compose.ui.test.*
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.test.ext.junit.runners.AndroidJUnit4
import app.mypeople.ui.ContactPhotoSourceChooser
import app.mypeople.ui.MyPeopleTheme
import org.junit.Assert.assertEquals
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith

@RunWith(AndroidJUnit4::class)
class ContactPhotoSourceChooserTest {
    @get:Rule val compose = createComposeRule()

    @Test fun cameraAndLibraryAreSeparateExplicitActions() {
        var open by mutableStateOf(true)
        var camera = 0
        var library = 0
        compose.setContent { MyPeopleTheme { if (open) ContactPhotoSourceChooser({ camera++; open = false }, { library++; open = false }, { open = false }) } }
        compose.onNodeWithText("Take photo").assertIsDisplayed().performSemanticsAction(SemanticsActions.OnClick)
        compose.runOnIdle { assertEquals(1, camera); assertEquals(0, library); open = true }
        compose.onNodeWithText("Choose photo").assertIsDisplayed().performSemanticsAction(SemanticsActions.OnClick)
        compose.runOnIdle { assertEquals(1, camera); assertEquals(1, library) }
    }

    @Test fun cancelDoesNotOpenCameraOrLibrary() {
        var open by mutableStateOf(true)
        var actions = 0
        compose.setContent { MyPeopleTheme { if (open) ContactPhotoSourceChooser({ actions++ }, { actions++ }, { open = false }) } }
        compose.onNodeWithText("Cancel").performSemanticsAction(SemanticsActions.OnClick)
        compose.runOnIdle { assertEquals(0, actions) }
        compose.onNodeWithText("Contact photo").assertDoesNotExist()
    }
}

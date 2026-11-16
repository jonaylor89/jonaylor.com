package app.mypeople.data

import androidx.compose.runtime.*
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.unit.Density
import androidx.compose.ui.test.*
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.test.ext.junit.runners.AndroidJUnit4
import app.mypeople.ui.ContactCapture
import app.mypeople.ui.MyPeopleTheme
import org.junit.Assert.*
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith

/** Render-only fixtures: no application graph, store or personal data. */
@RunWith(AndroidJUnit4::class)
class ContactCaptureTest {
    @get:Rule val compose = createComposeRule()

    @Test fun essentialsDoNotManufactureEmptyFieldsOrLoseImportedDetails() {
        val extra = ContactField("phone", "+442079460123", label = "Work", preferred = true, region = "GB")
        var card by mutableStateOf(ContactCard("", fields = listOf(ContactField("phone", "+14155552671"), extra, ContactField("website", "https://example.org"))))
        compose.setContent { MyPeopleTheme { Column(Modifier.verticalScroll(rememberScrollState())) { ContactCapture(card, true, { card = it }, {}) } } }
        compose.onNodeWithText("Name (required)").performTextInput("Sam Rivera")
        compose.onNodeWithText("Email (optional)").performTextInput("sam@example.org")
        compose.runOnIdle {
            assertEquals("Sam Rivera", card.name)
            assertEquals(extra, card.fields[1])
            assertEquals("https://example.org", card.fields.first { it.kind == "website" }.value)
            assertEquals("sam@example.org", card.fields.first { it.kind == "email" }.value)
        }
    }

    @Test fun oneFormOffersTheSameContextAndDetailsToEveryone() {
        var card by mutableStateOf(ContactCard("", notes = "Met at Climate Week", organization = "Example"))
        compose.setContent { MyPeopleTheme { Column(Modifier.verticalScroll(rememberScrollState())) { ContactCapture(card, true, { card = it }, {}) } } }
        compose.onNodeWithText("Name (required)").assertExists()
        compose.onNodeWithText("Met at Climate Week").assertExists()
        compose.onNodeWithText("Where we met / what to remember").assertExists()
        compose.onNodeWithText("More details").assertExists()
        compose.onNodeWithText("Let them fill it in").assertDoesNotExist()
        compose.onNodeWithText("Name (required)").performTextInput("Alex")
        compose.runOnIdle {
            assertEquals("Met at Climate Week", card.notes)
            assertTrue(card.fields.isEmpty())
        }
    }

    @Test fun workAndNoteExpandIndependentlyWithoutLosingWhatWasTyped() {
        var card by mutableStateOf(ContactCard("Alex"))
        compose.setContent { MyPeopleTheme { Column(Modifier.verticalScroll(rememberScrollState())) { ContactCapture(card, true, { card = it }, {}) } } }
        compose.onNodeWithText("Note").performClick()
        compose.onNodeWithText("Where we met / what to remember").performTextInput("Met at Climate Week")
        compose.onNodeWithText("Company or organization").assertDoesNotExist()
        compose.onNodeWithText("Note").performClick()
        compose.onNodeWithText("Work").performClick()
        compose.onNodeWithText("Company or organization").performTextInput("Example Studio")
        compose.onNodeWithText("Where we met / what to remember").assertDoesNotExist()
        compose.onNodeWithText("Note").performClick()
        compose.onNodeWithText("Met at Climate Week").assertExists()
        compose.runOnIdle {
            assertEquals("Met at Climate Week", card.notes)
            assertEquals("Example Studio", card.organization)
        }
    }

    @Test fun largeTextKeepsCountrySelectionAndOptionalFieldsAccessible() {
        var card by mutableStateOf(ContactCard("Alex"))
        compose.setContent {
            val density = LocalDensity.current
            CompositionLocalProvider(LocalDensity provides Density(density.density, 2f)) {
                MyPeopleTheme { Column(Modifier.verticalScroll(rememberScrollState())) { ContactCapture(card, true, { card = it }, {}) } }
            }
        }
        compose.onNodeWithText("Name (required)").assertExists()
        compose.onNodeWithContentDescription("Country for local numbers:", substring = true).performScrollTo().performClick()
        compose.onNodeWithText("Search countries").performTextInput("GB")
        compose.onNodeWithText("(GB)", substring = true).performClick()
        compose.onNodeWithText("More details").performScrollTo().assertIsDisplayed()
        compose.runOnIdle { assertEquals("GB", card.region) }
    }

    @Test fun countryOverrideChangesOnlyTheVisiblePhoneNotHiddenNumbers() {
        val other = ContactField("phone", "+14155552671", region = "US")
        var card by mutableStateOf(ContactCard("Alex", fields = listOf(ContactField("phone", "020 7946 0123", region = "GB"), other)))
        compose.setContent { MyPeopleTheme { Column(Modifier.verticalScroll(rememberScrollState())) { ContactCapture(card, true, { card = it }, {}) } } }
        compose.onNodeWithText("GB ▾").assertExists()
        compose.onNodeWithContentDescription("Country for local numbers:", substring = true).performClick()
        compose.onNodeWithText("Search countries").performTextInput("DE")
        compose.onNodeWithText("(DE)", substring = true).performClick()
        compose.runOnIdle {
            assertEquals("US", card.region)
            assertEquals("DE", card.fields.first().region)
            assertEquals("020 7946 0123", card.fields.first().value)
            assertEquals(other, card.fields[1])
        }
    }

    @Test fun portraitOffersAnInlinePhotoActionWithoutASlogan() {
        var card by mutableStateOf(ContactCard("Alex"))
        var enabled by mutableStateOf(true)
        var picks = 0
        compose.setContent {
            MyPeopleTheme { Column(Modifier.verticalScroll(rememberScrollState())) {
                ContactCapture(card, enabled, { card = it }, {}, onPhoto = { picks++; card = card.copy(photo_hash = "a".repeat(64)) })
            } }
        }
        compose.onNodeWithText("Everything else can wait.").assertDoesNotExist()
        compose.onNodeWithContentDescription("Add photo").performClick()
        compose.onNodeWithContentDescription("Change photo").assertIsEnabled()
        compose.runOnIdle { assertEquals(1, picks); assertEquals("Alex", card.name); enabled = false }
        compose.onNodeWithContentDescription("Change photo").assertIsNotEnabled()
    }

    @Test fun countryPickerUsesSearchableNamesAndPreservesTheNumber() {
        var card by mutableStateOf(ContactCard("Alex", fields = listOf(ContactField("phone", "020 7946 0123"))))
        compose.setContent { MyPeopleTheme { Column(Modifier.verticalScroll(rememberScrollState())) { ContactCapture(card, true, { card = it }, {}) } } }
        compose.onNodeWithContentDescription("Country for local numbers:", substring = true).performClick()
        compose.onNodeWithText("Search countries").performTextInput("GB")
        compose.onNodeWithText("(GB)", substring = true).performClick()
        compose.runOnIdle {
            assertEquals("GB", card.region)
            assertEquals("020 7946 0123", card.fields.single().value)
        }
    }
}

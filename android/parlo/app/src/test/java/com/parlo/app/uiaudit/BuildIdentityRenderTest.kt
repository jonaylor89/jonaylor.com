package com.parlo.app.uiaudit

import android.app.Application
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.Surface
import androidx.compose.ui.Modifier
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.onRoot
import androidx.compose.ui.unit.dp
import com.github.takahirom.roborazzi.captureRoboImage
import com.parlo.app.BuildConfig
import com.parlo.app.ui.components.BuildDetails
import com.parlo.app.ui.components.DevelopmentBuildNotice
import com.parlo.app.ui.theme.ParloTheme
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34], application = Application::class, qualifiers = "w412dp-h915dp-xxhdpi")
@GraphicsMode(GraphicsMode.Mode.NATIVE)
class BuildIdentityRenderTest {
    @get:Rule val rule = createComposeRule()

    @Test fun `development notice appears only in the separate developer app`() {
        rule.setContent {
            ParloTheme {
                Surface(Modifier.fillMaxSize()) {
                    Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(16.dp)) {
                        DevelopmentBuildNotice()
                        BuildDetails()
                    }
                }
            }
        }
        if (BuildConfig.IS_DEVELOPMENT) rule.onNodeWithTag("development_build_notice").assertExists()
        else rule.onNodeWithTag("development_build_notice").assertDoesNotExist()
        rule.onNodeWithText("${BuildConfig.APPLICATION_ID} · ${BuildConfig.BUILD_TYPE}").assertExists()
        rule.onRoot().captureRoboImage("build/uiaudit/50_build_identity_${BuildConfig.BUILD_TYPE}.png")
    }
}

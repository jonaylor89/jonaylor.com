package com.parlo.app

import android.app.Application
import android.content.pm.PackageManager
import android.graphics.drawable.AdaptiveIconDrawable
import androidx.test.core.app.ApplicationProvider
import com.parlo.app.service.LiveSessionService
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

/** Run against BOTH debug and dev to guard release identity and side-by-side isolation. */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34], application = Application::class)
class BuildIdentityTest {
    private val context get() = ApplicationProvider.getApplicationContext<Application>()

    @Test fun `developer identity is isolated while the distributed debug identity stays unchanged`() {
        assertEquals(BuildConfig.APPLICATION_ID, context.packageName)
        if (BuildConfig.IS_DEVELOPMENT) {
            assertEquals("com.parlo.app.dev", context.packageName)
            assertEquals("Parlo Dev", context.getString(R.string.app_name))
            assertTrue(BuildConfig.VERSION_NAME.endsWith("-dev"))
        } else {
            assertEquals("com.parlo.app", context.packageName)
            assertEquals("Parlo", context.getString(R.string.app_name))
            assertFalse(BuildConfig.VERSION_NAME.endsWith("-dev"))
        }
        assertTrue(context.getDrawable(R.mipmap.ic_launcher) is AdaptiveIconDrawable)
    }

    @Test fun `startup provider and service controls belong to this application only`() {
        val authority = "${context.packageName}.androidx-startup"
        val provider = context.packageManager.resolveContentProvider(authority, PackageManager.GET_META_DATA)
        assertNotNull(provider)
        assertEquals(context.packageName, provider!!.packageName)
        assertEquals("${context.packageName}.action.START", LiveSessionService.ACTION_START)
        assertEquals("${context.packageName}.action.TOGGLE_MUTE", LiveSessionService.ACTION_TOGGLE_MUTE)
        assertEquals("${context.packageName}.action.END", LiveSessionService.ACTION_END)
        assertEquals("${context.packageName}.action.END_NOW", LiveSessionService.ACTION_END_NOW)
    }
}

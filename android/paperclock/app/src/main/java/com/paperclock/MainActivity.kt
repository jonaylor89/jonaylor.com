package com.paperclock

import android.Manifest
import android.app.AlarmManager
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Build
import android.provider.Settings
import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.result.contract.ActivityResultContracts
import androidx.activity.viewModels
import com.paperclock.ui.ClockApp
import com.paperclock.ui.ClockViewModel
import com.paperclock.ui.theme.PaperClockTheme

class MainActivity : ComponentActivity() {
    private val vm: ClockViewModel by viewModels { val app = application as PaperClockApp; ClockViewModel.Factory(app.container.repository, app.container.scheduler) }
    private val notificationPermission = registerForActivityResult(ActivityResultContracts.RequestPermission()) { }
    override fun onCreate(savedInstanceState: Bundle?) { super.onCreate(savedInstanceState)
        if (Build.VERSION.SDK_INT >= 33 && checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED) notificationPermission.launch(Manifest.permission.POST_NOTIFICATIONS)
        setContent {
            PaperClockTheme {
                ClockApp(
                    vm,
                    openExactSettings = { if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) startActivity(Intent(Settings.ACTION_REQUEST_SCHEDULE_EXACT_ALARM, Uri.parse("package:$packageName"))) },
                    openNewAlarm = intent.getBooleanExtra(EXTRA_NEW_ALARM, false),
                    openGoals = intent.getBooleanExtra(EXTRA_OPEN_GOALS, false)
                )
            }
        }
    }

    companion object {
        const val EXTRA_NEW_ALARM = "com.paperclock.extra.NEW_ALARM"
        const val EXTRA_OPEN_GOALS = "com.paperclock.extra.OPEN_GOALS"
    }
}

package com.paperclock.alarm

import android.content.Intent
import android.os.Build
import android.os.Bundle
import android.view.WindowManager
import androidx.activity.ComponentActivity
import androidx.activity.OnBackPressedCallback
import androidx.activity.compose.setContent
import androidx.lifecycle.lifecycleScope
import com.paperclock.PaperClockApp
import com.paperclock.ui.AlarmRingingScreen
import com.paperclock.ui.theme.PaperClockTheme
import kotlinx.coroutines.launch

class AlarmActivity : ComponentActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O_MR1) {
            setShowWhenLocked(true)
            setTurnScreenOn(true)
        } else {
            window.addFlags(WindowManager.LayoutParams.FLAG_SHOW_WHEN_LOCKED or WindowManager.LayoutParams.FLAG_TURN_SCREEN_ON)
        }
        onBackPressedDispatcher.addCallback(this, object : OnBackPressedCallback(true) { override fun handleOnBackPressed() = Unit })
        val id = intent.getLongExtra(AlarmReceiver.EXTRA_ALARM_ID, -1)
        lifecycleScope.launch {
            val row = (application as PaperClockApp).container.repository.alarm(id)
            setContent { PaperClockTheme { AlarmRingingScreen(row, onDismiss = { stopService(Intent(this@AlarmActivity, AlarmSoundService::class.java)); finishAndRemoveTask() }) } }
        }
    }
}

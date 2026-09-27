package com.paperclock.alarm

import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Intent
import android.media.AudioAttributes
import android.media.AudioManager
import android.media.MediaPlayer
import android.os.IBinder
import androidx.core.app.NotificationCompat
import com.paperclock.PaperClockApp
import com.paperclock.R
import com.paperclock.data.SoundCatalog
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch

class AlarmSoundService : Service() {
    private var player: MediaPlayer? = null
    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        val id = intent?.getLongExtra(AlarmReceiver.EXTRA_ALARM_ID, -1) ?: -1
        createChannel()
        val fullScreen = PendingIntent.getActivity(this, 99, Intent(this, AlarmActivity::class.java).putExtra(AlarmReceiver.EXTRA_ALARM_ID, id), PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE)
        startForeground(NOTIFICATION_ID, NotificationCompat.Builder(this, CHANNEL_ID).setSmallIcon(R.drawable.ic_launcher_monochrome).setContentTitle("Paper Clock alarm").setContentText("Dismiss your alarm").setCategory(NotificationCompat.CATEGORY_ALARM).setPriority(NotificationCompat.PRIORITY_MAX).setOngoing(true).setFullScreenIntent(fullScreen, true).build())
        if (id >= 0) CoroutineScope(Dispatchers.IO).launch {
            val row = (application as PaperClockApp).container.repository.alarm(id) ?: return@launch
            val sound = SoundCatalog.byKey(row.alarm.soundKey)
            launch(Dispatchers.Main) {
                player?.release()
                val attributes = AudioAttributes.Builder().setUsage(AudioAttributes.USAGE_ALARM).setLegacyStreamType(AudioManager.STREAM_ALARM).build()
                player = MediaPlayer.create(this@AlarmSoundService, sound.resourceId, attributes, 0)?.apply {
                    isLooping = true; start()
                }
                if (row.alarm.vibrate) (getSystemService(VIBRATOR_SERVICE) as android.os.Vibrator).vibrate(android.os.VibrationEffect.createWaveform(longArrayOf(0, 500, 500), 0))
            }
        }
        return START_NOT_STICKY
    }
    override fun onDestroy() { player?.release(); player = null; (getSystemService(VIBRATOR_SERVICE) as android.os.Vibrator).cancel(); super.onDestroy() }
    override fun onBind(intent: Intent?): IBinder? = null
    private fun createChannel() { (getSystemService(NotificationManager::class.java)).createNotificationChannel(NotificationChannel(CHANNEL_ID, getString(R.string.alarm_channel), NotificationManager.IMPORTANCE_HIGH).apply { description = getString(R.string.alarm_channel_description); lockscreenVisibility = android.app.Notification.VISIBILITY_PUBLIC }) }
    companion object { const val CHANNEL_ID = "ringing_alarms"; const val NOTIFICATION_ID = 44 }
}

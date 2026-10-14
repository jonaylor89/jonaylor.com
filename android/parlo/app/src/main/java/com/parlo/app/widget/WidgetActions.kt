package com.parlo.app.widget

import android.Manifest
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import androidx.core.content.ContextCompat
import androidx.glance.action.Action
import androidx.glance.appwidget.action.actionStartActivity
import androidx.glance.appwidget.action.actionStartService
import com.parlo.app.MainActivity
import com.parlo.app.service.LiveSessionService

internal fun openApp(context: Context): Action =
    actionStartActivity(Intent(context, MainActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))

/**
 * Start launches the foreground service straight from the tap (a widget tap grants the exemption to
 * start a microphone service; a callback hop would lose it). Anything not ready opens the app instead.
 */
internal fun startWalk(context: Context, data: WidgetData): Action {
    val mic = ContextCompat.checkSelfPermission(context, Manifest.permission.RECORD_AUDIO) == PackageManager.PERMISSION_GRANTED
    return if (data.canStartDirect && mic) actionStartService(LiveSessionService.startIntent(context), isForegroundService = true)
    else openApp(context)
}

internal fun serviceAction(context: Context, action: String): Action =
    actionStartService(Intent(context, LiveSessionService::class.java).setAction(action), isForegroundService = false)

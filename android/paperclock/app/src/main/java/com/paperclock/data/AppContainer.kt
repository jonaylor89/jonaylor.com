package com.paperclock.data

import android.content.Context
import com.paperclock.alarm.AlarmScheduler

class AppContainer(context: Context) {
    val database = ClockDatabase.create(context)
    val repository = ClockRepository(database.dao())
    val scheduler = AlarmScheduler(context.applicationContext)
}

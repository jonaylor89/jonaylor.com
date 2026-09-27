package com.paperclock

import android.app.Application
import com.paperclock.data.AppContainer

class PaperClockApp : Application() {
    lateinit var container: AppContainer;
    override fun onCreate() {
        super.onCreate(); container = AppContainer(this)
    }
}

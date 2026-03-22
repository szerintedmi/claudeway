package com.claudeway

import android.app.Application
import com.claudeway.glasses.GlassesManager

class ClaudewayApp : Application() {
    override fun onCreate() {
        super.onCreate()

        // Initialize DAT SDK if available (gracefully degrades to standalone mode)
        if (GlassesManager.isDatSdkAvailable) {
            // DAT SDK initialization happens in GlassesManager when the ViewModel starts
        }
    }
}

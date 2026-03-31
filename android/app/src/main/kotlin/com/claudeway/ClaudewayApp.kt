package com.claudeway

import android.app.Application
import android.util.Log
import com.claudeway.glasses.GlassesManager

class ClaudewayApp : Application() {
    companion object {
        private const val TAG = "ClaudewayApp"
    }

    override fun onCreate() {
        super.onCreate()

        // Initialize DAT SDK early — must happen before any Wearables API calls.
        // GlassesManager.initializeSdk() is safe to call even when SDK is absent;
        // it detects availability at runtime and degrades to standalone mode.
        GlassesManager.initializeSdk(this)
        Log.i(TAG, "DAT SDK available: ${GlassesManager.isDatSdkAvailable}")
    }
}

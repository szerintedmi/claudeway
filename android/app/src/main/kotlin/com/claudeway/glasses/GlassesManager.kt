package com.claudeway.glasses

import android.content.Context
import android.util.Log
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow

enum class GlassesState {
    NotInitialized,
    Searching,
    Found,
    Connected,
    Disconnected,
    Error,
    Unavailable, // DAT SDK not available
}

/**
 * Manages Meta Ray-Ban glasses connection via the DAT SDK.
 *
 * The DAT SDK requires:
 * - Android 10+ (API 29+)
 * - Meta AI companion app installed with Developer Mode enabled
 * - GitHub token for pulling SDK from GitHub Packages
 *
 * When the DAT SDK is not available (commented out in build.gradle),
 * this class operates in stub mode — the app works as a standalone
 * voice client using the phone's own mic/speaker.
 */
class GlassesManager(private val context: Context) {
    companion object {
        private const val TAG = "GlassesManager"

        /** Whether the DAT SDK is available at runtime. */
        val isDatSdkAvailable: Boolean by lazy {
            try {
                Class.forName("com.meta.wearables.Wearables")
                true
            } catch (_: ClassNotFoundException) {
                false
            }
        }
    }

    private val _state = MutableStateFlow(GlassesState.NotInitialized)
    val state: StateFlow<GlassesState> = _state.asStateFlow()

    private val _touchpadTapEvents = MutableStateFlow(0L) // Timestamp of last tap
    val touchpadTapEvents: StateFlow<Long> = _touchpadTapEvents.asStateFlow()

    /** Initialize the DAT SDK. Call from Application.onCreate(). */
    fun initialize() {
        if (!isDatSdkAvailable) {
            Log.w(TAG, "DAT SDK not available — running in standalone mode (phone mic/speaker)")
            _state.value = GlassesState.Unavailable
            return
        }

        try {
            // TODO: Uncomment when DAT SDK is available
            // Wearables.initialize(context)
            _state.value = GlassesState.Disconnected
            Log.i(TAG, "DAT SDK initialized")
        } catch (e: Exception) {
            Log.e(TAG, "Failed to initialize DAT SDK", e)
            _state.value = GlassesState.Error
        }
    }

    /** Start scanning for glasses devices. */
    fun startDiscovery() {
        if (!isDatSdkAvailable) return
        _state.value = GlassesState.Searching

        // TODO: Implement with DAT SDK
        // Wearables.discoverDevices().collect { devices ->
        //     if (devices.isNotEmpty()) {
        //         _state.value = GlassesState.Found
        //         connectToDevice(devices.first())
        //     }
        // }
    }

    /** Subscribe to touchpad gesture events from the glasses. */
    fun startGestureListening() {
        if (!isDatSdkAvailable) return

        // TODO: Implement with DAT SDK
        // device.touchEvents.collect { event ->
        //     if (event.type == TouchEventType.TAP) {
        //         _touchpadTapEvents.value = System.currentTimeMillis()
        //     }
        // }
    }

    /** Clean up DAT SDK resources. */
    fun release() {
        if (!isDatSdkAvailable) return
        _state.value = GlassesState.Disconnected
    }

    /** Simulate a touchpad tap (for testing without glasses). */
    fun simulateTap() {
        _touchpadTapEvents.value = System.currentTimeMillis()
    }
}

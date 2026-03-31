package com.claudeway.glasses

import android.app.Activity
import android.content.Context
import android.util.Log
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch

enum class GlassesState {
    NotInitialized,
    NotRegistered,
    Searching,
    Connecting,
    Connected,
    Disconnected,
    Error,
    Unavailable, // DAT SDK not available at runtime
}

/**
 * Manages Meta Ray-Ban glasses connection via the DAT SDK (MWDAT v0.5.0).
 *
 * The DAT SDK provides device discovery, registration, and camera streaming.
 * It does NOT expose touchpad gesture events -- push-to-talk is triggered via
 * the on-screen button or hardware volume key instead.
 *
 * All SDK calls use reflection so the app compiles and runs even when the
 * SDK dependency is absent (e.g. no GITHUB_TOKEN). When the SDK is missing,
 * the manager operates in standalone mode using the phone's own mic/speaker.
 *
 * SDK requirements:
 * - Android 10+ (API 29+)
 * - Meta AI companion app installed with Developer Mode enabled
 * - GITHUB_TOKEN for pulling SDK from GitHub Packages
 * - Supported: Ray-Ban Meta Gen 1 & Gen 2, Oakley Meta HSTN
 */
class GlassesManager(
    @Suppress("unused") private val context: Context,
    private val scope: CoroutineScope,
) {
    companion object {
        private const val TAG = "GlassesManager"
        private const val WEARABLES_CLASS = "com.meta.wearable.dat.core.Wearables"

        /** Whether the DAT SDK classes are available at runtime. */
        val isDatSdkAvailable: Boolean by lazy {
            try {
                Class.forName(WEARABLES_CLASS)
                true
            } catch (_: ClassNotFoundException) {
                false
            }
        }

        /**
         * Initialize the DAT SDK. Must be called from Application.onCreate()
         * before any other Wearables API calls.
         */
        fun initializeSdk(context: Context) {
            if (!isDatSdkAvailable) {
                Log.w(TAG, "DAT SDK not available -- running in standalone mode (phone mic/speaker)")
                return
            }
            try {
                val wearablesClass = Class.forName(WEARABLES_CLASS)
                val initMethod = wearablesClass.getMethod("initialize", Context::class.java)
                initMethod.invoke(null, context)
                Log.i(TAG, "DAT SDK initialized successfully")
            } catch (e: Exception) {
                Log.e(TAG, "Failed to initialize DAT SDK", e)
            }
        }
    }

    private val _state = MutableStateFlow(GlassesState.NotInitialized)
    val state: StateFlow<GlassesState> = _state.asStateFlow()

    /** Touchpad tap events -- timestamp of last tap (0L = no tap yet). */
    private val _touchpadTapEvents = MutableStateFlow(0L)
    val touchpadTapEvents: StateFlow<Long> = _touchpadTapEvents.asStateFlow()

    /** The display name of the connected device, if any. */
    private val _deviceName = MutableStateFlow<String?>(null)
    val deviceName: StateFlow<String?> = _deviceName.asStateFlow()

    // DAT SDK objects held by reference (reflection-created)
    private var deviceSelector: Any? = null
    private var linkStateJob: Job? = null

    /**
     * Start the glasses manager. Checks SDK availability, observes
     * registration state and device connectivity.
     */
    fun initialize() {
        if (!isDatSdkAvailable) {
            _state.value = GlassesState.Unavailable
            return
        }

        try {
            observeRegistrationState()
        } catch (e: Exception) {
            Log.e(TAG, "Failed to start GlassesManager", e)
            _state.value = GlassesState.Error
        }
    }

    /**
     * Trigger the DAT registration flow. Opens the Meta AI app for
     * permission consent. Call from an Activity context.
     */
    fun startRegistration(activity: Activity) {
        if (!isDatSdkAvailable) return
        try {
            val wearablesClass = Class.forName(WEARABLES_CLASS)
            val method = wearablesClass.getMethod("startRegistration", Activity::class.java)
            method.invoke(null, activity)
        } catch (e: Exception) {
            Log.e(TAG, "Failed to start registration", e)
            _state.value = GlassesState.Error
        }
    }

    /** Start scanning for paired glasses via AutoDeviceSelector. */
    fun startDiscovery() {
        if (!isDatSdkAvailable) return
        _state.value = GlassesState.Searching

        try {
            val selectorClass = Class.forName(
                "com.meta.wearable.dat.core.selectors.AutoDeviceSelector"
            )
            val selector = selectorClass.getDeclaredConstructor().newInstance()
            deviceSelector = selector
            observeActiveDevice(selector)
        } catch (e: Exception) {
            Log.e(TAG, "Failed to start device discovery", e)
            _state.value = GlassesState.Error
        }
    }

    /** Clean up DAT SDK resources. */
    fun release() {
        linkStateJob?.cancel()
        linkStateJob = null
        deviceSelector = null
        if (_state.value != GlassesState.Unavailable) {
            _state.value = GlassesState.Disconnected
        }
    }

    /**
     * Simulate a touchpad tap (for testing without glasses hardware).
     * Also used by the volume-button PTT trigger since the DAT SDK
     * does not expose touchpad gesture events.
     */
    fun simulateTap() {
        _touchpadTapEvents.value = System.currentTimeMillis()
    }

    // --- Private DAT SDK observation (all via reflection) ---

    private fun observeRegistrationState() {
        scope.launch {
            try {
                val wearablesClass = Class.forName(WEARABLES_CLASS)
                val regStateGetter = wearablesClass.getMethod("getRegistrationState")
                @Suppress("UNCHECKED_CAST")
                val regStateFlow = regStateGetter.invoke(null) as Flow<Any>

                regStateFlow.collect { regState ->
                    val stateName = regState.toString()
                    Log.d(TAG, "Registration state: $stateName")
                    when (stateName) {
                        "REGISTERED" -> {
                            if (_state.value != GlassesState.Connected &&
                                _state.value != GlassesState.Connecting
                            ) {
                                startDiscovery()
                            }
                        }
                        "NOT_REGISTERED" -> {
                            _state.value = GlassesState.NotRegistered
                        }
                    }
                }
            } catch (e: Exception) {
                Log.e(TAG, "Failed to observe registration state", e)
                _state.value = GlassesState.Error
            }
        }
    }

    private fun observeActiveDevice(selector: Any) {
        scope.launch {
            try {
                val activeDeviceGetter = selector.javaClass.getMethod("getActiveDevice")
                @Suppress("UNCHECKED_CAST")
                val activeDeviceFlow = activeDeviceGetter.invoke(selector) as Flow<Any?>

                activeDeviceFlow.collect { device ->
                    if (device != null) {
                        Log.i(TAG, "Active device: $device")
                        _deviceName.value = device.toString()
                        observeDeviceLinkState(device)
                    } else {
                        Log.d(TAG, "No active device")
                        _deviceName.value = null
                        if (_state.value == GlassesState.Connected ||
                            _state.value == GlassesState.Connecting
                        ) {
                            _state.value = GlassesState.Searching
                        }
                    }
                }
            } catch (e: Exception) {
                Log.e(TAG, "Failed to observe active device", e)
                _state.value = GlassesState.Error
            }
        }
    }

    private fun observeDeviceLinkState(device: Any) {
        linkStateJob?.cancel()
        linkStateJob = scope.launch {
            try {
                val linkStateGetter = device.javaClass.getMethod("getLinkState")
                @Suppress("UNCHECKED_CAST")
                val linkStateFlow = linkStateGetter.invoke(device) as Flow<Any>

                linkStateFlow.collect { linkState ->
                    val stateName = linkState.toString()
                    Log.d(TAG, "Device link state: $stateName")
                    _state.value = when (stateName) {
                        "CONNECTED" -> GlassesState.Connected
                        "CONNECTING" -> GlassesState.Connecting
                        "DISCONNECTED" -> GlassesState.Disconnected
                        else -> GlassesState.Disconnected
                    }
                }
            } catch (e: Exception) {
                Log.e(TAG, "Failed to observe device link state", e)
                _state.value = GlassesState.Error
            }
        }
    }
}

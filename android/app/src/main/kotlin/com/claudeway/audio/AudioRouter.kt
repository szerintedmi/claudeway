package com.claudeway.audio

import android.content.Context
import android.media.AudioDeviceCallback
import android.media.AudioDeviceInfo
import android.media.AudioManager
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.util.Log
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.SharedFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asSharedFlow
import kotlinx.coroutines.flow.asStateFlow

private const val TAG = "AudioRouter"

class AudioRouter(context: Context, scope: CoroutineScope) {
    private val audioManager = context.getSystemService(Context.AUDIO_SERVICE) as AudioManager
    private val routeController = CommunicationRouteController(
        audioManager = audioManager,
        scope = scope,
        onRoutingChanged = { updateActiveRoute() },
    )

    val state: StateFlow<AudioRouteState> = routeController.state

    private val _selectedRouteId = MutableStateFlow(AUTO_ROUTE_ID)
    val selectedRouteId: StateFlow<Int> = _selectedRouteId.asStateFlow()

    private val _availableRoutes = MutableStateFlow<List<AudioDevice>>(emptyList())
    val availableRoutes: StateFlow<List<AudioDevice>> = _availableRoutes.asStateFlow()

    private val _activeRouteId = MutableStateFlow<Int?>(PHONE_SPEAKER_ROUTE_ID)
    val activeRouteId: StateFlow<Int?> = _activeRouteId.asStateFlow()

    private val _toasts = MutableSharedFlow<DeviceToast>(extraBufferCapacity = 4)
    val toasts: SharedFlow<DeviceToast> = _toasts.asSharedFlow()

    private var currentBuiltInRouteId: Int = PHONE_SPEAKER_ROUTE_ID

    private val deviceCallback = object : AudioDeviceCallback() {
        override fun onAudioDevicesAdded(addedDevices: Array<out AudioDeviceInfo>) {
            Log.d(TAG, "Audio devices added: ${addedDevices.map { "${routeDeviceTypeName(it.type)} (${it.productName})" }}")
            val btAdded = addedDevices.firstOrNull { it.isBtDevice() }
            if (btAdded != null &&
                (_selectedRouteId.value == PHONE_SPEAKER_ROUTE_ID || _selectedRouteId.value == EARPIECE_ROUTE_ID)
            ) {
                _toasts.tryEmit(DeviceToast("${btAdded.productName} connected — switch route if you want to use it."))
            }
            refreshAvailableRoutes()
            refreshRouting()
        }

        override fun onAudioDevicesRemoved(removedDevices: Array<out AudioDeviceInfo>) {
            Log.d(TAG, "Audio devices removed: ${removedDevices.map { "${routeDeviceTypeName(it.type)} (${it.productName})" }}")
            val removedIds = removedDevices.map { it.id }.toSet()
            if (_selectedRouteId.value in removedIds) {
                _selectedRouteId.value = AUTO_ROUTE_ID
                _toasts.tryEmit(DeviceToast("Headset disconnected — switched to Automatic."))
            }
            refreshAvailableRoutes()
            refreshRouting()
        }
    }

    init {
        routeController.initializeForApiLevel()
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
            audioManager.registerAudioDeviceCallback(deviceCallback, Handler(Looper.getMainLooper()))
            refreshAvailableRoutes()
            refreshRouting()
        }
    }

    fun applyRouteSelection(routeId: Int) {
        _selectedRouteId.value = routeId
        Log.d(TAG, "Selected route id=$routeId")
        refreshRouting()
        refreshAvailableRoutes()
    }

    fun startSession() {
        routeController.startSession()
        refreshAvailableRoutes()
        refreshRouting()
    }

    fun endSession() {
        routeController.endSession(::setBuiltInRoute)
        refreshAvailableRoutes()
    }

    fun destroy() {
        routeController.destroy()
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
            audioManager.unregisterAudioDeviceCallback(deviceCallback)
        }
        currentBuiltInRouteId = PHONE_SPEAKER_ROUTE_ID
        _activeRouteId.value = PHONE_SPEAKER_ROUTE_ID
    }

    val isRouted: Boolean
        get() = state.value == AudioRouteState.Routed

    val routedDevice: AudioDeviceInfo?
        get() = routeController.routedDevice()

    fun prepareCommunicationRoute(): AudioDeviceInfo? =
        routeController.prepareForCommunication(_selectedRouteId.value)

    private fun refreshAvailableRoutes() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.S) return
        _availableRoutes.value = buildAvailableRoutes(audioManager)
    }

    private fun refreshRouting() {
        routeController.refreshState(
            selectedRouteId = _selectedRouteId.value,
            onSelectedRouteMissing = { _selectedRouteId.value = AUTO_ROUTE_ID },
            onBuiltInRouteChanged = ::setBuiltInRoute,
        )
        updateActiveRoute()
    }

    private fun setBuiltInRoute(routeId: Int) {
        currentBuiltInRouteId = routeId
        updateActiveRoute()
    }

    private fun updateActiveRoute() {
        _activeRouteId.value = if (state.value == AudioRouteState.Routed && routedDevice != null) {
            routedDevice!!.id
        } else {
            currentBuiltInRouteId
        }
    }
}

package com.claudeway.glasses.audio

import android.content.Context
import android.media.AudioDeviceInfo
import android.media.AudioManager
import android.os.Build
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow

enum class AudioRouteState {
    NoDevice,
    Routing,
    Routed,
    Error,
    UnsupportedApi, // API 31+ required for communication device routing
}

class AudioRouter(context: Context) {
    private val audioManager = context.getSystemService(Context.AUDIO_SERVICE) as AudioManager

    private val _state = MutableStateFlow(AudioRouteState.NoDevice)
    val state: StateFlow<AudioRouteState> = _state.asStateFlow()

    private var currentDevice: AudioDeviceInfo? = null

    /** Find a Bluetooth SCO device (glasses or headset) from available communication devices. */
    fun findScoDevice(): AudioDeviceInfo? {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.S) {
            _state.value = AudioRouteState.UnsupportedApi
            return null
        }
        return audioManager.availableCommunicationDevices.firstOrNull { device ->
            device.type == AudioDeviceInfo.TYPE_BLUETOOTH_SCO
        }
    }

    /** Route audio to the given Bluetooth SCO device. */
    fun routeToDevice(device: AudioDeviceInfo): Boolean {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.S) {
            _state.value = AudioRouteState.UnsupportedApi
            return false
        }
        _state.value = AudioRouteState.Routing
        val success = audioManager.setCommunicationDevice(device)
        if (success) {
            currentDevice = device
            _state.value = AudioRouteState.Routed
        } else {
            _state.value = AudioRouteState.Error
        }
        return success
    }

    /** Attempt to find and route to a Bluetooth SCO device. */
    fun routeToGlasses(): Boolean {
        val device = findScoDevice() ?: run {
            if (_state.value != AudioRouteState.UnsupportedApi) {
                _state.value = AudioRouteState.NoDevice
            }
            return false
        }
        return routeToDevice(device)
    }

    /** Release the audio route back to default. */
    fun release() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
            audioManager.clearCommunicationDevice()
        }
        currentDevice = null
        _state.value = AudioRouteState.NoDevice
    }

    /** Check if currently routed to a Bluetooth SCO device. */
    val isRouted: Boolean
        get() = _state.value == AudioRouteState.Routed
}

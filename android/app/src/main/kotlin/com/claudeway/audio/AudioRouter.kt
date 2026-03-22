package com.claudeway.audio

import android.content.Context
import android.media.AudioDeviceCallback
import android.media.AudioDeviceInfo
import android.media.AudioManager
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.util.Log
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow

private const val TAG = "AudioRouter"

enum class AudioRouteState {
    NoDevice,
    Available,  // SCO device found, not yet routed
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

    private val deviceCallback = object : AudioDeviceCallback() {
        override fun onAudioDevicesAdded(addedDevices: Array<out AudioDeviceInfo>) {
            Log.d(TAG, "Audio devices added: ${addedDevices.map { "${deviceTypeName(it.type)} (${it.productName})" }}")
            refreshState()
        }

        override fun onAudioDevicesRemoved(removedDevices: Array<out AudioDeviceInfo>) {
            Log.d(TAG, "Audio devices removed: ${removedDevices.map { "${deviceTypeName(it.type)} (${it.productName})" }}")
            refreshState()
        }
    }

    init {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.S) {
            _state.value = AudioRouteState.UnsupportedApi
            Log.w(TAG, "API ${Build.VERSION.SDK_INT} < 31 — setCommunicationDevice not available")
        } else {
            // Register for device connect/disconnect events
            audioManager.registerAudioDeviceCallback(deviceCallback, Handler(Looper.getMainLooper()))
            // Probe initial state
            refreshState()
        }
    }

    /**
     * Re-check available SCO devices and update state.
     * Called on init and on device connect/disconnect.
     */
    private fun refreshState() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.S) return

        // If currently routed, check if the routed device is still available
        if (_state.value == AudioRouteState.Routed) {
            val stillAvailable = currentDevice?.let { routed ->
                audioManager.availableCommunicationDevices.any {
                    it.type == AudioDeviceInfo.TYPE_BLUETOOTH_SCO && it.id == routed.id
                }
            } ?: false
            if (!stillAvailable) {
                Log.d(TAG, "Routed device disconnected")
                currentDevice = null
                // Fall through to check if another SCO device is available
            } else {
                return // Still routed, nothing to update
            }
        }

        val hasSco = audioManager.availableCommunicationDevices.any {
            it.type == AudioDeviceInfo.TYPE_BLUETOOTH_SCO
        }
        _state.value = if (hasSco) AudioRouteState.Available else AudioRouteState.NoDevice
    }

    /** Find a Bluetooth SCO device (glasses or headset) from available communication devices. */
    fun findScoDevice(): AudioDeviceInfo? {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.S) {
            return null
        }
        val devices = audioManager.availableCommunicationDevices
        Log.d(TAG, "Available communication devices (${devices.size}):")
        devices.forEach { device ->
            Log.d(TAG, "  - type=${device.type} (${deviceTypeName(device.type)}), " +
                "name=${device.productName}, id=${device.id}")
        }
        val scoDevice = devices.firstOrNull { it.type == AudioDeviceInfo.TYPE_BLUETOOTH_SCO }
        if (scoDevice != null) {
            Log.d(TAG, "Found SCO device: ${scoDevice.productName}")
        } else {
            Log.d(TAG, "No SCO device found")
        }
        return scoDevice
    }

    private fun deviceTypeName(type: Int): String = when (type) {
        AudioDeviceInfo.TYPE_BUILTIN_EARPIECE -> "BUILTIN_EARPIECE"
        AudioDeviceInfo.TYPE_BUILTIN_SPEAKER -> "BUILTIN_SPEAKER"
        AudioDeviceInfo.TYPE_BLUETOOTH_SCO -> "BLUETOOTH_SCO"
        AudioDeviceInfo.TYPE_BLUETOOTH_A2DP -> "BLUETOOTH_A2DP"
        AudioDeviceInfo.TYPE_BLE_HEADSET -> "BLE_HEADSET"
        AudioDeviceInfo.TYPE_BLE_SPEAKER -> "BLE_SPEAKER"
        AudioDeviceInfo.TYPE_WIRED_HEADSET -> "WIRED_HEADSET"
        AudioDeviceInfo.TYPE_USB_DEVICE -> "USB_DEVICE"
        else -> "UNKNOWN($type)"
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
            Log.d(TAG, "Routed audio to: ${device.productName}")
        } else {
            _state.value = AudioRouteState.Error
            Log.e(TAG, "Failed to route audio to: ${device.productName}")
        }
        return success
    }

    /** Attempt to find and route to a Bluetooth SCO device. */
    fun routeToBluetooth(): Boolean {
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
            audioManager.unregisterAudioDeviceCallback(deviceCallback)
        }
        currentDevice = null
        _state.value = AudioRouteState.NoDevice
    }

    /** Check if currently routed to a Bluetooth SCO device. */
    val isRouted: Boolean
        get() = _state.value == AudioRouteState.Routed
}

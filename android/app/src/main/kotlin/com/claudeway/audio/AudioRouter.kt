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

/** Check if a device is a Bluetooth headset (classic SCO or BLE). */
private fun AudioDeviceInfo.isBtDevice(): Boolean =
    type == AudioDeviceInfo.TYPE_BLUETOOTH_SCO || type == AudioDeviceInfo.TYPE_BLE_HEADSET

class AudioRouter(context: Context) {
    private val audioManager = context.getSystemService(Context.AUDIO_SERVICE) as AudioManager

    private val _state = MutableStateFlow(AudioRouteState.NoDevice)
    val state: StateFlow<AudioRouteState> = _state.asStateFlow()

    private var currentDevice: AudioDeviceInfo? = null

    /** When true, auto-route to BT devices as they appear and enter communication mode. */
    private var sessionActive = false

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
            audioManager.registerAudioDeviceCallback(deviceCallback, Handler(Looper.getMainLooper()))
            refreshState()
        }
    }

    /**
     * Re-check available SCO devices and update state.
     * Auto-routes to BT only when a session is active.
     */
    private fun refreshState() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.S) return

        // If currently routed, check if the routed device is still available
        if (_state.value == AudioRouteState.Routed) {
            val stillAvailable = currentDevice?.let { routed ->
                audioManager.availableCommunicationDevices.any {
                    it.isBtDevice() && it.id == routed.id
                }
            } ?: false
            if (!stillAvailable) {
                Log.d(TAG, "Routed device disconnected")
                audioManager.clearCommunicationDevice()
                audioManager.mode = AudioManager.MODE_NORMAL
                currentDevice = null
                // Fall through to check if another SCO device is available
            } else {
                return // Still routed, nothing to update
            }
        }

        val scoDevice = audioManager.availableCommunicationDevices.firstOrNull { it.isBtDevice() }
        if (scoDevice != null && sessionActive) {
            Log.d(TAG, "Auto-routing to BT device: ${scoDevice.productName}")
            routeToDevice(scoDevice)
        } else {
            _state.value = if (scoDevice != null) AudioRouteState.Available else AudioRouteState.NoDevice
        }
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
        val scoDevice = devices.firstOrNull { it.isBtDevice() }
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

    /** Route audio to the given Bluetooth SCO device. Sets MODE_IN_COMMUNICATION for the session. */
    fun routeToDevice(device: AudioDeviceInfo): Boolean {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.S) {
            _state.value = AudioRouteState.UnsupportedApi
            return false
        }
        _state.value = AudioRouteState.Routing
        // Mode must be set BEFORE setCommunicationDevice for reliable SCO activation
        audioManager.mode = AudioManager.MODE_IN_COMMUNICATION
        Log.d(TAG, "Audio mode -> MODE_IN_COMMUNICATION")
        val success = audioManager.setCommunicationDevice(device)
        if (success) {
            currentDevice = device
            _state.value = AudioRouteState.Routed
            Log.d(TAG, "Routed audio to: ${device.productName}")
        } else {
            audioManager.mode = AudioManager.MODE_NORMAL
            _state.value = AudioRouteState.Error
            Log.e(TAG, "Failed to route audio to: ${device.productName}")
        }
        return success
    }

    /**
     * Start a session: find and route to a Bluetooth SCO device.
     * Enables auto-routing so late-arriving BT devices are picked up.
     */
    fun startSession(): Boolean {
        sessionActive = true
        return routeToBluetooth()
    }

    /**
     * End the session: release the audio route and stop auto-routing.
     * The device callback stays registered for future sessions.
     */
    fun endSession() {
        sessionActive = false
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
            audioManager.clearCommunicationDevice()
            audioManager.mode = AudioManager.MODE_NORMAL
            Log.d(TAG, "Audio mode -> MODE_NORMAL (endSession)")
        }
        currentDevice = null
        _state.value = if (findScoDevice() != null) AudioRouteState.Available else AudioRouteState.NoDevice
    }

    /** Attempt to find and route to a Bluetooth SCO device. */
    private fun routeToBluetooth(): Boolean {
        val device = findScoDevice() ?: run {
            if (_state.value != AudioRouteState.UnsupportedApi) {
                _state.value = AudioRouteState.NoDevice
            }
            return false
        }
        return routeToDevice(device)
    }

    /** Full teardown — call from ViewModel.onCleared() only. */
    fun destroy() {
        sessionActive = false
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
            audioManager.clearCommunicationDevice()
            audioManager.mode = AudioManager.MODE_NORMAL
            audioManager.unregisterAudioDeviceCallback(deviceCallback)
        }
        currentDevice = null
        _state.value = AudioRouteState.NoDevice
    }

    /** Check if currently routed to a Bluetooth SCO device. */
    val isRouted: Boolean
        get() = _state.value == AudioRouteState.Routed

    /** The currently routed device, or null if not routed. */
    val routedDevice: AudioDeviceInfo?
        get() = if (isRouted) currentDevice else null
}

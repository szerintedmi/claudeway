package com.claudeway.audio

import android.content.Context
import android.media.AudioAttributes
import android.media.AudioDeviceCallback
import android.media.AudioDeviceInfo
import android.media.AudioFormat
import android.media.AudioManager
import android.media.AudioTrack
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.util.Log
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext

private const val TAG = "AudioRouter"

/** Max attempts to establish a verified SCO route. */
private const val MAX_ROUTE_ATTEMPTS = 3

/** How long to let the probe AudioTrack run before checking playbackHeadPosition. */
private const val PROBE_SETTLE_MS = 150L

/** Delay between route retry attempts. */
private const val RETRY_DELAY_MS = 300L

/** Probe AudioTrack sample rate — matches typical SCO. */
private const val PROBE_SAMPLE_RATE = 16000

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

class AudioRouter(context: Context, private val scope: CoroutineScope) {
    private val audioManager = context.getSystemService(Context.AUDIO_SERVICE) as AudioManager

    private val _state = MutableStateFlow(AudioRouteState.NoDevice)
    val state: StateFlow<AudioRouteState> = _state.asStateFlow()

    private var currentDevice: AudioDeviceInfo? = null
    private var routeVerifyJob: Job? = null

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
                routeVerifyJob?.cancel()
                audioManager.clearCommunicationDevice()
                audioManager.mode = AudioManager.MODE_NORMAL
                currentDevice = null
                // Fall through to check if another SCO device is available
            } else {
                return // Still routed, nothing to update
            }
        }

        // Cancel any in-progress verification if we're re-evaluating
        if (_state.value == AudioRouteState.Routing) {
            routeVerifyJob?.cancel()
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

    /**
     * Route audio to the given Bluetooth SCO device.
     * Sets MODE_IN_COMMUNICATION, calls setCommunicationDevice, then verifies the SCO
     * output is actually functional using a probe AudioTrack. Retries up to [MAX_ROUTE_ATTEMPTS]
     * times with clear+reset between attempts.
     *
     * State transitions: Routing → Routed (on verified success) or Error (on failure).
     * Callers should observe [state] for the definitive result — [routedDevice] is null
     * until verification completes and state reaches [AudioRouteState.Routed].
     */
    fun routeToDevice(device: AudioDeviceInfo) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.S) {
            _state.value = AudioRouteState.UnsupportedApi
            return
        }

        routeVerifyJob?.cancel()
        _state.value = AudioRouteState.Routing
        currentDevice = device

        routeVerifyJob = scope.launch {
            for (attempt in 1..MAX_ROUTE_ATTEMPTS) {
                val applied = withContext(Dispatchers.Main) {
                    if (attempt > 1) {
                        Log.d(TAG, "Route verify retry $attempt/$MAX_ROUTE_ATTEMPTS")
                    }
                    applyRoute(device)
                }

                if (!applied) {
                    Log.e(TAG, "setCommunicationDevice failed on attempt $attempt")
                    if (attempt < MAX_ROUTE_ATTEMPTS) {
                        delay(RETRY_DELAY_MS)
                        continue
                    }
                    break
                }

                delay(PROBE_SETTLE_MS) // Let SCO link establish

                if (probeScoOutput(device)) {
                    Log.d(TAG, "Route verified on attempt $attempt — SCO output functional")
                    _state.value = AudioRouteState.Routed
                    return@launch
                }

                Log.w(TAG, "Route probe failed on attempt $attempt/$MAX_ROUTE_ATTEMPTS")
                if (attempt < MAX_ROUTE_ATTEMPTS) {
                    delay(RETRY_DELAY_MS)
                }
            }

            Log.e(TAG, "SCO output not functional after $MAX_ROUTE_ATTEMPTS attempts")
            currentDevice = null
            withContext(Dispatchers.Main) {
                audioManager.clearCommunicationDevice()
                audioManager.mode = AudioManager.MODE_NORMAL
            }
            _state.value = AudioRouteState.Error
        }
    }

    /**
     * Apply the communication device route: clear → MODE_NORMAL → MODE_IN_COMMUNICATION → set.
     * Returns true if setCommunicationDevice() succeeded (does NOT mean audio is functional).
     * Caller must ensure API >= 31.
     */
    @androidx.annotation.RequiresApi(Build.VERSION_CODES.S)
    private fun applyRoute(device: AudioDeviceInfo): Boolean {
        // Clear any existing route first — on some devices/headsets, going straight to
        // setCommunicationDevice without a prior clear leaves the SCO output non-functional.
        audioManager.clearCommunicationDevice()
        audioManager.mode = AudioManager.MODE_NORMAL
        // Mode must be set BEFORE setCommunicationDevice for reliable SCO activation
        audioManager.mode = AudioManager.MODE_IN_COMMUNICATION
        Log.d(TAG, "Audio mode -> MODE_IN_COMMUNICATION")
        val success = audioManager.setCommunicationDevice(device)
        if (success) {
            Log.d(TAG, "setCommunicationDevice(${device.productName}) -> true")
        } else {
            audioManager.mode = AudioManager.MODE_NORMAL
            Log.e(TAG, "setCommunicationDevice(${device.productName}) -> false")
        }
        return success
    }

    /**
     * Probe whether the route lands on the expected SCO device.
     *
     * Some headsets keep reporting playbackHeadPosition=0 for short silent probe writes even when
     * the route is already correct, so target-device routing is treated as the source of truth.
     */
    private suspend fun probeScoOutput(targetDevice: AudioDeviceInfo): Boolean = withContext(Dispatchers.IO) {
        val bufferSize = AudioTrack.getMinBufferSize(
            PROBE_SAMPLE_RATE,
            AudioFormat.CHANNEL_OUT_MONO,
            AudioFormat.ENCODING_PCM_16BIT,
        )

        val track = try {
            AudioTrack.Builder()
                .setAudioAttributes(
                    AudioAttributes.Builder()
                        .setUsage(AudioAttributes.USAGE_VOICE_COMMUNICATION)
                        .setContentType(AudioAttributes.CONTENT_TYPE_SPEECH)
                        .build()
                )
                .setAudioFormat(
                    AudioFormat.Builder()
                        .setSampleRate(PROBE_SAMPLE_RATE)
                        .setChannelMask(AudioFormat.CHANNEL_OUT_MONO)
                        .setEncoding(AudioFormat.ENCODING_PCM_16BIT)
                        .build()
                )
                .setBufferSizeInBytes(bufferSize)
                .setTransferMode(AudioTrack.MODE_STREAM)
                .build()
        } catch (e: Exception) {
            Log.e(TAG, "Failed to create probe AudioTrack", e)
            return@withContext false
        }

        try {
            track.setPreferredDevice(targetDevice)
            track.play()
            // Write ~100ms of silence at 16kHz mono 16-bit = 3200 bytes
            val silence = ByteArray(PROBE_SAMPLE_RATE / 10 * 2)
            val written = track.write(silence, 0, silence.size)
            if (written < 0) {
                Log.w(TAG, "Probe write failed: $written")
                return@withContext false
            }
            delay(PROBE_SETTLE_MS)
            val headPos = track.playbackHeadPosition
            val actualDevice = track.routedDevice
            val onTarget = actualDevice?.id == targetDevice.id
            Log.d(TAG, "Probe result: headPos=$headPos, " +
                "device=${actualDevice?.productName} (${deviceTypeName(actualDevice?.type)}), " +
                "onTarget=$onTarget (expected id=${targetDevice.id}, actual id=${actualDevice?.id})")
            if (onTarget && headPos == 0) {
                Log.d(TAG, "Probe accepted despite headPos=0 because routing is on target device")
            }
            onTarget
        } finally {
            try {
                track.stop()
                track.release()
            } catch (_: IllegalStateException) {}
        }
    }

    /**
     * Start a session: find and route to a Bluetooth SCO device.
     * Enables auto-routing so late-arriving BT devices are picked up.
     * Observe [state] for the result — route verification is async.
     */
    fun startSession() {
        sessionActive = true
        routeToBluetooth()
    }

    /**
     * End the session: release the audio route and stop auto-routing.
     * The device callback stays registered for future sessions.
     */
    fun endSession() {
        sessionActive = false
        routeVerifyJob?.cancel()
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
            audioManager.clearCommunicationDevice()
            audioManager.mode = AudioManager.MODE_NORMAL
            Log.d(TAG, "Audio mode -> MODE_NORMAL (endSession)")
        }
        currentDevice = null
        _state.value = if (findScoDevice() != null) AudioRouteState.Available else AudioRouteState.NoDevice
    }

    /** Attempt to find and route to a Bluetooth SCO device. */
    private fun routeToBluetooth() {
        val device = findScoDevice() ?: run {
            if (_state.value != AudioRouteState.UnsupportedApi) {
                _state.value = AudioRouteState.NoDevice
            }
            return
        }
        routeToDevice(device)
    }

    /** Full teardown — call from ViewModel.onCleared() only. */
    fun destroy() {
        sessionActive = false
        routeVerifyJob?.cancel()
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

    /** The current or pending SCO device. Non-null during both Routing (verification in progress)
     *  and Routed states, so AudioPlayer/AudioRecorder can pin to the target device early. */
    val routedDevice: AudioDeviceInfo?
        get() = when (_state.value) {
            AudioRouteState.Routing, AudioRouteState.Routed -> currentDevice
            else -> null
        }
}

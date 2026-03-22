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
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.SharedFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asSharedFlow
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

const val AUTO_ROUTE_ID = -1
const val PHONE_SPEAKER_ROUTE_ID = -2
const val EARPIECE_ROUTE_ID = -3

enum class AudioRouteState {
    NoDevice,
    Available,
    Routing,
    Routed,
    Error,
    UnsupportedApi,
}

/** A simplified route descriptor for the UI layer. */
data class AudioDevice(
    val id: Int,
    val name: String,
    val type: Int,
    val productName: String,
    val iconOverride: String? = null,
) {
    val icon: String get() = iconOverride ?: when (type) {
        AudioDeviceInfo.TYPE_UNKNOWN -> "auto"
        AudioDeviceInfo.TYPE_BUILTIN_SPEAKER -> "smartphone"
        AudioDeviceInfo.TYPE_BLUETOOTH_SCO, AudioDeviceInfo.TYPE_BLE_HEADSET -> "headphones"
        else -> "smartphone"
    }

    val subtitle: String? get() {
        val prod = productName.trim()
        return if (prod.isNotEmpty() && prod != name) prod else null
    }
}

data class DeviceToast(val message: String)

private fun AudioDeviceInfo.isBtDevice(): Boolean =
    type == AudioDeviceInfo.TYPE_BLUETOOTH_SCO || type == AudioDeviceInfo.TYPE_BLE_HEADSET

private fun friendlyDeviceName(type: Int?): String = when (type) {
    AudioDeviceInfo.TYPE_BLUETOOTH_SCO -> "Connected Headset"
    AudioDeviceInfo.TYPE_BLE_HEADSET -> "Connected Headset"
    else -> "Audio Device"
}

private fun AudioDeviceInfo.toRouteOption(): AudioDevice = AudioDevice(
    id = id,
    name = friendlyDeviceName(type),
    type = type,
    productName = productName?.toString() ?: "",
    iconOverride = "headphones",
)

class AudioRouter(context: Context, private val scope: CoroutineScope) {
    private val audioManager = context.getSystemService(Context.AUDIO_SERVICE) as AudioManager

    private val _state = MutableStateFlow(AudioRouteState.NoDevice)
    val state: StateFlow<AudioRouteState> = _state.asStateFlow()

    private val _selectedRouteId = MutableStateFlow(AUTO_ROUTE_ID)
    val selectedRouteId: StateFlow<Int> = _selectedRouteId.asStateFlow()

    private val _availableRoutes = MutableStateFlow<List<AudioDevice>>(emptyList())
    val availableRoutes: StateFlow<List<AudioDevice>> = _availableRoutes.asStateFlow()

    private val _activeRouteId = MutableStateFlow<Int?>(PHONE_SPEAKER_ROUTE_ID)
    val activeRouteId: StateFlow<Int?> = _activeRouteId.asStateFlow()

    private val _toasts = MutableSharedFlow<DeviceToast>(extraBufferCapacity = 4)
    val toasts: SharedFlow<DeviceToast> = _toasts.asSharedFlow()

    private var currentDevice: AudioDeviceInfo? = null
    private var currentBuiltInRouteId: Int = PHONE_SPEAKER_ROUTE_ID
    private var routeVerifyJob: Job? = null
    private var sessionActive = false

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
            refreshState()
        }

        override fun onAudioDevicesRemoved(removedDevices: Array<out AudioDeviceInfo>) {
            Log.d(TAG, "Audio devices removed: ${removedDevices.map { "${routeDeviceTypeName(it.type)} (${it.productName})" }}")
            val removedIds = removedDevices.map { it.id }.toSet()
            if (_selectedRouteId.value in removedIds) {
                _selectedRouteId.value = AUTO_ROUTE_ID
                _toasts.tryEmit(DeviceToast("Headset disconnected — switched to Automatic."))
            }
            refreshAvailableRoutes()
            refreshState()
        }
    }

    init {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.S) {
            _state.value = AudioRouteState.UnsupportedApi
            Log.w(TAG, "API ${Build.VERSION.SDK_INT} < 31 — setCommunicationDevice not available")
        } else {
            audioManager.registerAudioDeviceCallback(deviceCallback, Handler(Looper.getMainLooper()))
            refreshAvailableRoutes()
            refreshState()
        }
    }

    private fun refreshAvailableRoutes() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.S) return

        val routes = mutableListOf(
            AudioDevice(
                id = AUTO_ROUTE_ID,
                name = "Automatic",
                type = AudioDeviceInfo.TYPE_UNKNOWN,
                productName = "Use connected headset when available, otherwise phone speaker",
                iconOverride = "auto",
            )
        )

        audioManager.availableCommunicationDevices
            .filter { it.isBtDevice() }
            .forEach { routes.add(it.toRouteOption()) }

        routes.add(
            AudioDevice(
                id = PHONE_SPEAKER_ROUTE_ID,
                name = "Phone Speaker",
                type = AudioDeviceInfo.TYPE_BUILTIN_SPEAKER,
                productName = "Built-in speaker with built-in microphone",
                iconOverride = "smartphone",
            )
        )

        if (audioManager.availableCommunicationDevices.any { it.type == AudioDeviceInfo.TYPE_BUILTIN_EARPIECE }) {
            routes.add(
                AudioDevice(
                    id = EARPIECE_ROUTE_ID,
                    name = "Earpiece",
                    type = AudioDeviceInfo.TYPE_BUILTIN_EARPIECE,
                    productName = "Earpiece with built-in microphone",
                    iconOverride = "earpiece",
                )
            )
        }

        _availableRoutes.value = routes
    }

    fun applyRouteSelection(routeId: Int) {
        _selectedRouteId.value = routeId
        Log.d(TAG, "Selected route id=$routeId")
        if (sessionActive) {
            refreshState()
        } else {
            updateActiveRoute()
        }
        refreshAvailableRoutes()
    }

    private fun updateActiveRoute() {
        _activeRouteId.value = if (_state.value == AudioRouteState.Routed && currentDevice != null) {
            currentDevice!!.id
        } else {
            currentBuiltInRouteId
        }
    }

    private fun applySelectedRouting() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.S) return

        val selectedId = _selectedRouteId.value
        val commDevices = audioManager.availableCommunicationDevices

        when (selectedId) {
            AUTO_ROUTE_ID -> {
                routeToBluetoothOrPhone()
            }

            PHONE_SPEAKER_ROUTE_ID -> {
                routeToBuiltIn(commDevices, AudioDeviceInfo.TYPE_BUILTIN_SPEAKER, PHONE_SPEAKER_ROUTE_ID)
            }

            EARPIECE_ROUTE_ID -> {
                routeToBuiltIn(commDevices, AudioDeviceInfo.TYPE_BUILTIN_EARPIECE, EARPIECE_ROUTE_ID)
            }

            else -> {
                val selectedBt = commDevices.firstOrNull { it.isBtDevice() && it.id == selectedId }
                if (selectedBt == null) {
                    Log.d(TAG, "Selected headset missing; reverting to automatic")
                    _selectedRouteId.value = AUTO_ROUTE_ID
                    routeToBluetoothOrPhone()
                } else if (_state.value != AudioRouteState.Routed || currentDevice?.id != selectedBt.id) {
                    routeToDevice(selectedBt)
                } else {
                    updateActiveRoute()
                }
            }
        }
    }

    private fun clearCommunicationRoute(commDevices: List<AudioDeviceInfo>) {
        audioManager.clearCommunicationDevice()
        audioManager.mode = AudioManager.MODE_NORMAL
        currentDevice = null
        currentBuiltInRouteId = PHONE_SPEAKER_ROUTE_ID
        _state.value = if (commDevices.any { it.isBtDevice() }) AudioRouteState.Available else AudioRouteState.NoDevice
        updateActiveRoute()
    }

    private fun routeToBuiltIn(commDevices: List<AudioDeviceInfo>, deviceType: Int, routeId: Int) {
        val target = commDevices.firstOrNull { it.type == deviceType }
        if (target == null) {
            clearCommunicationRoute(commDevices)
            return
        }

        audioManager.clearCommunicationDevice()
        audioManager.mode = AudioManager.MODE_NORMAL
        audioManager.mode = AudioManager.MODE_IN_COMMUNICATION
        val success = audioManager.setCommunicationDevice(target)
        if (!success) {
            Log.w(TAG, "Failed to force built-in route type=$deviceType; falling back to cleared route")
            clearCommunicationRoute(commDevices)
            return
        }

        currentDevice = null
        currentBuiltInRouteId = routeId
        _state.value = if (commDevices.any { it.isBtDevice() }) AudioRouteState.Available else AudioRouteState.NoDevice
        updateActiveRoute()
    }

    private fun refreshState() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.S) return

        if (!sessionActive) {
            _state.value = if (audioManager.availableCommunicationDevices.any { it.isBtDevice() }) {
                AudioRouteState.Available
            } else {
                AudioRouteState.NoDevice
            }
            updateActiveRoute()
            return
        }

        if (_state.value == AudioRouteState.Routed) {
            val stillAvailable = currentDevice?.let { routed ->
                audioManager.availableCommunicationDevices.any { it.isBtDevice() && it.id == routed.id }
            } ?: false
            if (!stillAvailable) {
                routeVerifyJob?.cancel()
                audioManager.clearCommunicationDevice()
                audioManager.mode = AudioManager.MODE_NORMAL
                currentDevice = null
            } else if (_selectedRouteId.value == AUTO_ROUTE_ID || _selectedRouteId.value == currentDevice?.id) {
                updateActiveRoute()
                return
            }
        }

        if (_state.value == AudioRouteState.Routing) {
            routeVerifyJob?.cancel()
        }

        applySelectedRouting()
    }

    fun findScoDevice(): AudioDeviceInfo? {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.S) return null
        return audioManager.availableCommunicationDevices.firstOrNull { it.isBtDevice() }
    }

    private fun routeToBluetoothOrPhone() {
        val btDevice = findScoDevice()
        if (btDevice == null) {
            routeToBuiltIn(
                commDevices = audioManager.availableCommunicationDevices,
                deviceType = AudioDeviceInfo.TYPE_BUILTIN_SPEAKER,
                routeId = PHONE_SPEAKER_ROUTE_ID,
            )
        } else {
            routeToDevice(btDevice)
        }
    }

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
                    if (attempt < MAX_ROUTE_ATTEMPTS) {
                        delay(RETRY_DELAY_MS)
                        continue
                    }
                    break
                }

                delay(PROBE_SETTLE_MS)

                if (probeScoOutput(device)) {
                    Log.d(TAG, "Route verified on attempt $attempt")
                    _state.value = AudioRouteState.Routed
                    updateActiveRoute()
                    return@launch
                }

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
            updateActiveRoute()
        }
    }

    @androidx.annotation.RequiresApi(Build.VERSION_CODES.S)
    private fun applyRoute(device: AudioDeviceInfo): Boolean {
        audioManager.clearCommunicationDevice()
        audioManager.mode = AudioManager.MODE_NORMAL
        audioManager.mode = AudioManager.MODE_IN_COMMUNICATION
        Log.d(TAG, "Audio mode -> MODE_IN_COMMUNICATION")
        val success = audioManager.setCommunicationDevice(device)
        if (!success) {
            audioManager.mode = AudioManager.MODE_NORMAL
            Log.e(TAG, "setCommunicationDevice(${device.productName}) -> false")
        }
        return success
    }

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
            val silence = ByteArray(PROBE_SAMPLE_RATE / 10 * 2)
            val written = track.write(silence, 0, silence.size)
            if (written < 0) {
                return@withContext false
            }
            delay(PROBE_SETTLE_MS)
            track.routedDevice?.id == targetDevice.id
        } finally {
            try {
                track.stop()
                track.release()
            } catch (_: IllegalStateException) {
            }
        }
    }

    fun startSession() {
        sessionActive = true
        refreshAvailableRoutes()
        refreshState()
    }

    fun endSession() {
        sessionActive = false
        routeVerifyJob?.cancel()
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
            audioManager.clearCommunicationDevice()
            audioManager.mode = AudioManager.MODE_NORMAL
            Log.d(TAG, "Audio mode -> MODE_NORMAL (endSession)")
        }
        currentDevice = null
        currentBuiltInRouteId = PHONE_SPEAKER_ROUTE_ID
        _state.value = if (findScoDevice() != null) AudioRouteState.Available else AudioRouteState.NoDevice
        updateActiveRoute()
    }

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
        currentBuiltInRouteId = PHONE_SPEAKER_ROUTE_ID
        _activeRouteId.value = PHONE_SPEAKER_ROUTE_ID
    }

    val isRouted: Boolean
        get() = _state.value == AudioRouteState.Routed

    val routedDevice: AudioDeviceInfo?
        get() = when (_state.value) {
            AudioRouteState.Routing, AudioRouteState.Routed -> currentDevice
            else -> null
        }
}

internal fun routeDeviceTypeName(type: Int?): String = when (type) {
    null -> "NONE"
    AudioDeviceInfo.TYPE_UNKNOWN -> "UNKNOWN"
    AudioDeviceInfo.TYPE_BUILTIN_SPEAKER -> "BUILTIN_SPEAKER"
    AudioDeviceInfo.TYPE_BUILTIN_EARPIECE -> "BUILTIN_EARPIECE"
    AudioDeviceInfo.TYPE_BLUETOOTH_SCO -> "BLUETOOTH_SCO"
    AudioDeviceInfo.TYPE_BLE_HEADSET -> "BLE_HEADSET"
    AudioDeviceInfo.TYPE_BLUETOOTH_A2DP -> "BLUETOOTH_A2DP"
    AudioDeviceInfo.TYPE_WIRED_HEADSET -> "WIRED_HEADSET"
    else -> "UNKNOWN($type)"
}

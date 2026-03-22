package com.claudeway.audio

import android.annotation.SuppressLint
import android.media.AudioAttributes
import android.media.AudioDeviceInfo
import android.media.AudioFormat
import android.media.AudioManager
import android.media.AudioTrack
import android.os.Build
import android.util.Log
import androidx.annotation.RequiresApi
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
private const val MAX_ROUTE_ATTEMPTS = 3
private const val PROBE_SETTLE_MS = 150L
private const val RETRY_DELAY_MS = 300L
private const val PROBE_SAMPLE_RATE = 16000

internal class CommunicationRouteController(
    private val audioManager: AudioManager,
    private val scope: CoroutineScope,
    private val onRoutingChanged: () -> Unit,
) {
    private val _state = MutableStateFlow(AudioRouteState.NoDevice)
    val state: StateFlow<AudioRouteState> = _state.asStateFlow()

    private var currentDevice: AudioDeviceInfo? = null
    private var routeVerifyJob: Job? = null
    private var sessionActive = false

    fun initializeForApiLevel() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.S) {
            _state.value = AudioRouteState.UnsupportedApi
            Log.w(TAG, "API ${Build.VERSION.SDK_INT} < 31 — setCommunicationDevice not available")
        } else {
            _state.value = availabilityState()
        }
        onRoutingChanged()
    }

    fun refreshState(
        selectedRouteId: Int,
        onSelectedRouteMissing: () -> Unit,
        onBuiltInRouteChanged: (Int) -> Unit,
    ) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.S) return

        if (!sessionActive) {
            _state.value = availabilityState()
            onRoutingChanged()
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
                onRoutingChanged()
            } else if (selectedRouteId == AUTO_ROUTE_ID || selectedRouteId == currentDevice?.id) {
                onRoutingChanged()
                return
            }
        }

        if (_state.value == AudioRouteState.Routing) {
            routeVerifyJob?.cancel()
        }

        applySelectedRouting(selectedRouteId, onSelectedRouteMissing, onBuiltInRouteChanged)
    }

    fun startSession() {
        sessionActive = true
    }

    fun endSession(onBuiltInRouteChanged: (Int) -> Unit) {
        sessionActive = false
        routeVerifyJob?.cancel()
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
            audioManager.clearCommunicationDevice()
            audioManager.mode = AudioManager.MODE_NORMAL
            Log.d(TAG, "Audio mode -> MODE_NORMAL (endSession)")
        }
        currentDevice = null
        onBuiltInRouteChanged(PHONE_SPEAKER_ROUTE_ID)
        _state.value = if (findScoDevice() != null) AudioRouteState.Available else AudioRouteState.NoDevice
        onRoutingChanged()
    }

    fun destroy() {
        sessionActive = false
        routeVerifyJob?.cancel()
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
            audioManager.clearCommunicationDevice()
            audioManager.mode = AudioManager.MODE_NORMAL
        }
        currentDevice = null
        _state.value = AudioRouteState.NoDevice
        onRoutingChanged()
    }

    fun routedDevice(): AudioDeviceInfo? = when (_state.value) {
        AudioRouteState.Routing, AudioRouteState.Routed -> currentDevice
        else -> null
    }

    @SuppressLint("NewApi")
    fun prepareForCommunication(selectedRouteId: Int): AudioDeviceInfo? {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.S || !sessionActive) return null

        val commDevices = audioManager.availableCommunicationDevices
        val target = when (selectedRouteId) {
            AUTO_ROUTE_ID -> commDevices.firstOrNull { it.isBtDevice() }
            PHONE_SPEAKER_ROUTE_ID -> commDevices.firstOrNull { it.type == AudioDeviceInfo.TYPE_BUILTIN_SPEAKER }
            EARPIECE_ROUTE_ID -> commDevices.firstOrNull { it.type == AudioDeviceInfo.TYPE_BUILTIN_EARPIECE }
            else -> commDevices.firstOrNull { it.id == selectedRouteId }
        } ?: return null

        val currentCommunicationDevice = audioManager.communicationDevice
        if (
            audioManager.mode == AudioManager.MODE_IN_COMMUNICATION &&
            currentCommunicationDevice?.id == target.id
        ) {
            Log.d(
                TAG,
                "prepareForCommunication(${target.productName} / ${routeDeviceTypeName(target.type)}) -> already active",
            )
            currentDevice = target
            onRoutingChanged()
            return target
        }

        audioManager.clearCommunicationDevice()
        audioManager.mode = AudioManager.MODE_NORMAL
        audioManager.mode = AudioManager.MODE_IN_COMMUNICATION
        val success = audioManager.setCommunicationDevice(target)
        Log.d(
            TAG,
            "prepareForCommunication(${target.productName} / ${routeDeviceTypeName(target.type)}) -> $success",
        )
        if (!success) return null

        currentDevice = target
        onRoutingChanged()
        return target
    }

    @SuppressLint("NewApi")
    private fun availabilityState(): AudioRouteState =
        if (audioManager.availableCommunicationDevices.any { it.isBtDevice() }) {
            AudioRouteState.Available
        } else {
            AudioRouteState.NoDevice
        }

    @SuppressLint("NewApi")
    private fun applySelectedRouting(
        selectedRouteId: Int,
        onSelectedRouteMissing: () -> Unit,
        onBuiltInRouteChanged: (Int) -> Unit,
    ) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.S) return

        val commDevices = audioManager.availableCommunicationDevices
        when (selectedRouteId) {
            AUTO_ROUTE_ID -> routeToBluetoothOrPhone(onBuiltInRouteChanged)
            PHONE_SPEAKER_ROUTE_ID -> routeToBuiltIn(
                commDevices = commDevices,
                deviceType = AudioDeviceInfo.TYPE_BUILTIN_SPEAKER,
                routeId = PHONE_SPEAKER_ROUTE_ID,
                onBuiltInRouteChanged = onBuiltInRouteChanged,
            )
            EARPIECE_ROUTE_ID -> routeToBuiltIn(
                commDevices = commDevices,
                deviceType = AudioDeviceInfo.TYPE_BUILTIN_EARPIECE,
                routeId = EARPIECE_ROUTE_ID,
                onBuiltInRouteChanged = onBuiltInRouteChanged,
            )
            else -> {
                val selectedBt = commDevices.firstOrNull { it.isBtDevice() && it.id == selectedRouteId }
                if (selectedBt == null) {
                    Log.d(TAG, "Selected headset missing; reverting to automatic")
                    onSelectedRouteMissing()
                    routeToBluetoothOrPhone(onBuiltInRouteChanged)
                } else if (_state.value != AudioRouteState.Routed || currentDevice?.id != selectedBt.id) {
                    routeToDevice(selectedBt)
                } else {
                    onRoutingChanged()
                }
            }
        }
    }

    @RequiresApi(Build.VERSION_CODES.S)
    private fun clearCommunicationRoute(
        commDevices: List<AudioDeviceInfo>,
        onBuiltInRouteChanged: (Int) -> Unit,
    ) {
        audioManager.clearCommunicationDevice()
        audioManager.mode = AudioManager.MODE_NORMAL
        currentDevice = null
        onBuiltInRouteChanged(PHONE_SPEAKER_ROUTE_ID)
        _state.value = if (commDevices.any { it.isBtDevice() }) AudioRouteState.Available else AudioRouteState.NoDevice
        onRoutingChanged()
    }

    @RequiresApi(Build.VERSION_CODES.S)
    private fun routeToBuiltIn(
        commDevices: List<AudioDeviceInfo>,
        deviceType: Int,
        routeId: Int,
        onBuiltInRouteChanged: (Int) -> Unit,
    ) {
        val target = commDevices.firstOrNull { it.type == deviceType }
        if (target == null) {
            clearCommunicationRoute(commDevices, onBuiltInRouteChanged)
            return
        }

        audioManager.clearCommunicationDevice()
        audioManager.mode = AudioManager.MODE_NORMAL
        audioManager.mode = AudioManager.MODE_IN_COMMUNICATION
        val success = audioManager.setCommunicationDevice(target)
        if (!success) {
            Log.w(TAG, "Failed to force built-in route type=$deviceType; falling back to cleared route")
            clearCommunicationRoute(commDevices, onBuiltInRouteChanged)
            return
        }

        currentDevice = null
        onBuiltInRouteChanged(routeId)
        _state.value = if (commDevices.any { it.isBtDevice() }) AudioRouteState.Available else AudioRouteState.NoDevice
        onRoutingChanged()
    }

    @SuppressLint("NewApi")
    fun findScoDevice(): AudioDeviceInfo? {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.S) return null
        return audioManager.availableCommunicationDevices.firstOrNull { it.isBtDevice() }
    }

    @RequiresApi(Build.VERSION_CODES.S)
    private fun routeToBluetoothOrPhone(onBuiltInRouteChanged: (Int) -> Unit) {
        val btDevice = findScoDevice()
        if (btDevice == null) {
            routeToBuiltIn(
                commDevices = audioManager.availableCommunicationDevices,
                deviceType = AudioDeviceInfo.TYPE_BUILTIN_SPEAKER,
                routeId = PHONE_SPEAKER_ROUTE_ID,
                onBuiltInRouteChanged = onBuiltInRouteChanged,
            )
        } else {
            routeToDevice(btDevice)
        }
    }

    @SuppressLint("NewApi")
    private fun routeToDevice(device: AudioDeviceInfo) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.S) {
            _state.value = AudioRouteState.UnsupportedApi
            onRoutingChanged()
            return
        }

        routeVerifyJob?.cancel()
        _state.value = AudioRouteState.Routing
        currentDevice = device
        onRoutingChanged()

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
                    onRoutingChanged()
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
            onRoutingChanged()
        }
    }

    @RequiresApi(Build.VERSION_CODES.S)
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
}

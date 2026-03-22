package com.claudeway.audio

import android.annotation.SuppressLint
import android.media.AudioDeviceInfo
import android.media.AudioFormat
import android.media.AudioRecord
import android.media.MediaRecorder
import android.os.Build
import android.util.Base64
import android.util.Log
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.flow
import kotlinx.coroutines.flow.flowOn
import kotlinx.coroutines.isActive
import kotlin.coroutines.coroutineContext
import kotlin.math.abs

private const val TAG = "AudioRecorder"

/**
 * Captures PCM audio from the device microphone (or Bluetooth SCO mic when routed).
 * Outputs 16kHz mono 16-bit signed LE PCM.
 */
class AudioRecorder {
    companion object {
        const val SAMPLE_RATE = 16000
        const val CHANNEL_CONFIG = AudioFormat.CHANNEL_IN_MONO
        const val AUDIO_ENCODING = AudioFormat.ENCODING_PCM_16BIT
        const val MIME_TYPE = "audio/l16;rate=16000"
        const val CHUNK_DURATION_MS = 20

        /** Buffer size in bytes (~20ms of audio) */
        val BUFFER_SIZE: Int = maxOf(
            AudioRecord.getMinBufferSize(SAMPLE_RATE, CHANNEL_CONFIG, AUDIO_ENCODING),
            SAMPLE_RATE * 2 * CHUNK_DURATION_MS / 1000
        )
    }

    private var recorder: AudioRecord? = null

    /** Normalized mic level (0f = silence, 1f = max) — updated per audio chunk during recording. */
    private val _micLevel = MutableStateFlow(0f)
    val micLevel: StateFlow<Float> = _micLevel.asStateFlow()

    /**
     * Start recording and emit PCM byte arrays as a Flow.
     * Each emission is ~20ms of raw PCM data.
     * The flow completes when [stopRecording] is called or the coroutine is cancelled.
     *
     * @param preferredDevice If non-null, route recording to this specific device (e.g. BT SCO).
     */
    @SuppressLint("MissingPermission") // Permission checked at UI layer before starting
    fun startRecording(preferredDevice: AudioDeviceInfo? = null): Flow<ByteArray> = flow {
        val audioSource = selectAudioSource(preferredDevice)
        val record = AudioRecord(
            audioSource,
            SAMPLE_RATE,
            CHANNEL_CONFIG,
            AUDIO_ENCODING,
            BUFFER_SIZE,
        )
        recorder = record

        if (record.state != AudioRecord.STATE_INITIALIZED) {
            record.release()
            recorder = null
            throw IllegalStateException("AudioRecord failed to initialize")
        }

        // Route to specific device if provided
        if (preferredDevice != null) {
            val set = record.setPreferredDevice(preferredDevice)
            Log.d(TAG, "setPreferredDevice(${preferredDevice.productName}): $set")
        }

        record.startRecording()
        _micLevel.value = 0f

        // Log which device is actually being used
        val activeDevice = record.routedDevice
        val rates = activeDevice?.sampleRates
        val ratesStr = when {
            rates == null -> "unknown"
            rates.isEmpty() -> "any (unconstrained)"
            else -> rates.toList().toString()
        }
        Log.d(
            TAG,
            "Recording started — source=${audioSourceName(audioSource)}, " +
                "device: ${activeDevice?.productName ?: "default"} " +
                "(${deviceTypeName(activeDevice?.type)}), requestedRate=$SAMPLE_RATE, deviceRates=$ratesStr"
        )

        val buffer = ByteArray(BUFFER_SIZE)
        var chunkCount = 0

        try {
            while (coroutineContext.isActive && recorder != null) {
                val bytesRead = record.read(buffer, 0, buffer.size)
                if (bytesRead > 0) {
                    val peak = peakAmplitude(buffer, bytesRead)
                    // Normalize to 0-1 with light smoothing
                    val normalized = (peak / 32767f).coerceIn(0f, 1f)
                    _micLevel.value = normalized

                    // Log audio level for first few chunks to diagnose silent audio
                    if (chunkCount < 10 || chunkCount % 50 == 0) {
                        Log.d(TAG, "Chunk $chunkCount: ${bytesRead}B, peak=$peak")
                    }
                    chunkCount++
                    emit(buffer.copyOf(bytesRead))
                } else if (bytesRead < 0) {
                    Log.e(TAG, "AudioRecord.read error: $bytesRead")
                    break
                }
            }
        } finally {
            Log.d(TAG, "Recording stopped after $chunkCount chunks")
            _micLevel.value = 0f
            record.stop()
            record.release()
            recorder = null
        }
    }.flowOn(Dispatchers.IO)

    /** Stop the current recording. The flow from [startRecording] will complete. */
    fun stopRecording() {
        recorder = null // Flow loop checks this and exits
    }

    /** Encode raw PCM bytes to base64 for WebSocket transmission. */
    fun encodeToBase64(pcmData: ByteArray): String {
        return Base64.encodeToString(pcmData, Base64.NO_WRAP)
    }

    private fun selectAudioSource(preferredDevice: AudioDeviceInfo?): Int {
        return if (preferredDevice?.isBtDevice() == true) {
            MediaRecorder.AudioSource.VOICE_COMMUNICATION
        } else if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.N) {
            MediaRecorder.AudioSource.UNPROCESSED
        } else {
            MediaRecorder.AudioSource.MIC
        }
    }

    /** Peak amplitude from 16-bit PCM samples. 0 = silence, 32767 = max. */
    private fun peakAmplitude(buffer: ByteArray, length: Int): Int {
        var peak = 0
        var i = 0
        while (i + 1 < length) {
            val sample = (buffer[i].toInt() and 0xFF) or (buffer[i + 1].toInt() shl 8)
            peak = maxOf(peak, abs(sample.toShort().toInt()))
            i += 2
        }
        return peak
    }

    private fun deviceTypeName(type: Int?): String = when (type) {
        AudioDeviceInfo.TYPE_BUILTIN_EARPIECE -> "BUILTIN_EARPIECE"
        AudioDeviceInfo.TYPE_BUILTIN_SPEAKER -> "BUILTIN_SPEAKER"
        AudioDeviceInfo.TYPE_BLUETOOTH_SCO -> "BLUETOOTH_SCO"
        AudioDeviceInfo.TYPE_BLUETOOTH_A2DP -> "BLUETOOTH_A2DP"
        AudioDeviceInfo.TYPE_BLE_HEADSET -> "BLE_HEADSET"
        AudioDeviceInfo.TYPE_BLE_SPEAKER -> "BLE_SPEAKER"
        AudioDeviceInfo.TYPE_WIRED_HEADSET -> "WIRED_HEADSET"
        AudioDeviceInfo.TYPE_USB_DEVICE -> "USB_DEVICE"
        null -> "null"
        else -> "UNKNOWN($type)"
    }

    private fun audioSourceName(source: Int): String = when (source) {
        MediaRecorder.AudioSource.MIC -> "MIC"
        MediaRecorder.AudioSource.UNPROCESSED -> "UNPROCESSED"
        MediaRecorder.AudioSource.VOICE_COMMUNICATION -> "VOICE_COMMUNICATION"
        else -> "UNKNOWN($source)"
    }

    @SuppressLint("InlinedApi")
    private fun AudioDeviceInfo.isBtDevice(): Boolean =
        type == AudioDeviceInfo.TYPE_BLUETOOTH_SCO || type == AudioDeviceInfo.TYPE_BLE_HEADSET
}

package com.claudeway.audio

import android.annotation.SuppressLint
import android.media.AudioDeviceInfo
import android.media.AudioFormat
import android.media.AudioRecord
import android.media.MediaRecorder
import android.util.Base64
import android.util.Log
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.flow
import kotlinx.coroutines.flow.flowOn
import kotlinx.coroutines.isActive
import kotlin.coroutines.coroutineContext
import kotlin.math.abs

private const val TAG = "AudioRecorder"

/**
 * Captures PCM audio from the device microphone (or Bluetooth SCO mic when routed).
 * Outputs 8kHz mono 16-bit signed LE PCM — matching Bluetooth HFP constraints.
 */
class AudioRecorder {
    companion object {
        const val SAMPLE_RATE = 16000
        const val CHANNEL_CONFIG = AudioFormat.CHANNEL_IN_MONO
        const val AUDIO_ENCODING = AudioFormat.ENCODING_PCM_16BIT
        const val MIME_TYPE = "audio/l16;rate=16000"

        /** Buffer size in bytes (~100ms of audio) */
        val BUFFER_SIZE: Int = maxOf(
            AudioRecord.getMinBufferSize(SAMPLE_RATE, CHANNEL_CONFIG, AUDIO_ENCODING),
            SAMPLE_RATE * 2 / 10 // 100ms at 16-bit mono = 1600 bytes
        )
    }

    private var recorder: AudioRecord? = null

    /**
     * Start recording and emit PCM byte arrays as a Flow.
     * Each emission is ~100ms of raw PCM data.
     * The flow completes when [stopRecording] is called or the coroutine is cancelled.
     *
     * @param preferredDevice If non-null, route recording to this specific device (e.g. BT SCO).
     */
    @SuppressLint("MissingPermission") // Permission checked at UI layer before starting
    fun startRecording(preferredDevice: AudioDeviceInfo? = null): Flow<ByteArray> = flow {
        val record = AudioRecord(
            MediaRecorder.AudioSource.VOICE_COMMUNICATION,
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

        // Log which device is actually being used
        val activeDevice = record.routedDevice
        val rates = activeDevice?.sampleRates
        val ratesStr = when {
            rates == null -> "unknown"
            rates.isEmpty() -> "any (unconstrained)"
            else -> rates.toList().toString()
        }
        Log.d(TAG, "Recording started — device: ${activeDevice?.productName ?: "default"} " +
            "(${deviceTypeName(activeDevice?.type)}), requestedRate=$SAMPLE_RATE, deviceRates=$ratesStr")

        val buffer = ByteArray(BUFFER_SIZE)
        var chunkCount = 0

        try {
            while (coroutineContext.isActive && recorder != null) {
                val bytesRead = record.read(buffer, 0, buffer.size)
                if (bytesRead > 0) {
                    // Log audio level for first few chunks to diagnose silent audio
                    if (chunkCount < 10 || chunkCount % 50 == 0) {
                        val maxAmplitude = peakAmplitude(buffer, bytesRead)
                        Log.d(TAG, "Chunk $chunkCount: ${bytesRead}B, peak=$maxAmplitude")
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
}

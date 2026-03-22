package com.claudeway.glasses.audio

import android.annotation.SuppressLint
import android.media.AudioFormat
import android.media.AudioRecord
import android.media.MediaRecorder
import android.util.Base64
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.flow
import kotlinx.coroutines.flow.flowOn
import kotlinx.coroutines.isActive
import kotlin.coroutines.coroutineContext

/**
 * Captures PCM audio from the device microphone (or Bluetooth SCO mic when routed).
 * Outputs 8kHz mono 16-bit signed LE PCM — matching Bluetooth HFP constraints.
 */
class AudioRecorder {
    companion object {
        const val SAMPLE_RATE = 8000
        const val CHANNEL_CONFIG = AudioFormat.CHANNEL_IN_MONO
        const val AUDIO_ENCODING = AudioFormat.ENCODING_PCM_16BIT
        const val MIME_TYPE = "audio/l16;rate=8000"

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
     */
    @SuppressLint("MissingPermission") // Permission checked at UI layer before starting
    fun startRecording(): Flow<ByteArray> = flow {
        val record = AudioRecord(
            MediaRecorder.AudioSource.DEFAULT,
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

        record.startRecording()
        val buffer = ByteArray(BUFFER_SIZE)

        try {
            while (coroutineContext.isActive && recorder != null) {
                val bytesRead = record.read(buffer, 0, buffer.size)
                if (bytesRead > 0) {
                    emit(buffer.copyOf(bytesRead))
                } else if (bytesRead < 0) {
                    break // Error reading
                }
            }
        } finally {
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
}

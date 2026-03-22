package com.claudeway.audio

import android.media.AudioAttributes
import android.media.AudioDeviceInfo
import android.media.AudioFormat
import android.media.AudioTrack
import android.util.Base64
import android.util.Log
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch

/**
 * Plays PCM audio received from the server through the device speaker
 * (or Bluetooth SCO speaker when routed via AudioRouter).
 * Uses a coroutine-backed queue for gapless sequential playback.
 *
 * Thread safety: the playback coroutine owns the AudioTrack lifecycle —
 * stop() signals it to exit and the coroutine releases the native resource
 * in its finally block, avoiding races between write() and release().
 */
private const val TAG = "AudioPlayer"

internal fun deviceTypeName(type: Int?): String = when (type) {
    null -> "NONE"
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

class AudioPlayer(private val scope: CoroutineScope) {
    private var audioTrack: AudioTrack? = null
    private var playbackJob: Job? = null
    private var audioQueue: Channel<ByteArray>? = null
    private var currentSampleRate: Int = 0

    /** Queue a base64-encoded PCM chunk for playback. */
    fun queueAudio(base64Data: String, sampleRate: Int) {
        val pcmData = Base64.decode(base64Data, Base64.NO_WRAP)
        ensureTrack(sampleRate)
        audioQueue?.trySend(pcmData)
    }

    /** Signal that no more audio chunks are coming for this response. */
    fun endOfAudio() {
        audioQueue?.close()
    }

    /** Stop playback immediately (for cancellation/barge-in). */
    fun stop() {
        // Stop the track first to unblock any pending write() on the IO thread,
        // so the playback coroutine can exit and release() in its finally block.
        audioTrack?.let { try { it.stop() } catch (_: IllegalStateException) {} }
        audioTrack = null
        audioQueue?.close()
        audioQueue = null
        playbackJob?.cancel()
        playbackJob = null
        currentSampleRate = 0
    }

    private fun ensureTrack(sampleRate: Int) {
        // Need a new queue if the previous one was closed (endOfAudio) or sample rate changed
        val needNewQueue = audioQueue?.isClosedForSend != false || currentSampleRate != sampleRate
        if (!needNewQueue) return

        // Signal previous playback to stop — track.stop() unblocks pending write()
        audioTrack?.let { try { it.stop() } catch (_: IllegalStateException) {} }
        audioTrack = null
        playbackJob?.cancel()
        playbackJob = null

        currentSampleRate = sampleRate
        val bufferSize = AudioTrack.getMinBufferSize(
            sampleRate,
            AudioFormat.CHANNEL_OUT_MONO,
            AudioFormat.ENCODING_PCM_16BIT,
        )

        val track = AudioTrack.Builder()
            .setAudioAttributes(
                AudioAttributes.Builder()
                    .setUsage(AudioAttributes.USAGE_VOICE_COMMUNICATION)
                    .setContentType(AudioAttributes.CONTENT_TYPE_SPEECH)
                    .build()
            )
            .setAudioFormat(
                AudioFormat.Builder()
                    .setSampleRate(sampleRate)
                    .setChannelMask(AudioFormat.CHANNEL_OUT_MONO)
                    .setEncoding(AudioFormat.ENCODING_PCM_16BIT)
                    .build()
            )
            .setBufferSizeInBytes(bufferSize * 2) // Double buffer for smooth playback
            .setTransferMode(AudioTrack.MODE_STREAM)
            .build()

        track.play()
        audioTrack = track
        val routed = track.routedDevice
        val rates = routed?.sampleRates
        val ratesStr = when {
            rates == null -> "unknown"
            rates.isEmpty() -> "any (unconstrained)"
            else -> rates.toList().toString()
        }
        Log.d(TAG, "Playback started — device: ${routed?.productName ?: "default"} " +
            "(${deviceTypeName(routed?.type)}), requestedRate=$sampleRate, deviceRates=$ratesStr")

        // Start playback loop — the coroutine owns the track's release lifecycle
        val queue = Channel<ByteArray>(capacity = Channel.UNLIMITED)
        audioQueue = queue
        playbackJob = scope.launch(Dispatchers.IO) {
            var totalFramesWritten = 0L
            var completedNormally = false
            try {
                for (chunk in queue) {
                    val written = track.write(chunk, 0, chunk.size)
                    if (written < 0) {
                        completedNormally = false // AudioTrack error — skip drain
                        break
                    }
                    totalFramesWritten += written / 2 // 16-bit = 2 bytes per frame (mono)
                    completedNormally = true
                }
            } catch (_: CancellationException) {
                throw CancellationException()
            } catch (_: Exception) {
                // Track stopped/released during write — expected on barge-in
            } finally {
                try {
                    if (completedNormally && totalFramesWritten > 0) {
                        // Let the track keep playing (still in PLAYING state) and
                        // wait for the hardware to actually consume all written frames.
                        // Only call stop()+release() after the drain completes.
                        val timeoutMs = 3_000L
                        val deadline = System.currentTimeMillis() + timeoutMs
                        while (track.playbackHeadPosition < totalFramesWritten &&
                            System.currentTimeMillis() < deadline
                        ) {
                            delay(20)
                        }
                    }
                    track.stop()
                    track.release()
                } catch (_: IllegalStateException) {
                    // Already released
                }
            }
        }
    }
}

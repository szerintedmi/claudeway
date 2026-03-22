package com.claudeway.audio

import android.annotation.SuppressLint
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
private const val BLUETOOTH_OUTPUT_WARMUP_MS = 40

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
    private var routeGeneration: Long = 0
    private var trackRouteGeneration: Long = -1

    /** Set the preferred output device (e.g. Bluetooth SCO). Rebinds the live track if changed. */
    var preferredDevice: AudioDeviceInfo? = null
        set(value) {
            if (field?.id == value?.id) return
            field = value
            routeGeneration += 1
            if (value != null) {
                Log.d(TAG, "Preferred device -> ${value.productName} (${deviceTypeName(value.type)})")
            } else {
                Log.d(TAG, "Cleared preferred device")
            }
            // A route transition is more reliable when the track is reopened on the next chunk,
            // rather than only rebinding the existing AudioTrack in place.
            audioTrack?.let { track ->
                closeTrackImmediately(track)
                audioTrack = null
            }
        }

    /** Queue a base64-encoded PCM chunk for playback. */
    fun queueAudio(base64Data: String, sampleRate: Int) {
        val pcmData = Base64.decode(base64Data, Base64.NO_WRAP)
        ensureTrack(sampleRate)
        audioQueue?.trySend(pcmData)
    }

    /** Prime the output path before the first real chunk arrives. */
    fun primePlayback(sampleRate: Int) {
        ensureTrack(sampleRate)
    }

    /** Signal that no more audio chunks are coming for this response. */
    fun endOfAudio() {
        audioQueue?.close()
    }

    /** Stop playback immediately (for cancellation/barge-in). */
    fun stop() {
        // Stop the track first to unblock any pending write() on the IO thread,
        // so the playback coroutine can exit and release() in its finally block.
        audioTrack?.let { closeTrackImmediately(it) }
        audioTrack = null
        audioQueue?.close()
        audioQueue = null
        playbackJob?.cancel()
        playbackJob = null
        currentSampleRate = 0
        trackRouteGeneration = -1
    }

    private fun ensureTrack(sampleRate: Int) {
        val needNewQueue = audioQueue?.isClosedForSend != false || currentSampleRate != sampleRate
        if (needNewQueue) {
            // Signal previous playback to stop — track.stop() unblocks pending write()
            audioTrack?.let { closeTrackImmediately(it) }
            audioTrack = null
            playbackJob?.cancel()
            playbackJob = null
            trackRouteGeneration = -1
            currentSampleRate = sampleRate

            val queue = Channel<ByteArray>(capacity = Channel.UNLIMITED)
            audioQueue = queue
            playbackJob = scope.launch(Dispatchers.IO) {
                var totalFramesWritten = 0L
                var completedNormally = false
                try {
                    for (chunk in queue) {
                        val track = ensureLiveTrack(sampleRate)
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
                    // Track stopped/released during write — expected on barge-in or route transition
                } finally {
                    releaseTrack(audioTrack, completedNormally, totalFramesWritten)
                    audioTrack = null
                    trackRouteGeneration = -1
                }
            }
        }

        if (audioTrack == null) {
            audioTrack = buildTrack(sampleRate)
            trackRouteGeneration = routeGeneration
        }
    }

    private fun ensureLiveTrack(sampleRate: Int): AudioTrack {
        val currentTrack = audioTrack
        if (currentTrack != null && trackRouteGeneration == routeGeneration) {
            return currentTrack
        }

        closeTrackImmediately(currentTrack)
        return buildTrack(sampleRate).also {
            audioTrack = it
            trackRouteGeneration = routeGeneration
        }
    }

    private fun buildTrack(sampleRate: Int): AudioTrack {
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

        preferredDevice?.let { device ->
            val ok = track.setPreferredDevice(device)
            Log.d(TAG, "setPreferredDevice(${device.productName} / ${deviceTypeName(device.type)}) -> $ok")
        }
        track.play()
        if (preferredDevice?.isBtPlaybackDevice() == true) {
            val warmupBytes = sampleRate * 2 * BLUETOOTH_OUTPUT_WARMUP_MS / 1000
            val silence = ByteArray(warmupBytes)
            val written = track.write(silence, 0, silence.size)
            Log.d(TAG, "Playback warmup wrote ${written.coerceAtLeast(0)}B of silence")
        }
        val routed = track.routedDevice
        val rates = routed?.sampleRates
        val ratesStr = when {
            rates == null -> "unknown"
            rates.isEmpty() -> "any (unconstrained)"
            else -> rates.toList().toString()
        }
        Log.d(TAG, "Playback started — device: ${routed?.productName ?: "default"} " +
            "(${deviceTypeName(routed?.type)}), requestedRate=$sampleRate, deviceRates=$ratesStr")
        return track
    }

    private suspend fun releaseTrack(
        track: AudioTrack?,
        completedNormally: Boolean,
        totalFramesWritten: Long,
    ) {
        if (track == null) return
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

    private fun closeTrackImmediately(track: AudioTrack?) {
        if (track == null) return
        try {
            track.stop()
            track.release()
        } catch (_: IllegalStateException) {
            // Already released
        }
    }
}

@SuppressLint("InlinedApi")
private fun AudioDeviceInfo.isBtPlaybackDevice(): Boolean =
    type == AudioDeviceInfo.TYPE_BLUETOOTH_SCO ||
        type == AudioDeviceInfo.TYPE_BLUETOOTH_A2DP ||
        type == AudioDeviceInfo.TYPE_BLE_HEADSET ||
        type == AudioDeviceInfo.TYPE_BLE_SPEAKER

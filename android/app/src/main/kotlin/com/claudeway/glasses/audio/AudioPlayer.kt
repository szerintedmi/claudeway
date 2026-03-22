package com.claudeway.glasses.audio

import android.media.AudioAttributes
import android.media.AudioFormat
import android.media.AudioTrack
import android.util.Base64
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.channels.Channel
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

        // Start playback loop — the coroutine owns the track's release lifecycle
        val queue = Channel<ByteArray>(capacity = Channel.UNLIMITED)
        audioQueue = queue
        playbackJob = scope.launch(Dispatchers.IO) {
            try {
                for (chunk in queue) {
                    track.write(chunk, 0, chunk.size)
                }
            } catch (_: Exception) {
                // Track stopped/released during write — expected on barge-in
            } finally {
                try {
                    track.flush()
                    track.release()
                } catch (_: IllegalStateException) {
                    // Already released
                }
            }
        }
    }
}

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
        playbackJob?.cancel()
        playbackJob = null
        audioQueue?.close()
        audioQueue = null
        audioTrack?.let { track ->
            try {
                track.pause()
                track.flush()
                track.release()
            } catch (_: IllegalStateException) {
                // Already released
            }
        }
        audioTrack = null
        currentSampleRate = 0
    }

    private fun ensureTrack(sampleRate: Int) {
        // Need a new queue if the previous one was closed (endOfAudio) or sample rate changed
        val needNewQueue = audioQueue?.isClosedForSend != false || currentSampleRate != sampleRate
        if (!needNewQueue) return

        // Clean up previous playback state
        playbackJob?.cancel()
        playbackJob = null
        audioTrack?.release()

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

        // Start playback loop
        val queue = Channel<ByteArray>(capacity = Channel.UNLIMITED)
        audioQueue = queue
        playbackJob = scope.launch(Dispatchers.IO) {
            for (chunk in queue) {
                track.write(chunk, 0, chunk.size)
            }
        }
    }
}

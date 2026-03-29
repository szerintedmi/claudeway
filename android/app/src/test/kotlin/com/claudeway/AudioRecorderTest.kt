package com.claudeway

import android.media.AudioFormat
import android.media.AudioRecord
import com.claudeway.audio.AudioRecorder
import io.mockk.every
import io.mockk.mockk
import io.mockk.mockkConstructor
import io.mockk.unmockkConstructor
import io.mockk.verify
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.cancelAndJoin
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.flow.take
import kotlinx.coroutines.flow.toList
import kotlinx.coroutines.launch
import kotlinx.coroutines.test.advanceUntilIdle
import kotlinx.coroutines.test.runTest
import org.junit.After
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner

@OptIn(ExperimentalCoroutinesApi::class)
@RunWith(RobolectricTestRunner::class)
class AudioRecorderTest {

    private lateinit var recorder: AudioRecorder

    @Before
    fun setup() {
        recorder = AudioRecorder()
    }

    @Test
    fun `sample rate is 16kHz`() {
        assertEquals(16000, AudioRecorder.SAMPLE_RATE)
    }

    @Test
    fun `channel config is mono`() {
        assertEquals(AudioFormat.CHANNEL_IN_MONO, AudioRecorder.CHANNEL_CONFIG)
    }

    @Test
    fun `audio encoding is PCM 16-bit`() {
        assertEquals(AudioFormat.ENCODING_PCM_16BIT, AudioRecorder.AUDIO_ENCODING)
    }

    @Test
    fun `MIME type matches sample rate`() {
        assertEquals("audio/l16;rate=16000", AudioRecorder.MIME_TYPE)
    }

    @Test
    fun `chunk duration is 20ms`() {
        assertEquals(20, AudioRecorder.CHUNK_DURATION_MS)
    }

    @Test
    fun `buffer size is at least 20ms of audio`() {
        // 16kHz * 2 bytes/sample * 20ms/1000 = 640 bytes
        val minChunkBytes = AudioRecorder.SAMPLE_RATE * 2 * AudioRecorder.CHUNK_DURATION_MS / 1000
        assertTrue(
            "Buffer size (${AudioRecorder.BUFFER_SIZE}) should be >= $minChunkBytes bytes (20ms of 16kHz 16-bit mono)",
            AudioRecorder.BUFFER_SIZE >= minChunkBytes,
        )
    }

    @Test
    fun `buffer size is at least AudioRecord minimum`() {
        val minBufferSize = AudioRecord.getMinBufferSize(
            AudioRecorder.SAMPLE_RATE,
            AudioRecorder.CHANNEL_CONFIG,
            AudioRecorder.AUDIO_ENCODING,
        )
        assertTrue(
            "Buffer size (${AudioRecorder.BUFFER_SIZE}) should be >= AudioRecord min ($minBufferSize)",
            AudioRecorder.BUFFER_SIZE >= minBufferSize,
        )
    }

    @Test
    fun `stopRecording on fresh recorder is a no-op`() {
        // Should not throw
        recorder.stopRecording()
    }

    @Test
    fun `micLevel starts at zero`() {
        assertEquals(0f, recorder.micLevel.value)
    }

    @Test
    fun `encodeToBase64 produces valid base64`() {
        val pcm = byteArrayOf(0x01, 0x02, 0x03, 0x04)
        val encoded = recorder.encodeToBase64(pcm)
        // Decode and verify round-trip
        val decoded = android.util.Base64.decode(encoded, android.util.Base64.NO_WRAP)
        assertArrayEquals(pcm, decoded)
    }

    @Test
    fun `encodeToBase64 handles empty input`() {
        val encoded = recorder.encodeToBase64(ByteArray(0))
        val decoded = android.util.Base64.decode(encoded, android.util.Base64.NO_WRAP)
        assertEquals(0, decoded.size)
    }
}

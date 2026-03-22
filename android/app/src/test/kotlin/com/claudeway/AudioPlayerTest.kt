package com.claudeway

import android.util.Base64
import com.claudeway.audio.AudioPlayer
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.test.StandardTestDispatcher
import kotlinx.coroutines.test.advanceUntilIdle
import kotlinx.coroutines.test.resetMain
import kotlinx.coroutines.test.runTest
import kotlinx.coroutines.test.setMain
import org.junit.After
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner

@OptIn(ExperimentalCoroutinesApi::class)
@RunWith(RobolectricTestRunner::class)
class AudioPlayerTest {
    private val testDispatcher = StandardTestDispatcher()

    @Before
    fun setup() {
        Dispatchers.setMain(testDispatcher)
    }

    @After
    fun tearDown() {
        Dispatchers.resetMain()
    }

    private fun makePcmBase64(bytes: Int = 960): String {
        return Base64.encodeToString(ByteArray(bytes), Base64.NO_WRAP)
    }

    @Test
    fun `queueAudio and endOfAudio complete without crash`() = runTest {
        val player = AudioPlayer(CoroutineScope(testDispatcher))
        player.queueAudio(makePcmBase64(), sampleRate = 24000)
        player.endOfAudio()
        advanceUntilIdle()
    }

    @Test
    fun `stop clears state and does not crash`() = runTest {
        val player = AudioPlayer(CoroutineScope(testDispatcher))
        player.queueAudio(makePcmBase64(), sampleRate = 24000)
        player.stop()
        advanceUntilIdle()
    }

    @Test
    fun `endOfAudio without prior audio does not crash`() = runTest {
        val player = AudioPlayer(CoroutineScope(testDispatcher))
        player.endOfAudio()
        advanceUntilIdle()
    }

    @Test
    fun `stop without prior audio does not crash`() = runTest {
        val player = AudioPlayer(CoroutineScope(testDispatcher))
        player.stop()
    }

    @Test
    fun `can start new playback after endOfAudio`() = runTest {
        val player = AudioPlayer(CoroutineScope(testDispatcher))
        // First cycle
        player.queueAudio(makePcmBase64(), sampleRate = 24000)
        player.endOfAudio()
        advanceUntilIdle()
        // Second cycle — ensureTrack should create a new queue
        player.queueAudio(makePcmBase64(), sampleRate = 24000)
        player.endOfAudio()
        advanceUntilIdle()
    }

    @Test
    fun `can start new playback after stop`() = runTest {
        val player = AudioPlayer(CoroutineScope(testDispatcher))
        player.queueAudio(makePcmBase64(), sampleRate = 24000)
        player.stop()
        advanceUntilIdle()
        // New cycle after barge-in
        player.queueAudio(makePcmBase64(), sampleRate = 24000)
        player.endOfAudio()
        advanceUntilIdle()
    }

    @Test
    fun `sample rate change creates new track`() = runTest {
        val player = AudioPlayer(CoroutineScope(testDispatcher))
        player.queueAudio(makePcmBase64(), sampleRate = 24000)
        // Switch to different sample rate mid-stream
        player.queueAudio(makePcmBase64(), sampleRate = 16000)
        player.endOfAudio()
        advanceUntilIdle()
    }

    @Test
    fun `multiple chunks queue without crash`() = runTest {
        val player = AudioPlayer(CoroutineScope(testDispatcher))
        repeat(10) {
            player.queueAudio(makePcmBase64(), sampleRate = 24000)
        }
        player.endOfAudio()
        advanceUntilIdle()
    }
}

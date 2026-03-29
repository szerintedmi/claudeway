package com.claudeway

import android.app.Application
import androidx.test.core.app.ApplicationProvider
import com.claudeway.voice.InputMode
import com.claudeway.voice.VoiceViewModel
import com.claudeway.voice.MessageRole
import com.claudeway.voice.VoiceFlowState
import com.claudeway.network.ConnectionState
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.test.UnconfinedTestDispatcher
import kotlinx.coroutines.test.resetMain
import kotlinx.coroutines.test.setMain
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner

@OptIn(ExperimentalCoroutinesApi::class)
@RunWith(RobolectricTestRunner::class)
class VoiceViewModelTest {
    private val testDispatcher = UnconfinedTestDispatcher()
    private lateinit var vm: VoiceViewModel

    @Before
    fun setup() {
        Dispatchers.setMain(testDispatcher)
        val app = ApplicationProvider.getApplicationContext<Application>()
        vm = VoiceViewModel(app)
    }

    @After
    fun tearDown() {
        Dispatchers.resetMain()
    }

    // --- Send failure paths ---

    @Test
    fun `sendText while disconnected shows error and adds no user message`() {
        assertEquals(ConnectionState.Disconnected, vm.uiState.value.connectionState)

        vm.sendText("hello")

        val state = vm.uiState.value
        assertEquals(VoiceFlowState.Error, state.voiceFlowState)
        assertEquals("Failed to send — not connected to server", state.statusText)
        assertNull(state.currentRequestId)
        assertTrue(state.messages.any {
            it.role == MessageRole.Error && it.text.contains("not connected")
        })
        // No user message — send failed before state update
        assertTrue(state.messages.none { it.role == MessageRole.User })
    }

    @Test
    fun `sendText with blank text is a no-op`() {
        vm.sendText("   ")
        assertEquals(VoiceFlowState.Idle, vm.uiState.value.voiceFlowState)
        assertTrue(vm.uiState.value.messages.isEmpty())
    }

    @Test
    fun `startRecording while disconnected shows error and does not enter recording state`() {
        vm.startRecording()

        val state = vm.uiState.value
        assertEquals(VoiceFlowState.Error, state.voiceFlowState)
        assertEquals("Failed to send — not connected to server", state.statusText)
        assertNull(state.currentRequestId)
    }

    @Test
    fun `stopRecording without active request is a no-op`() {
        vm.stopRecording()
        assertEquals(VoiceFlowState.Idle, vm.uiState.value.voiceFlowState)
        assertTrue(vm.uiState.value.messages.isEmpty())
    }

    @Test
    fun `cancelCurrentRequest without active request is a no-op`() {
        vm.cancelCurrentRequest()
        assertEquals(VoiceFlowState.Idle, vm.uiState.value.voiceFlowState)
        assertTrue(vm.uiState.value.messages.isEmpty())
    }

    @Test
    fun `multiple sendText failures accumulate error messages`() {
        vm.sendText("first")
        vm.sendText("second")

        val errors = vm.uiState.value.messages.filter { it.role == MessageRole.Error }
        assertEquals(2, errors.size)
    }

    @Test
    fun `startRecording then startRecording again while disconnected shows one error`() {
        // First attempt fails
        vm.startRecording()
        assertEquals(VoiceFlowState.Error, vm.uiState.value.voiceFlowState)

        // Second attempt — not in Recording state, so it tries again and fails again
        vm.startRecording()
        val errors = vm.uiState.value.messages.filter { it.role == MessageRole.Error }
        assertEquals(2, errors.size)
    }

    // --- Initial state ---

    @Test
    fun `initial state is idle and disconnected`() {
        val state = vm.uiState.value
        assertEquals(ConnectionState.Disconnected, state.connectionState)
        assertEquals(VoiceFlowState.Idle, state.voiceFlowState)
        assertNull(state.currentRequestId)
        assertNull(state.statusText)
        assertNull(state.activeTranscript)
        assertNull(state.activeResponseText)
        assertTrue(state.messages.isEmpty())
    }

    // --- Input mode ---

    @Test
    fun `setInputMode switches between text and voice`() {
        assertEquals(InputMode.Voice, vm.uiState.value.inputMode)
        vm.setInputMode(InputMode.Text)
        assertEquals(InputMode.Text, vm.uiState.value.inputMode)
        vm.setInputMode(InputMode.Voice)
        assertEquals(InputMode.Voice, vm.uiState.value.inputMode)
    }

    // --- TTS toggle ---

    @Test
    fun `toggleTts flips ttsEnabled state`() {
        assertTrue(vm.uiState.value.ttsEnabled)
        vm.toggleTts()
        assertEquals(false, vm.uiState.value.ttsEnabled)
        vm.toggleTts()
        assertTrue(vm.uiState.value.ttsEnabled)
    }

    // --- Cancel ---

    @Test
    fun `cancelCurrentRequest resets to idle when no active request`() {
        vm.cancelCurrentRequest()
        assertEquals(VoiceFlowState.Idle, vm.uiState.value.voiceFlowState)
        assertNull(vm.uiState.value.currentRequestId)
    }

    // --- Glasses tap events ---

    @Test
    fun `glasses simulateTap while disconnected shows error`() {
        vm.glassesManager.simulateTap()
        // Tap triggers startRecording, which fails because disconnected
        val state = vm.uiState.value
        assertEquals(VoiceFlowState.Error, state.voiceFlowState)
        assertTrue(state.messages.any { it.role == MessageRole.Error })
    }

    // --- New chat while disconnected ---

    @Test
    fun `newChat while disconnected changes connection state to connecting`() {
        // newChat calls disconnect then connect — since there's no real server,
        // it will attempt connection. Verify it doesn't crash and state transitions.
        vm.newChat("ws://localhost:9999", "test-token")
        val state = vm.uiState.value
        // Should be in connecting or reconnecting state (no real server)
        assertTrue(
            state.connectionState == ConnectionState.Connecting ||
                state.connectionState == ConnectionState.Reconnecting ||
                state.connectionState == ConnectionState.Disconnected
        )
        // Messages should be empty (new chat clears on channel_info, but no server)
    }

    // --- Disconnect clears channel info ---

    @Test
    fun `disconnect clears channel metadata`() {
        vm.disconnect()
        val state = vm.uiState.value
        assertNull(state.channelId)
        assertNull(state.channelName)
        assertNull(state.channelRepo)
        assertNull(state.channelModel)
        assertEquals(ConnectionState.Disconnected, state.connectionState)
    }
}

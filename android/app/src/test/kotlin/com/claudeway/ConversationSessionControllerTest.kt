package com.claudeway

import android.media.AudioDeviceInfo
import com.claudeway.audio.AudioPlayer
import com.claudeway.audio.AudioRecorder
import com.claudeway.network.AudioStartMessage
import com.claudeway.network.AudioEndMessage
import com.claudeway.network.CancelMessage
import com.claudeway.network.ChannelInfoServerMessage
import com.claudeway.network.ClientMessage
import com.claudeway.network.ClaudewayWebSocket
import com.claudeway.network.ConnectionState
import com.claudeway.network.ErrorServerMessage
import com.claudeway.network.ResponseAudioEndServerMessage
import com.claudeway.network.ResponseTextServerMessage
import com.claudeway.network.StatusServerMessage
import com.claudeway.network.TextMessage
import com.claudeway.network.TranscriptServerMessage
import com.claudeway.voice.ConversationSessionController
import com.claudeway.voice.MessageRole
import com.claudeway.voice.UiState
import com.claudeway.voice.VoiceFlowState
import io.mockk.every
import io.mockk.mockk
import io.mockk.verify
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.test.UnconfinedTestDispatcher
import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner

@OptIn(ExperimentalCoroutinesApi::class)
@RunWith(RobolectricTestRunner::class)
class ConversationSessionControllerTest {

    private lateinit var uiState: MutableStateFlow<UiState>
    private lateinit var webSocket: ClaudewayWebSocket
    private lateinit var audioRecorder: AudioRecorder
    private lateinit var audioPlayer: AudioPlayer
    private lateinit var controller: ConversationSessionController
    private val sentMessages = mutableListOf<ClientMessage>()

    @Before
    fun setup() {
        sentMessages.clear()
        uiState = MutableStateFlow(UiState(connectionState = ConnectionState.Connected))
        webSocket = mockk(relaxed = true) {
            every { send(any<ClientMessage>()) } answers {
                sentMessages.add(firstArg())
                true
            }
            every { connectionState } returns MutableStateFlow(ConnectionState.Connected)
        }
        audioRecorder = mockk(relaxed = true) {
            every { micLevel } returns MutableStateFlow(0f)
        }
        audioPlayer = mockk(relaxed = true)

        val scope = CoroutineScope(UnconfinedTestDispatcher())
        controller = ConversationSessionController(
            scope = scope,
            uiState = uiState,
            webSocket = webSocket,
            audioRecorder = audioRecorder,
            audioPlayer = audioPlayer,
            prepareAudioRoute = { null },
            routedDeviceProvider = { null },
        )
    }

    // --- sendText connected flow ---

    @Test
    fun `sendText sends TextMessage and transitions to Thinking`() {
        controller.sendText("hello world")

        val state = uiState.value
        assertEquals(VoiceFlowState.Thinking, state.voiceFlowState)
        assertNotNull(state.currentRequestId)
        assertEquals("Thinking...", state.statusText)
        // User message added
        val userMsg = state.messages.find { it.role == MessageRole.User }
        assertNotNull(userMsg)
        assertEquals("hello world", userMsg!!.text)
        // WebSocket received a TextMessage
        val sent = sentMessages.filterIsInstance<TextMessage>()
        assertEquals(1, sent.size)
        assertEquals("hello world", sent[0].text)
    }

    @Test
    fun `sendText with blank text is a no-op`() {
        controller.sendText("   ")
        assertEquals(VoiceFlowState.Idle, uiState.value.voiceFlowState)
        assertTrue(uiState.value.messages.isEmpty())
        assertTrue(sentMessages.isEmpty())
    }

    // --- Transcript handling ---

    @Test
    fun `handleServerMessage transcript partial updates activeTranscript`() {
        controller.sendText("test")
        val requestId = uiState.value.currentRequestId!!

        controller.handleServerMessage(
            TranscriptServerMessage(requestId = requestId, text = "partial", isFinal = false)
        )

        assertEquals("partial", uiState.value.activeTranscript)
    }

    @Test
    fun `handleServerMessage transcript final adds User message and clears activeTranscript`() {
        controller.sendText("test")
        val requestId = uiState.value.currentRequestId!!

        controller.handleServerMessage(
            TranscriptServerMessage(requestId = requestId, text = "final text", isFinal = true)
        )

        assertNull(uiState.value.activeTranscript)
        val userMsgs = uiState.value.messages.filter { it.role == MessageRole.User }
        // Original sendText user msg + transcript user msg
        assertEquals(2, userMsgs.size)
        assertEquals("final text", userMsgs[1].text)
    }

    // --- Response text handling ---

    @Test
    fun `handleServerMessage response_text accumulates and shows activeResponseText`() {
        controller.sendText("test")
        val requestId = uiState.value.currentRequestId!!

        controller.handleServerMessage(
            ResponseTextServerMessage(requestId = requestId, text = "Hello ", isFinal = false)
        )
        assertEquals("Hello ", uiState.value.activeResponseText)

        controller.handleServerMessage(
            ResponseTextServerMessage(requestId = requestId, text = "world!", isFinal = false)
        )
        assertEquals("Hello world!", uiState.value.activeResponseText)
    }

    @Test
    fun `handleServerMessage response_text final adds Assistant message`() {
        controller.sendText("test")
        val requestId = uiState.value.currentRequestId!!

        controller.handleServerMessage(
            ResponseTextServerMessage(requestId = requestId, text = "The answer is 42.", isFinal = false)
        )
        controller.handleServerMessage(
            ResponseTextServerMessage(requestId = requestId, text = "", isFinal = true)
        )

        assertNull(uiState.value.activeResponseText)
        val assistantMsgs = uiState.value.messages.filter { it.role == MessageRole.Assistant }
        assertEquals(1, assistantMsgs.size)
        assertEquals("The answer is 42.", assistantMsgs[0].text)
    }

    @Test
    fun `response_text final with TTS muted resets to Idle`() {
        // Disable TTS before sending
        uiState.value = uiState.value.copy(ttsEnabled = false)
        controller.sendText("test")
        val requestId = uiState.value.currentRequestId!!

        controller.handleServerMessage(
            ResponseTextServerMessage(requestId = requestId, text = "done", isFinal = true)
        )

        assertEquals(VoiceFlowState.Idle, uiState.value.voiceFlowState)
        assertNull(uiState.value.currentRequestId)
    }

    // --- Status handling ---

    @Test
    fun `handleServerMessage status thinking updates flow state`() {
        controller.sendText("test")
        val requestId = uiState.value.currentRequestId!!

        controller.handleServerMessage(
            StatusServerMessage(requestId = requestId, status = "thinking")
        )

        assertEquals(VoiceFlowState.Thinking, uiState.value.voiceFlowState)
        assertEquals("Thinking...", uiState.value.statusText)
    }

    @Test
    fun `handleServerMessage status transcribing updates flow state`() {
        controller.sendText("test")
        val requestId = uiState.value.currentRequestId!!

        controller.handleServerMessage(
            StatusServerMessage(requestId = requestId, status = "transcribing")
        )

        assertEquals(VoiceFlowState.Transcribing, uiState.value.voiceFlowState)
        assertEquals("Transcribing...", uiState.value.statusText)
    }

    @Test
    fun `handleServerMessage status tool shows tool info`() {
        controller.sendText("test")
        val requestId = uiState.value.currentRequestId!!

        controller.handleServerMessage(
            StatusServerMessage(
                requestId = requestId, status = "tool",
                toolName = "Read", keyArg = "src/index.ts", phase = "running",
            )
        )

        assertEquals(VoiceFlowState.Thinking, uiState.value.voiceFlowState)
        assertTrue(uiState.value.statusText!!.contains("Read"))
    }

    @Test
    fun `handleServerMessage status tool complete adds Status message`() {
        controller.sendText("test")
        val requestId = uiState.value.currentRequestId!!

        controller.handleServerMessage(
            StatusServerMessage(
                requestId = requestId, status = "tool",
                toolName = "Bash", keyArg = "ls", phase = "complete",
            )
        )

        val statusMsgs = uiState.value.messages.filter { it.role == MessageRole.Status }
        assertEquals(1, statusMsgs.size)
        assertTrue(statusMsgs[0].text.contains("Bash"))
    }

    // --- Response audio end ---

    @Test
    fun `handleServerMessage response_audio_end resets to Idle`() {
        controller.sendText("test")
        val requestId = uiState.value.currentRequestId!!

        controller.handleServerMessage(
            ResponseAudioEndServerMessage(requestId = requestId)
        )

        assertEquals(VoiceFlowState.Idle, uiState.value.voiceFlowState)
        assertNull(uiState.value.currentRequestId)
        verify { audioPlayer.endOfAudio() }
    }

    // --- Error handling ---

    @Test
    fun `handleServerMessage error cancelled resets to Idle without error message`() {
        controller.sendText("test")
        val requestId = uiState.value.currentRequestId!!

        controller.handleServerMessage(
            ErrorServerMessage(requestId = requestId, message = "cancelled")
        )

        assertEquals(VoiceFlowState.Idle, uiState.value.voiceFlowState)
        // "cancelled" should not add an error message
        assertTrue(uiState.value.messages.none { it.role == MessageRole.Error })
    }

    @Test
    fun `handleServerMessage error no speech detected adds Status message`() {
        controller.sendText("test")
        val requestId = uiState.value.currentRequestId!!

        controller.handleServerMessage(
            ErrorServerMessage(requestId = requestId, message = "No speech detected")
        )

        assertEquals(VoiceFlowState.Idle, uiState.value.voiceFlowState)
        val statusMsgs = uiState.value.messages.filter { it.role == MessageRole.Status }
        assertTrue(statusMsgs.any { it.text.contains("No speech detected") })
    }

    @Test
    fun `handleServerMessage error with real error shows Error state`() {
        controller.sendText("test")
        val requestId = uiState.value.currentRequestId!!

        controller.handleServerMessage(
            ErrorServerMessage(requestId = requestId, message = "Internal server error")
        )

        assertEquals(VoiceFlowState.Error, uiState.value.voiceFlowState)
        val errorMsgs = uiState.value.messages.filter { it.role == MessageRole.Error }
        assertEquals(1, errorMsgs.size)
        assertEquals("Internal server error", errorMsgs[0].text)
    }

    @Test
    fun `handleServerMessage ignores messages for wrong requestId`() {
        controller.sendText("test")
        val state = uiState.value

        controller.handleServerMessage(
            ResponseTextServerMessage(requestId = "wrong-id", text = "stale", isFinal = false)
        )

        // State unchanged
        assertNull(uiState.value.activeResponseText)
    }

    // --- Cancel mid-flow ---

    @Test
    fun `cancelCurrentRequest during Thinking sends cancel and resets`() {
        controller.sendText("test")
        val requestId = uiState.value.currentRequestId!!
        assertEquals(VoiceFlowState.Thinking, uiState.value.voiceFlowState)

        controller.cancelCurrentRequest()

        assertEquals(VoiceFlowState.Idle, uiState.value.voiceFlowState)
        assertNull(uiState.value.currentRequestId)
        // Verify cancel was sent
        val cancelMsgs = sentMessages.filterIsInstance<CancelMessage>()
        assertEquals(1, cancelMsgs.size)
        assertEquals(requestId, cancelMsgs[0].requestId)
    }

    @Test
    fun `cancelCurrentRequest with accumulated response text preserves it as message`() {
        controller.sendText("test")
        val requestId = uiState.value.currentRequestId!!

        // Simulate partial response
        controller.handleServerMessage(
            ResponseTextServerMessage(requestId = requestId, text = "Partial answer...", isFinal = false)
        )

        controller.cancelCurrentRequest()

        // Partial response should be saved as Assistant message
        val assistantMsgs = uiState.value.messages.filter { it.role == MessageRole.Assistant }
        assertEquals(1, assistantMsgs.size)
        assertEquals("Partial answer...", assistantMsgs[0].text)
    }

    // --- New chat ---

    @Test
    fun `prepareForNewChat interrupts active request and resets`() {
        controller.sendText("test")
        assertNotNull(uiState.value.currentRequestId)

        controller.prepareForNewChat()

        assertEquals(VoiceFlowState.Idle, uiState.value.voiceFlowState)
        assertNull(uiState.value.currentRequestId)
    }

    @Test
    fun `channel_info clears messages when pendingNewChat`() {
        // Seed a message
        controller.sendText("old message")
        assertTrue(uiState.value.messages.isNotEmpty())

        controller.prepareForNewChat()
        controller.markPendingNewChat()

        controller.handleServerMessage(
            ChannelInfoServerMessage(
                channelId = "ch-1", channelName = "test", repo = "repo", model = "opus"
            )
        )

        assertTrue(uiState.value.messages.isEmpty())
        assertEquals("ch-1", uiState.value.channelId)
        assertEquals("test", uiState.value.channelName)
    }

    @Test
    fun `channel_info preserves messages when not pendingNewChat`() {
        controller.sendText("keep this")

        controller.handleServerMessage(
            ChannelInfoServerMessage(
                channelId = "ch-1", channelName = "test", repo = null, model = "sonnet"
            )
        )

        assertTrue(uiState.value.messages.isNotEmpty())
    }

    // --- TTS toggle ---

    @Test
    fun `toggleTts flips state and stops audio when disabling`() {
        assertTrue(uiState.value.ttsEnabled)

        controller.toggleTts()

        assertEquals(false, uiState.value.ttsEnabled)
        verify { audioPlayer.stop() }
    }

    @Test
    fun `toggleTts re-enables without stopping audio`() {
        controller.toggleTts() // disable
        controller.toggleTts() // re-enable

        assertTrue(uiState.value.ttsEnabled)
        // stop() called only once (on disable)
        verify(exactly = 1) { audioPlayer.stop() }
    }

    // --- Consecutive requests ---

    @Test
    fun `second sendText interrupts first request`() {
        controller.sendText("first")
        val firstId = uiState.value.currentRequestId!!

        controller.sendText("second")
        val secondId = uiState.value.currentRequestId!!

        assertTrue(firstId != secondId)
        // Cancel should have been sent for first request
        val cancelMsgs = sentMessages.filterIsInstance<CancelMessage>()
        assertEquals(1, cancelMsgs.size)
        assertEquals(firstId, cancelMsgs[0].requestId)
        // Two TextMessages sent
        val textMsgs = sentMessages.filterIsInstance<TextMessage>()
        assertEquals(2, textMsgs.size)
    }
}

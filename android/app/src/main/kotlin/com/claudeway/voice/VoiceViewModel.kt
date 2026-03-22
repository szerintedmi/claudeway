package com.claudeway.voice

import android.app.Application
import androidx.lifecycle.AndroidViewModel
import androidx.lifecycle.viewModelScope
import com.claudeway.audio.AudioDevice
import com.claudeway.audio.AudioPlayer
import com.claudeway.audio.AudioRecorder
import com.claudeway.audio.AudioRouteState
import com.claudeway.audio.AudioRouter
import com.claudeway.audio.DeviceToast
import com.claudeway.glasses.GlassesManager
import com.claudeway.glasses.GlassesState
import com.claudeway.network.AudioChunkMessage
import com.claudeway.network.AudioEndMessage
import com.claudeway.network.AudioFormat
import com.claudeway.network.AudioStartMessage
import com.claudeway.network.CancelMessage
import com.claudeway.network.ClaudewayWebSocket
import com.claudeway.network.ConnectionError
import com.claudeway.network.ConnectionState
import com.claudeway.network.ErrorServerMessage
import com.claudeway.network.ResponseAudioEndServerMessage
import com.claudeway.network.ResponseAudioServerMessage
import com.claudeway.network.ResponseTextServerMessage
import com.claudeway.network.ServerMessage
import com.claudeway.network.StatusServerMessage
import com.claudeway.network.TextMessage
import com.claudeway.network.TranscriptServerMessage
import androidx.lifecycle.DefaultLifecycleObserver
import androidx.lifecycle.LifecycleOwner
import androidx.lifecycle.ProcessLifecycleOwner
import kotlinx.coroutines.Job
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.SharedFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import java.util.UUID

// --- UI State ---

enum class VoiceFlowState {
    Idle,
    Recording,
    Transcribing,
    Thinking,
    Speaking,
    Error,
}

data class ConversationMessage(
    val requestId: String,
    val role: MessageRole,
    val text: String,
    val timestamp: Long = System.currentTimeMillis(),
)

enum class MessageRole { User, Assistant, Error, Status }

/** Text vs Voice input mode for the dual-mode input bar. */
enum class InputMode { Text, Voice }

data class UiState(
    val connectionState: ConnectionState = ConnectionState.Disconnected,
    val connectionError: ConnectionError? = null,
    val glassesState: GlassesState = GlassesState.NotInitialized,
    val audioRouteState: AudioRouteState = AudioRouteState.NoDevice,
    val voiceFlowState: VoiceFlowState = VoiceFlowState.Idle,
    val currentRequestId: String? = null,
    val statusText: String? = null,
    val messages: List<ConversationMessage> = emptyList(),
    val activeTranscript: String? = null,
    val activeResponseText: String? = null,
    val inputMode: InputMode = InputMode.Voice,
)

// --- ViewModel ---

class VoiceViewModel(application: Application) : AndroidViewModel(application) {
    val webSocket = ClaudewayWebSocket(viewModelScope)
    val audioRouter = AudioRouter(application, viewModelScope)
    val glassesManager = GlassesManager(application)
    private val audioRecorder = AudioRecorder()
    private val audioPlayer = AudioPlayer(viewModelScope)

    private val _uiState = MutableStateFlow(UiState())
    val uiState: StateFlow<UiState> = _uiState.asStateFlow()

    /** Normalized mic level (0-1) for the voice visualizer. */
    val micLevel: StateFlow<Float> = audioRecorder.micLevel

    val availableRoutes: StateFlow<List<AudioDevice>> = audioRouter.availableRoutes

    val activeRouteId: StateFlow<Int?> = audioRouter.activeRouteId

    val selectedRouteId: StateFlow<Int> = audioRouter.selectedRouteId

    /** Device connect/disconnect toast events. */
    val deviceToasts: SharedFlow<DeviceToast> = audioRouter.toasts

    private var recordingJob: Job? = null
    private var currentRequestId: String? = null

    // Accumulate streaming response text per request
    private val responseTextAccumulator = StringBuilder()

    private val lifecycleObserver = object : DefaultLifecycleObserver {
        override fun onStart(owner: LifecycleOwner) {
            // App returned to foreground — reconnect immediately if needed
            webSocket.reconnectNow()
        }
    }

    init {
        // Observe WebSocket connection state
        viewModelScope.launch {
            webSocket.connectionState.collect { state ->
                _uiState.update { it.copy(connectionState = state) }
            }
        }

        // Observe connection errors
        viewModelScope.launch {
            webSocket.connectionError.collect { error ->
                _uiState.update { it.copy(connectionError = error) }
            }
        }

        // Observe glasses state
        viewModelScope.launch {
            glassesManager.state.collect { state ->
                _uiState.update { it.copy(glassesState = state) }
            }
        }

        // Observe audio route state and keep player's preferred device in sync
        viewModelScope.launch {
            audioRouter.state.collect { state ->
                _uiState.update { it.copy(audioRouteState = state) }
                audioPlayer.preferredDevice = audioRouter.routedDevice
            }
        }

        // Process incoming server messages
        viewModelScope.launch {
            webSocket.messages.collect { msg ->
                handleServerMessage(msg)
            }
        }

        // Initialize glasses manager
        glassesManager.initialize()

        // Reconnect immediately when app returns to foreground
        ProcessLifecycleOwner.get().lifecycle.addObserver(lifecycleObserver)
    }

    // --- Input mode ---

    fun setInputMode(mode: InputMode) {
        _uiState.update { it.copy(inputMode = mode) }
    }

    // --- Audio device management ---

    fun applyAudioRouteSelection(routeId: Int) {
        audioRouter.applyRouteSelection(routeId)
    }

    // --- Connection ---

    fun connect(url: String, token: String) {
        webSocket.connect(url, token)
        audioRouter.startSession()
    }

    fun disconnect() {
        webSocket.disconnect()
        audioRouter.endSession()
    }

    // --- Text input ---

    fun sendText(text: String) {
        if (text.isBlank()) return

        // Barge-in: cancel active request before sending new one
        interruptIfActive()

        val requestId = UUID.randomUUID().toString()

        if (!webSocket.send(TextMessage(requestId = requestId, text = text))) {
            showSendError()
            return
        }

        currentRequestId = requestId
        responseTextAccumulator.clear()
        _uiState.update {
            it.copy(
                voiceFlowState = VoiceFlowState.Thinking,
                currentRequestId = requestId,
                statusText = "Thinking...",
                messages = it.messages + ConversationMessage(requestId, MessageRole.User, text),
                activeResponseText = null,
            )
        }
    }

    // --- Voice input (push-to-talk) ---

    fun startRecording() {
        if (_uiState.value.voiceFlowState == VoiceFlowState.Recording) return

        // Barge-in: cancel active request before starting new recording
        interruptIfActive()

        val requestId = UUID.randomUUID().toString()

        val sent = webSocket.send(
            AudioStartMessage(
                requestId = requestId,
                format = AudioFormat(
                    mimeType = AudioRecorder.MIME_TYPE,
                    sampleRate = AudioRecorder.SAMPLE_RATE,
                    channels = 1,
                    encoding = "linear16",
                ),
            )
        )
        if (!sent) {
            showSendError()
            return
        }

        currentRequestId = requestId
        responseTextAccumulator.clear()
        _uiState.update {
            it.copy(
                voiceFlowState = VoiceFlowState.Recording,
                currentRequestId = requestId,
                statusText = "Recording...",
                activeTranscript = null,
                activeResponseText = null,
            )
        }

        // Start capturing and streaming audio chunks
        recordingJob = viewModelScope.launch {
            audioRecorder.startRecording(preferredDevice = audioRouter.routedDevice).collect { pcmData ->
                val base64 = audioRecorder.encodeToBase64(pcmData)
                if (!webSocket.send(AudioChunkMessage(requestId = requestId, data = base64))) {
                    // Connection lost during recording — abort
                    stopRecording()
                    resetToIdle()
                    showSendError()
                    return@collect
                }
            }
        }
    }

    fun stopRecording() {
        val requestId = currentRequestId ?: return
        audioRecorder.stopRecording()
        recordingJob?.cancel()
        recordingJob = null

        if (!webSocket.send(AudioEndMessage(requestId = requestId))) {
            resetToIdle()
            showSendError()
            return
        }

        _uiState.update {
            it.copy(
                voiceFlowState = VoiceFlowState.Transcribing,
                statusText = "Transcribing...",
            )
        }
    }

    // --- Cancellation ---

    /**
     * Interrupt the active request (barge-in). Stops audio/recording and sends cancel,
     * but does NOT reset UI to idle — the caller is about to start a new request.
     */
    private fun interruptIfActive() {
        val activeId = currentRequestId ?: return
        audioPlayer.stop()
        audioRecorder.stopRecording()
        recordingJob?.cancel()
        recordingJob = null
        webSocket.send(CancelMessage(requestId = activeId))

        // Preserve any accumulated response text in history before clearing
        val accumulatedText = responseTextAccumulator.toString()
        currentRequestId = null
        responseTextAccumulator.clear()
        _uiState.update {
            val updatedMessages = if (accumulatedText.isNotBlank()) {
                it.messages + ConversationMessage(activeId, MessageRole.Assistant, accumulatedText)
            } else {
                it.messages
            }
            it.copy(
                currentRequestId = null,
                activeTranscript = null,
                activeResponseText = null,
                messages = updatedMessages,
            )
        }
    }

    fun cancelCurrentRequest() {
        interruptIfActive()
        resetToIdle()
    }

    // --- Helpers ---

    private fun resetToIdle() {
        _uiState.update {
            it.copy(
                voiceFlowState = VoiceFlowState.Idle,
                currentRequestId = null,
                statusText = null,
                activeTranscript = null,
                activeResponseText = null,
            )
        }
        currentRequestId = null
        responseTextAccumulator.clear()
    }

    private fun showSendError() {
        _uiState.update { state ->
            state.copy(
                voiceFlowState = VoiceFlowState.Error,
                statusText = "Not connected",
                messages = state.messages + ConversationMessage(
                    "", MessageRole.Error, "Failed to send — not connected to server"
                ),
            )
        }
    }

    // --- Server message handling ---

    private fun handleServerMessage(msg: ServerMessage) {
        when (msg) {
            is StatusServerMessage -> handleStatus(msg)
            is TranscriptServerMessage -> handleTranscript(msg)
            is ResponseTextServerMessage -> handleResponseText(msg)
            is ResponseAudioServerMessage -> handleResponseAudio(msg)
            is ResponseAudioEndServerMessage -> handleResponseAudioEnd(msg)
            is ErrorServerMessage -> handleError(msg)
            else -> {} // pong etc.
        }
    }

    /** Check if a requestId-bearing message belongs to the current active request. */
    private fun isActiveRequest(requestId: String): Boolean =
        requestId == currentRequestId

    private fun handleStatus(msg: StatusServerMessage) {
        if (!isActiveRequest(msg.requestId)) return

        // Add completed tool/agent events as inline status messages
        if (msg.status == "tool") {
            when (msg.phase) {
                "complete" -> {
                    val toolText = buildString {
                        append(msg.toolName ?: "Tool")
                        msg.keyArg?.let {
                            val truncated = if (it.length > 60) it.take(57) + "..." else it
                            append("($truncated)")
                        }
                    }
                    _uiState.update { state ->
                        state.copy(
                            voiceFlowState = VoiceFlowState.Thinking,
                            statusText = "Thinking...",
                            messages = state.messages + ConversationMessage(
                                msg.requestId, MessageRole.Status, toolText
                            ),
                        )
                    }
                    return
                }
                "subagent_completed" -> {
                    val agentText = buildString {
                        append(msg.toolName ?: "Agent")
                        msg.description?.let { append("($it)") }
                        msg.usage?.let { u ->
                            append("\n└ Done")
                            val parts = mutableListOf<String>()
                            if (u.toolUses > 0) parts.add("${u.toolUses} tool use${if (u.toolUses != 1) "s" else ""}")
                            if (u.tokens > 0) {
                                val k = if (u.tokens >= 1000) "${"%.1f".format(u.tokens / 1000.0)}k" else "${u.tokens}"
                                parts.add("$k tokens")
                            }
                            if (u.durationMs > 0) parts.add("${u.durationMs / 1000}s")
                            if (parts.isNotEmpty()) append(" (${parts.joinToString(" · ")})")
                        }
                    }
                    _uiState.update { state ->
                        state.copy(
                            voiceFlowState = VoiceFlowState.Thinking,
                            statusText = "Thinking...",
                            messages = state.messages + ConversationMessage(
                                msg.requestId, MessageRole.Status, agentText
                            ),
                        )
                    }
                    return
                }
            }
        }

        val statusText = when (msg.status) {
            "transcribing" -> "Transcribing..."
            "thinking" -> "Thinking..."
            "speaking" -> "Speaking..."
            "tool" -> buildString {
                if (msg.phase == "subagent_progress" && msg.description != null) {
                    append("Agent: ${msg.description}")
                } else {
                    append("Using tool")
                    msg.toolName?.let { append(": $it") }
                    msg.keyArg?.let { append(" ($it)") }
                }
            }
            else -> msg.status
        }

        val flowState = when (msg.status) {
            "transcribing" -> VoiceFlowState.Transcribing
            "thinking" -> VoiceFlowState.Thinking
            "speaking" -> VoiceFlowState.Speaking
            "tool" -> VoiceFlowState.Thinking
            else -> _uiState.value.voiceFlowState
        }

        _uiState.update {
            it.copy(voiceFlowState = flowState, statusText = statusText)
        }
    }

    private fun handleTranscript(msg: TranscriptServerMessage) {
        if (!isActiveRequest(msg.requestId)) return

        _uiState.update { state ->
            if (msg.isFinal) {
                state.copy(
                    activeTranscript = null,
                    messages = state.messages + ConversationMessage(
                        msg.requestId, MessageRole.User, msg.text
                    ),
                )
            } else {
                state.copy(activeTranscript = msg.text)
            }
        }
    }

    private fun handleResponseText(msg: ResponseTextServerMessage) {
        if (!isActiveRequest(msg.requestId)) return

        responseTextAccumulator.append(msg.text)
        val fullText = responseTextAccumulator.toString()

        _uiState.update { state ->
            if (msg.isFinal) {
                state.copy(
                    activeResponseText = null,
                    messages = state.messages + ConversationMessage(
                        msg.requestId, MessageRole.Assistant, fullText
                    ),
                )
            } else {
                state.copy(activeResponseText = fullText)
            }
        }

        if (msg.isFinal) {
            responseTextAccumulator.clear()
        }
    }

    private fun handleResponseAudio(msg: ResponseAudioServerMessage) {
        if (!isActiveRequest(msg.requestId)) return

        audioPlayer.queueAudio(msg.data, msg.sampleRate)
        _uiState.update {
            it.copy(voiceFlowState = VoiceFlowState.Speaking, statusText = "Speaking...")
        }
    }

    private fun handleResponseAudioEnd(msg: ResponseAudioEndServerMessage) {
        if (!isActiveRequest(msg.requestId)) return

        audioPlayer.endOfAudio()
        _uiState.update {
            it.copy(
                voiceFlowState = VoiceFlowState.Idle,
                currentRequestId = null,
                statusText = null,
            )
        }
        currentRequestId = null
    }

    private fun handleError(msg: ErrorServerMessage) {
        // Error with null requestId is connection-level — always handle
        // Error with a stale requestId — ignore
        if (msg.requestId != null && !isActiveRequest(msg.requestId)) return

        audioPlayer.stop()
        if (msg.message == "cancelled") {
            _uiState.update {
                it.copy(
                    voiceFlowState = VoiceFlowState.Idle,
                    currentRequestId = null,
                    statusText = null,
                )
            }
        } else if (msg.message == "No speech detected") {
            _uiState.update { state ->
                state.copy(
                    voiceFlowState = VoiceFlowState.Idle,
                    currentRequestId = null,
                    statusText = null,
                    messages = state.messages + ConversationMessage(
                        msg.requestId ?: "", MessageRole.Status, "No speech detected"
                    ),
                )
            }
        } else {
            _uiState.update { state ->
                state.copy(
                    voiceFlowState = VoiceFlowState.Error,
                    statusText = "Error: ${msg.message}",
                    messages = state.messages + ConversationMessage(
                        msg.requestId ?: "", MessageRole.Error, msg.message
                    ),
                )
            }
        }
        if (msg.requestId == currentRequestId) {
            currentRequestId = null
        }
    }

    // --- Cleanup ---

    override fun onCleared() {
        super.onCleared()
        ProcessLifecycleOwner.get().lifecycle.removeObserver(lifecycleObserver)
        audioPlayer.stop()
        audioRecorder.stopRecording()
        audioRouter.destroy()
        glassesManager.release()
        webSocket.disconnect()
    }
}

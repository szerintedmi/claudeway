package com.claudeway.voice

import android.media.AudioDeviceInfo
import com.claudeway.audio.AudioPlayer
import com.claudeway.audio.AudioRecorder
import com.claudeway.network.AudioChunkMessage
import com.claudeway.network.AudioEndMessage
import com.claudeway.network.AudioFormat
import com.claudeway.network.AudioStartMessage
import com.claudeway.network.CancelMessage
import com.claudeway.network.ChannelInfoServerMessage
import com.claudeway.network.ClaudewayWebSocket
import com.claudeway.network.ConnectionState
import com.claudeway.network.ErrorServerMessage
import com.claudeway.network.ResponseAudioEndServerMessage
import com.claudeway.network.ResponseAudioServerMessage
import com.claudeway.network.ResponseTextServerMessage
import com.claudeway.network.ServerMessage
import com.claudeway.network.StatusServerMessage
import com.claudeway.network.TextMessage
import com.claudeway.network.TranscriptServerMessage
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import java.util.ArrayDeque
import java.util.UUID

class ConversationSessionController(
    private val scope: CoroutineScope,
    private val uiState: MutableStateFlow<UiState>,
    private val webSocket: ClaudewayWebSocket,
    private val audioRecorder: AudioRecorder,
    private val audioPlayer: AudioPlayer,
    private val prepareAudioRoute: () -> AudioDeviceInfo?,
    private val routedDeviceProvider: () -> AudioDeviceInfo?,
) {
    private var recordingJob: Job? = null
    private var currentRequestId: String? = null
    private var currentRequestTtsMuted = false
    private var pendingNewChat = false
    private val responseTextAccumulator = StringBuilder()
    private val pendingAudioChunks = ArrayDeque<ByteArray>()
    private var recordingReady = false
    private var streamingAudio = false
    private var responseAudioRoutePreparedForRequestId: String? = null

    companion object {
        private const val PRE_ROLL_MS = 240
        private val PRE_ROLL_CHUNKS = maxOf(1, PRE_ROLL_MS / AudioRecorder.CHUNK_DURATION_MS)
        private const val DEFAULT_TTS_SAMPLE_RATE = 16000
    }

    fun toggleTts() {
        val wasEnabled = uiState.value.ttsEnabled
        uiState.update { it.copy(ttsEnabled = !wasEnabled) }
        if (wasEnabled) {
            audioPlayer.stop()
        }
    }

    fun prepareForNewChat() {
        interruptIfActive()
        resetToIdle()
    }

    fun markPendingNewChat() {
        pendingNewChat = true
    }

    fun clearPendingNewChat() {
        pendingNewChat = false
    }

    fun sendText(text: String) {
        if (text.isBlank()) return

        interruptIfActive()

        val requestId = UUID.randomUUID().toString()
        val ttsMuted = !uiState.value.ttsEnabled
        val ttsFlag = if (ttsMuted) false else null
        if (!webSocket.send(TextMessage(requestId = requestId, text = text, tts = ttsFlag))) {
            showSendError()
            return
        }

        currentRequestId = requestId
        currentRequestTtsMuted = ttsMuted
        responseAudioRoutePreparedForRequestId = null
        responseTextAccumulator.clear()
        uiState.update {
            it.copy(
                voiceFlowState = VoiceFlowState.Thinking,
                currentRequestId = requestId,
                statusText = "Thinking...",
                messages = it.messages + ConversationMessage(requestId, MessageRole.User, text),
                activeResponseText = null,
            )
        }
    }

    fun startRecording() {
        if (
            uiState.value.voiceFlowState == VoiceFlowState.Preparing ||
            uiState.value.voiceFlowState == VoiceFlowState.Recording
        ) return

        if (uiState.value.connectionState != ConnectionState.Connected) {
            showSendError()
            return
        }

        interruptIfActive()

        val requestId = UUID.randomUUID().toString()
        val ttsMuted = !uiState.value.ttsEnabled
        val ttsFlag = if (ttsMuted) false else null

        if (!webSocket.send(
                AudioStartMessage(
                    requestId = requestId,
                    format = AudioFormat(
                        mimeType = AudioRecorder.MIME_TYPE,
                        sampleRate = AudioRecorder.SAMPLE_RATE,
                        channels = 1,
                        encoding = "linear16",
                    ),
                    tts = ttsFlag,
                )
            )
        ) {
            showSendError()
            return
        }

        currentRequestId = requestId
        currentRequestTtsMuted = ttsMuted
        responseAudioRoutePreparedForRequestId = null
        recordingReady = false
        streamingAudio = false
        pendingAudioChunks.clear()
        responseTextAccumulator.clear()
        uiState.update {
            it.copy(
                voiceFlowState = VoiceFlowState.Preparing,
                currentRequestId = requestId,
                statusText = "Preparing microphone...",
                activeTranscript = null,
                activeResponseText = null,
            )
        }

        recordingJob = scope.launch {
            try {
                val preparedDevice = prepareAudioRoute() ?: routedDeviceProvider()
                audioRecorder.startRecording(preferredDevice = preparedDevice).collect { pcmData ->
                    pendingAudioChunks.addLast(pcmData)
                    if (!recordingReady) {
                        recordingReady = true
                        uiState.update {
                            it.copy(
                                voiceFlowState = VoiceFlowState.Recording,
                                statusText = "Recording...",
                            )
                        }
                    }

                    if (!streamingAudio) {
                        if (pendingAudioChunks.size < PRE_ROLL_CHUNKS) {
                            return@collect
                        }
                        streamingAudio = true
                        if (!flushPendingAudio(requestId)) {
                            return@collect
                        }
                        return@collect
                    }

                    if (!sendAudioChunk(requestId, pendingAudioChunks.removeFirst())) {
                        return@collect
                    }
                }
            } catch (e: CancellationException) {
                throw e
            } catch (_: Exception) {
                resetToIdle()
                showOperationError("Microphone unavailable")
            }
        }
    }

    fun stopRecording() {
        val requestId = currentRequestId ?: return
        audioRecorder.stopRecording()
        recordingJob?.cancel()
        recordingJob = null

        if (!streamingAudio && pendingAudioChunks.isNotEmpty()) {
            if (!flushPendingAudio(requestId)) {
                return
            }
        }

        if (!webSocket.send(AudioEndMessage(requestId = requestId))) {
            resetToIdle()
            showSendError()
            return
        }

        uiState.update {
            it.copy(
                voiceFlowState = VoiceFlowState.Transcribing,
                statusText = "Transcribing...",
            )
        }
    }

    fun cancelCurrentRequest() {
        interruptIfActive()
        resetToIdle()
    }

    fun handleServerMessage(msg: ServerMessage) {
        when (msg) {
            is StatusServerMessage -> handleStatus(msg)
            is TranscriptServerMessage -> handleTranscript(msg)
            is ResponseTextServerMessage -> handleResponseText(msg)
            is ResponseAudioServerMessage -> handleResponseAudio(msg)
            is ResponseAudioEndServerMessage -> handleResponseAudioEnd(msg)
            is ErrorServerMessage -> handleError(msg)
            is ChannelInfoServerMessage -> handleChannelInfo(msg)
            else -> {}
        }
    }

    fun shutdown() {
        audioPlayer.stop()
        audioRecorder.stopRecording()
        recordingJob?.cancel()
        recordingJob = null
    }

    private fun interruptIfActive() {
        val activeId = currentRequestId ?: return
        audioPlayer.stop()
        audioRecorder.stopRecording()
        recordingJob?.cancel()
        recordingJob = null
        webSocket.send(CancelMessage(requestId = activeId))

        val accumulatedText = responseTextAccumulator.toString().trimStart('\n', '\r')
        currentRequestId = null
        responseAudioRoutePreparedForRequestId = null
        responseTextAccumulator.clear()
        uiState.update {
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

    private fun resetToIdle() {
        uiState.update {
            it.copy(
                voiceFlowState = VoiceFlowState.Idle,
                currentRequestId = null,
                statusText = null,
                activeTranscript = null,
                activeResponseText = null,
            )
        }
        currentRequestId = null
        currentRequestTtsMuted = false
        responseAudioRoutePreparedForRequestId = null
        recordingReady = false
        streamingAudio = false
        pendingAudioChunks.clear()
        responseTextAccumulator.clear()
    }

    private fun flushPendingAudio(requestId: String): Boolean {
        while (pendingAudioChunks.isNotEmpty()) {
            if (!sendAudioChunk(requestId, pendingAudioChunks.removeFirst())) {
                return false
            }
        }
        return true
    }

    private fun sendAudioChunk(requestId: String, pcmData: ByteArray): Boolean {
        val base64 = audioRecorder.encodeToBase64(pcmData)
        if (webSocket.send(AudioChunkMessage(requestId = requestId, data = base64))) {
            return true
        }

        audioRecorder.stopRecording()
        recordingJob?.cancel()
        recordingJob = null
        resetToIdle()
        showSendError()
        return false
    }

    private fun showSendError() {
        showOperationError("Failed to send — not connected to server")
    }

    private fun showOperationError(message: String) {
        uiState.update { state ->
            state.copy(
                voiceFlowState = VoiceFlowState.Error,
                statusText = message,
                messages = state.messages + ConversationMessage(
                    "", MessageRole.Error, message
                ),
            )
        }
    }

    private fun isActiveRequest(requestId: String): Boolean = requestId == currentRequestId

    private fun handleChannelInfo(msg: ChannelInfoServerMessage) {
        val clearMessages = pendingNewChat
        pendingNewChat = false
        uiState.update {
            it.copy(
                channelId = msg.channelId,
                channelName = msg.channelName,
                channelRepo = msg.repo,
                channelModel = msg.model,
                messages = if (clearMessages) emptyList() else it.messages,
            )
        }
    }

    private fun handleStatus(msg: StatusServerMessage) {
        if (!isActiveRequest(msg.requestId)) return

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
                    uiState.update { state ->
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
                    uiState.update { state ->
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
            else -> uiState.value.voiceFlowState
        }

        if (
            msg.status == "speaking" &&
            uiState.value.ttsEnabled &&
            responseAudioRoutePreparedForRequestId != msg.requestId
        ) {
            audioPlayer.preferredDevice = prepareAudioRoute() ?: routedDeviceProvider()
            audioPlayer.primePlayback(DEFAULT_TTS_SAMPLE_RATE)
            responseAudioRoutePreparedForRequestId = msg.requestId
        }

        uiState.update {
            it.copy(voiceFlowState = flowState, statusText = statusText)
        }
    }

    private fun handleTranscript(msg: TranscriptServerMessage) {
        if (!isActiveRequest(msg.requestId)) return

        uiState.update { state ->
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
        val fullText = responseTextAccumulator.toString().trimStart('\n', '\r')

        val wasTtsMuted = currentRequestTtsMuted
        uiState.update { state ->
            if (msg.isFinal) {
                state.copy(
                    activeResponseText = null,
                    voiceFlowState = if (wasTtsMuted) VoiceFlowState.Idle else state.voiceFlowState,
                    currentRequestId = if (wasTtsMuted) null else state.currentRequestId,
                    statusText = if (wasTtsMuted) null else state.statusText,
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
            if (wasTtsMuted) {
                currentRequestId = null
            }
        }
    }

    private fun handleResponseAudio(msg: ResponseAudioServerMessage) {
        if (!isActiveRequest(msg.requestId)) return
        if (!uiState.value.ttsEnabled) return

        if (responseAudioRoutePreparedForRequestId != msg.requestId) {
            audioPlayer.preferredDevice = prepareAudioRoute() ?: routedDeviceProvider()
            responseAudioRoutePreparedForRequestId = msg.requestId
        }
        audioPlayer.queueAudio(msg.data, msg.sampleRate)
        uiState.update {
            it.copy(voiceFlowState = VoiceFlowState.Speaking, statusText = "Speaking...")
        }
    }

    private fun handleResponseAudioEnd(msg: ResponseAudioEndServerMessage) {
        if (!isActiveRequest(msg.requestId)) return

        audioPlayer.endOfAudio()
        uiState.update {
            it.copy(
                voiceFlowState = VoiceFlowState.Idle,
                currentRequestId = null,
                statusText = null,
            )
        }
        currentRequestId = null
        responseAudioRoutePreparedForRequestId = null
    }

    private fun handleError(msg: ErrorServerMessage) {
        if (msg.requestId != null && !isActiveRequest(msg.requestId)) return

        audioPlayer.stop()
        if (msg.message == "cancelled") {
            uiState.update {
                it.copy(
                    voiceFlowState = VoiceFlowState.Idle,
                    currentRequestId = null,
                    statusText = null,
                )
            }
        } else if (msg.message == "No speech detected") {
            uiState.update { state ->
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
            uiState.update { state ->
                state.copy(
                    voiceFlowState = VoiceFlowState.Error,
                    statusText = "Error: ${msg.message}",
                    messages = state.messages + ConversationMessage(
                        msg.requestId ?: "", MessageRole.Error, msg.message
                    ),
                )
            }
        }
        responseAudioRoutePreparedForRequestId = null
        if (msg.requestId == currentRequestId) {
            currentRequestId = null
        }
    }

}

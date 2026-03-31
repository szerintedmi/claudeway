package com.claudeway.voice

import android.app.Application
import androidx.lifecycle.AndroidViewModel
import androidx.lifecycle.DefaultLifecycleObserver
import androidx.lifecycle.LifecycleOwner
import androidx.lifecycle.ProcessLifecycleOwner
import androidx.lifecycle.viewModelScope
import com.claudeway.audio.AudioDevice
import com.claudeway.audio.AudioPlayer
import com.claudeway.audio.AudioRecorder
import com.claudeway.audio.AudioRouteState
import com.claudeway.audio.AudioRouter
import com.claudeway.audio.DeviceToast
import com.claudeway.glasses.GlassesManager
import com.claudeway.glasses.GlassesState
import com.claudeway.network.ClaudewayWebSocket
import com.claudeway.network.ConnectionError
import com.claudeway.network.ConnectionState
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.SharedFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch

// --- UI State ---

enum class VoiceFlowState {
    Idle,
    Preparing,
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
    val channelId: String? = null,
    val channelName: String? = null,
    val channelRepo: String? = null,
    val channelModel: String? = null,
    val ttsEnabled: Boolean = true,
)

// --- ViewModel ---

class VoiceViewModel(application: Application) : AndroidViewModel(application) {
    val webSocket = ClaudewayWebSocket(viewModelScope)
    val audioRouter = AudioRouter(application, viewModelScope)
    val glassesManager = GlassesManager(application, viewModelScope)
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

    private val sessionController = ConversationSessionController(
        scope = viewModelScope,
        uiState = _uiState,
        webSocket = webSocket,
        audioRecorder = audioRecorder,
        audioPlayer = audioPlayer,
        prepareAudioRoute = { audioRouter.prepareCommunicationRoute() },
        routedDeviceProvider = { audioRouter.routedDevice },
    )

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
                if (state == ConnectionState.Error) {
                    sessionController.clearPendingNewChat()
                }
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
                sessionController.handleServerMessage(msg)
            }
        }

        // Initialize glasses manager
        glassesManager.initialize()

        // Wire glasses touchpad tap to push-to-talk toggle
        viewModelScope.launch {
            glassesManager.touchpadTapEvents.collect { timestamp ->
                if (timestamp == 0L) return@collect // Initial value, skip
                val state = _uiState.value.voiceFlowState
                if (state == VoiceFlowState.Recording || state == VoiceFlowState.Preparing) {
                    stopRecording()
                } else {
                    startRecording()
                }
            }
        }

        // Reconnect immediately when app returns to foreground
        ProcessLifecycleOwner.get().lifecycle.addObserver(lifecycleObserver)
    }

    // --- Input mode ---

    fun setInputMode(mode: InputMode) {
        _uiState.update { it.copy(inputMode = mode) }
    }

    // --- TTS toggle ---

    fun toggleTts() {
        sessionController.toggleTts()
    }

    // --- New chat ---

    /** Start a new conversation by disconnecting and reconnecting. */
    fun newChat(url: String, token: String) {
        sessionController.prepareForNewChat()
        disconnect()
        connect(url, token)
        sessionController.markPendingNewChat()
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
        sessionController.clearPendingNewChat()
        webSocket.disconnect()
        audioRouter.endSession()
        _uiState.update {
            it.copy(channelId = null, channelName = null, channelRepo = null, channelModel = null)
        }
    }

    // --- Text input ---

    fun sendText(text: String) {
        sessionController.sendText(text)
    }

    // --- Voice input (push-to-talk) ---

    fun startRecording() {
        sessionController.startRecording()
    }

    fun stopRecording() {
        sessionController.stopRecording()
    }

    // --- Cancellation ---

    fun cancelCurrentRequest() {
        sessionController.cancelCurrentRequest()
    }

    // --- Glasses registration ---

    /**
     * Trigger DAT SDK registration flow. Requires an Activity context
     * because the SDK opens the Meta AI app for consent.
     */
    fun registerGlasses(activity: android.app.Activity) {
        glassesManager.startRegistration(activity)
    }

    // --- Volume button PTT ---

    /**
     * Handle a hardware volume-up key press as a push-to-talk toggle.
     * Returns true if the event was consumed (recording toggled).
     */
    fun onVolumeUpPress(): Boolean {
        val state = _uiState.value
        if (state.connectionState != ConnectionState.Connected) return false
        if (state.voiceFlowState == VoiceFlowState.Recording ||
            state.voiceFlowState == VoiceFlowState.Preparing
        ) {
            stopRecording()
        } else {
            startRecording()
        }
        return true
    }

    // --- Cleanup ---

    override fun onCleared() {
        super.onCleared()
        ProcessLifecycleOwner.get().lifecycle.removeObserver(lifecycleObserver)
        sessionController.shutdown()
        audioRouter.destroy()
        glassesManager.release()
        webSocket.disconnect()
    }
}

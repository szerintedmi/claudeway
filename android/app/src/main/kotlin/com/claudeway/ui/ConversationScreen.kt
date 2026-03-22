package com.claudeway.ui

import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Settings
import androidx.compose.material.icons.filled.VolumeOff
import androidx.compose.material.icons.filled.VolumeUp
import androidx.compose.material.icons.outlined.AddComment
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Scaffold
import androidx.compose.material3.SnackbarHost
import androidx.compose.material3.SnackbarHostState
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TopAppBar
import androidx.compose.material3.TopAppBarDefaults
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontWeight
import com.claudeway.audio.AudioDevice
import com.claudeway.audio.AudioRouteState
import com.claudeway.audio.DeviceToast
import com.claudeway.network.ConnectionState
import com.claudeway.voice.ConversationMessage
import com.claudeway.voice.InputMode
import com.claudeway.voice.VoiceFlowState
import kotlinx.coroutines.flow.SharedFlow

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun ConversationScreen(
    connectionState: ConnectionState,
    voiceFlowState: VoiceFlowState,
    statusText: String?,
    audioRouteState: AudioRouteState,
    inputMode: InputMode,
    micLevel: Float,
    messages: List<ConversationMessage>,
    activeTranscript: String?,
    activeResponseText: String?,
    availableRoutes: List<AudioDevice>,
    activeRouteId: Int?,
    selectedRouteId: Int,
    channelName: String?,
    channelRepo: String?,
    ttsEnabled: Boolean,
    onNewChat: () -> Unit,
    onToggleTts: () -> Unit,
    onSendText: (String) -> Unit,
    onStartRecording: () -> Unit,
    onStopRecording: () -> Unit,
    onCancel: () -> Unit,
    onSetInputMode: (InputMode) -> Unit,
    onApplyAudioRoute: (routeId: Int) -> Unit,
    onNavigateToSettings: () -> Unit,
    onRetryConnection: () -> Unit,
    deviceToasts: SharedFlow<DeviceToast>,
) {
    val listState = rememberLazyListState()
    var textInput by rememberSaveable { mutableStateOf("") }
    var showAudioSettings by rememberSaveable { mutableStateOf(false) }
    var showNewChatConfirm by rememberSaveable { mutableStateOf(false) }
    val snackbarHostState = remember { SnackbarHostState() }

    LaunchedEffect(messages.size, activeResponseText, statusText) {
        if (messages.isNotEmpty()) {
            listState.animateScrollToItem(listState.layoutInfo.totalItemsCount - 1)
        }
    }

    LaunchedEffect(Unit) {
        deviceToasts.collect { toast ->
            snackbarHostState.showSnackbar(toast.message)
        }
    }

    if (showNewChatConfirm) {
        AlertDialog(
            onDismissRequest = { showNewChatConfirm = false },
            title = { Text("New conversation?", color = ObsidianTokens.OnSurface) },
            text = { Text("This will clear the current conversation and start fresh.", color = ObsidianTokens.OnSurfaceVariant) },
            confirmButton = {
                TextButton(onClick = {
                    showNewChatConfirm = false
                    onNewChat()
                }) { Text("Start new") }
            },
            dismissButton = {
                TextButton(onClick = { showNewChatConfirm = false }) { Text("Cancel") }
            },
            containerColor = ObsidianTokens.SurfaceContainer,
        )
    }

    Scaffold(
        containerColor = ObsidianTokens.Background,
        snackbarHost = { SnackbarHost(snackbarHostState) },
        topBar = {
            TopAppBar(
                title = {
                    Column {
                        Text(
                            text = channelName ?: "Claudeway",
                            style = MaterialTheme.typography.titleMedium,
                            fontWeight = FontWeight.Bold,
                            color = ObsidianTokens.OnSurface,
                        )
                        if (channelRepo != null) {
                            Text(
                                text = channelRepo,
                                style = MaterialTheme.typography.bodySmall,
                                color = ObsidianTokens.OnSurfaceVariant.copy(alpha = 0.7f),
                            )
                        }
                    }
                },
                actions = {
                    IconButton(onClick = {
                        if (messages.isEmpty()) onNewChat() else showNewChatConfirm = true
                    }) {
                        Icon(
                            Icons.Outlined.AddComment,
                            contentDescription = "New conversation",
                            tint = ObsidianTokens.OnSurfaceVariant,
                        )
                    }
                    IconButton(onClick = onToggleTts) {
                        Icon(
                            if (ttsEnabled) Icons.Default.VolumeUp else Icons.Default.VolumeOff,
                            contentDescription = if (ttsEnabled) "Mute TTS" else "Enable TTS",
                            tint = ObsidianTokens.OnSurfaceVariant,
                        )
                    }
                    IconButton(onClick = onNavigateToSettings) {
                        Icon(
                            Icons.Default.Settings,
                            contentDescription = "Settings",
                            tint = ObsidianTokens.OnSurfaceVariant,
                        )
                    }
                },
                colors = TopAppBarDefaults.topAppBarColors(
                    containerColor = ObsidianTokens.SurfaceContainerLowest,
                ),
            )
        },
    ) { padding ->
        Column(
            modifier = Modifier
                .fillMaxSize()
                .padding(padding)
                .imePadding(),
        ) {
            ConversationMessageList(
                modifier = Modifier.weight(1f),
                listState = listState,
                connectionState = connectionState,
                voiceFlowState = voiceFlowState,
                statusText = statusText,
                messages = messages,
                activeTranscript = activeTranscript,
                activeResponseText = activeResponseText,
                onCancel = onCancel,
                onRetryConnection = onRetryConnection,
                onNavigateToSettings = onNavigateToSettings,
            )

            val isConnected = connectionState == ConnectionState.Connected
            when (inputMode) {
                InputMode.Text -> TextInputBar(
                    textInput = textInput,
                    onTextChange = { textInput = it },
                    onSendText = {
                        onSendText(textInput)
                        textInput = ""
                    },
                    voiceFlowState = voiceFlowState,
                    isConnected = isConnected,
                    onSwitchToVoice = { onSetInputMode(InputMode.Voice) },
                )

                InputMode.Voice -> VoiceInputBar(
                    voiceFlowState = voiceFlowState,
                    micLevel = micLevel,
                    isConnected = isConnected,
                    onStartRecording = onStartRecording,
                    onStopRecording = onStopRecording,
                    onSwitchToText = { onSetInputMode(InputMode.Text) },
                    onOpenAudioSettings = { showAudioSettings = true },
                )
            }
        }
    }

    if (showAudioSettings) {
        AudioSettingsSheet(
            availableRoutes = availableRoutes,
            activeRouteId = activeRouteId,
            selectedRouteId = selectedRouteId,
            onApply = { routeId ->
                onApplyAudioRoute(routeId)
                showAudioSettings = false
            },
            onDismiss = { showAudioSettings = false },
        )
    }
}

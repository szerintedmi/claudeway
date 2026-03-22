package com.claudeway.ui

import androidx.compose.animation.core.RepeatMode
import androidx.compose.animation.core.animateFloat
import androidx.compose.animation.core.infiniteRepeatable
import androidx.compose.animation.core.rememberInfiniteTransition
import androidx.compose.animation.core.tween
import androidx.compose.foundation.background
import androidx.compose.foundation.gestures.awaitEachGesture
import androidx.compose.foundation.gestures.awaitFirstDown
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.Send
import androidx.compose.material.icons.filled.Close
import androidx.compose.material.icons.filled.Mic
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.scale
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.input.pointer.PointerEventPass
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import com.claudeway.glasses.ConversationMessage
import com.claudeway.glasses.MessageRole
import com.claudeway.glasses.VoiceFlowState
import com.claudeway.audio.AudioRouteState
import com.claudeway.network.ConnectionState

@Composable
fun ConversationScreen(
    connectionState: ConnectionState,
    voiceFlowState: VoiceFlowState,
    statusText: String?,
    audioRouteState: AudioRouteState,
    messages: List<ConversationMessage>,
    activeTranscript: String?,
    activeResponseText: String?,
    onSendText: (String) -> Unit,
    onStartRecording: () -> Unit,
    onStopRecording: () -> Unit,
    onCancel: () -> Unit,
) {
    val listState = rememberLazyListState()
    var textInput by rememberSaveable { mutableStateOf("") }

    // Auto-scroll to bottom when messages change
    LaunchedEffect(messages.size, activeResponseText) {
        if (messages.isNotEmpty()) {
            listState.animateScrollToItem(messages.size - 1)
        }
    }

    Scaffold { padding ->
        Column(
            modifier = Modifier
                .fillMaxSize()
                .padding(padding)
                .imePadding(),
        ) {
            // Status bar
            val isConnected = connectionState == ConnectionState.Connected
            val effectiveStatusText = when {
                !isConnected && connectionState == ConnectionState.Reconnecting -> "Reconnecting..."
                !isConnected && connectionState == ConnectionState.Connecting -> "Connecting..."
                !isConnected && statusText == null -> "Disconnected"
                else -> statusText
            }
            if (effectiveStatusText != null) {
                StatusBar(
                    text = effectiveStatusText,
                    flowState = if (!isConnected) VoiceFlowState.Error else voiceFlowState,
                    onCancel = onCancel,
                )
            }

            // Message list
            LazyColumn(
                state = listState,
                modifier = Modifier
                    .weight(1f)
                    .fillMaxWidth()
                    .padding(horizontal = 16.dp),
                verticalArrangement = Arrangement.spacedBy(8.dp),
            ) {
                item { Spacer(modifier = Modifier.height(8.dp)) }

                items(messages, key = { "${it.requestId}-${it.role}-${it.timestamp}" }) { msg ->
                    MessageBubble(message = msg)
                }

                // Active transcript (partial STT)
                if (activeTranscript != null) {
                    item {
                        MessageBubble(
                            message = ConversationMessage(
                                requestId = "",
                                role = MessageRole.User,
                                text = "$activeTranscript...",
                            ),
                            isPartial = true,
                        )
                    }
                }

                // Active response (streaming)
                if (activeResponseText != null) {
                    item {
                        MessageBubble(
                            message = ConversationMessage(
                                requestId = "",
                                role = MessageRole.Assistant,
                                text = activeResponseText,
                            ),
                            isPartial = true,
                        )
                    }
                }

                item { Spacer(modifier = Modifier.height(8.dp)) }
            }

            // Input bar
            InputBar(
                textInput = textInput,
                onTextChange = { textInput = it },
                onSendText = {
                    onSendText(textInput)
                    textInput = ""
                },
                voiceFlowState = voiceFlowState,
                audioRouteState = audioRouteState,
                isConnected = isConnected,
                onStartRecording = onStartRecording,
                onStopRecording = onStopRecording,
                onCancel = onCancel,
            )
        }
    }
}

@Composable
private fun StatusBar(
    text: String,
    flowState: VoiceFlowState,
    onCancel: () -> Unit,
) {
    val bgColor = when (flowState) {
        VoiceFlowState.Recording -> Color(0xFFE53935) // Red
        VoiceFlowState.Transcribing -> Color(0xFFFFA726) // Orange
        VoiceFlowState.Thinking -> Color(0xFF42A5F5) // Blue
        VoiceFlowState.Speaking -> Color(0xFF66BB6A) // Green
        VoiceFlowState.Error -> Color(0xFFE53935)
        VoiceFlowState.Idle -> MaterialTheme.colorScheme.surfaceVariant
    }

    Row(
        modifier = Modifier
            .fillMaxWidth()
            .background(bgColor.copy(alpha = 0.15f))
            .padding(horizontal = 16.dp, vertical = 8.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        // Pulsing dot
        Box(
            modifier = Modifier
                .size(8.dp)
                .clip(CircleShape)
                .background(bgColor)
        )
        Spacer(modifier = Modifier.width(8.dp))
        Text(
            text = text,
            style = MaterialTheme.typography.bodySmall,
            modifier = Modifier.weight(1f),
        )
        if (flowState != VoiceFlowState.Idle) {
            IconButton(onClick = onCancel, modifier = Modifier.size(24.dp)) {
                Icon(
                    Icons.Default.Close,
                    contentDescription = "Cancel",
                    modifier = Modifier.size(16.dp),
                )
            }
        }
    }
}

@Composable
private fun MessageBubble(message: ConversationMessage, isPartial: Boolean = false) {
    val isUser = message.role == MessageRole.User
    val isError = message.role == MessageRole.Error

    val bgColor = when {
        isError -> MaterialTheme.colorScheme.errorContainer
        isUser -> MaterialTheme.colorScheme.primaryContainer
        else -> MaterialTheme.colorScheme.surfaceVariant
    }
    val textColor = when {
        isError -> MaterialTheme.colorScheme.onErrorContainer
        isUser -> MaterialTheme.colorScheme.onPrimaryContainer
        else -> MaterialTheme.colorScheme.onSurfaceVariant
    }
    val alignment = if (isUser) Alignment.End else Alignment.Start

    Column(
        modifier = Modifier.fillMaxWidth(),
        horizontalAlignment = alignment,
    ) {
        Box(
            modifier = Modifier
                .clip(RoundedCornerShape(12.dp))
                .background(bgColor.copy(alpha = if (isPartial) 0.6f else 1f))
                .padding(horizontal = 12.dp, vertical = 8.dp)
                .fillMaxWidth(0.85f),
        ) {
            Text(
                text = message.text,
                color = textColor,
                style = MaterialTheme.typography.bodyMedium,
            )
        }
    }
}

@Composable
private fun InputBar(
    textInput: String,
    onTextChange: (String) -> Unit,
    onSendText: () -> Unit,
    voiceFlowState: VoiceFlowState,
    audioRouteState: AudioRouteState,
    isConnected: Boolean,
    onStartRecording: () -> Unit,
    onStopRecording: () -> Unit,
    onCancel: () -> Unit,
) {
    val isRecording = voiceFlowState == VoiceFlowState.Recording
    // Only block input during recording/transcribing — allow barge-in during thinking/speaking
    val isBusy = !isConnected || voiceFlowState == VoiceFlowState.Recording || voiceFlowState == VoiceFlowState.Transcribing

    // Hold stable references for the pointer input coroutine — using isBusy as a
    // pointerInput key would restart the coroutine mid-gesture, cancelling tryAwaitRelease()
    val currentIsBusy by rememberUpdatedState(isBusy)
    val currentOnStartRecording by rememberUpdatedState(onStartRecording)
    val currentOnStopRecording by rememberUpdatedState(onStopRecording)

    Row(
        modifier = Modifier
            .fillMaxWidth()
            .then(
                if (isRecording) Modifier.background(Color(0xFFE53935).copy(alpha = 0.1f))
                else Modifier
            )
            .padding(horizontal = 16.dp, vertical = 8.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(8.dp),
    ) {
        // Left area: text input OR recording indicator (mic button stays composed)
        if (isRecording) {
            Box(modifier = Modifier.weight(1f)) {
                RecordingIndicator()
            }
        } else {
            Row(
                modifier = Modifier.weight(1f),
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.spacedBy(8.dp),
            ) {
                OutlinedTextField(
                    value = textInput,
                    onValueChange = onTextChange,
                    placeholder = { Text("Type a message...") },
                    singleLine = true,
                    enabled = !isBusy,
                    keyboardOptions = KeyboardOptions(imeAction = ImeAction.Send),
                    keyboardActions = KeyboardActions(onSend = { if (textInput.isNotBlank()) onSendText() }),
                    modifier = Modifier.weight(1f),
                )

                if (textInput.isNotBlank() && !isBusy) {
                    IconButton(onClick = onSendText) {
                        Icon(Icons.AutoMirrored.Filled.Send, contentDescription = "Send")
                    }
                }
            }
        }

        // Mic button — always composed so pointerInput/tryAwaitRelease() survives recording state
        val micColor = if (isRecording) Color(0xFFE53935) else MaterialTheme.colorScheme.primary
        Column(horizontalAlignment = Alignment.CenterHorizontally) {
            Box(
                modifier = Modifier
                    .size(48.dp)
                    .clip(CircleShape)
                    .background(micColor)
                    .pointerInput(Unit) {
                        awaitEachGesture {
                            val down = awaitFirstDown(requireUnconsumed = false)
                            down.consume()
                            if (!currentIsBusy) {
                                currentOnStartRecording()
                                // Wait for finger up anywhere on screen, not just within bounds
                                do {
                                    val event = awaitPointerEvent()
                                } while (event.changes.any { it.pressed })
                                currentOnStopRecording()
                            }
                        }
                    },
                contentAlignment = Alignment.Center,
            ) {
                Icon(
                    Icons.Default.Mic,
                    contentDescription = if (isRecording) "Release to send" else "Hold to talk",
                    tint = Color.White,
                    modifier = Modifier.size(24.dp),
                )
            }
            if (!isRecording) {
                val (micLabel, micLabelColor) = when (audioRouteState) {
                    AudioRouteState.Routed -> "BT" to Color(0xFF4CAF50)
                    AudioRouteState.NoDevice -> "Phone" to Color.Gray
                    else -> "Phone" to Color.Gray
                }
                Text(
                    text = micLabel,
                    style = MaterialTheme.typography.labelSmall,
                    color = micLabelColor,
                )
            }
        }
    }
}

/** Recording indicator that replaces the text field area while holding the mic button. */
@Composable
private fun RecordingIndicator() {
    val recordingColor = Color(0xFFE53935)
    val infiniteTransition = rememberInfiniteTransition(label = "recording")
    val pulseScale by infiniteTransition.animateFloat(
        initialValue = 1f,
        targetValue = 1.3f,
        animationSpec = infiniteRepeatable(
            animation = tween(600),
            repeatMode = RepeatMode.Reverse,
        ),
        label = "dot-pulse",
    )

    Row(
        modifier = Modifier
            .fillMaxWidth()
            .padding(vertical = 8.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.Center,
    ) {
        Box(
            modifier = Modifier
                .size(12.dp)
                .scale(pulseScale)
                .clip(CircleShape)
                .background(recordingColor)
        )
        Spacer(modifier = Modifier.width(12.dp))
        Text(
            text = "Listening... release to send",
            style = MaterialTheme.typography.bodyLarge,
            color = recordingColor,
        )
    }
}

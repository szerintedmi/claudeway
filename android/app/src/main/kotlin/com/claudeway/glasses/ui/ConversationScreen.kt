package com.claudeway.glasses.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.gestures.detectTapGestures
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
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.unit.dp
import com.claudeway.glasses.glasses.ConversationMessage
import com.claudeway.glasses.glasses.MessageRole
import com.claudeway.glasses.glasses.VoiceFlowState
import com.claudeway.glasses.network.ConnectionState

@Composable
fun ConversationScreen(
    connectionState: ConnectionState,
    voiceFlowState: VoiceFlowState,
    statusText: String?,
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
    isConnected: Boolean,
    onStartRecording: () -> Unit,
    onStopRecording: () -> Unit,
    onCancel: () -> Unit,
) {
    val isRecording = voiceFlowState == VoiceFlowState.Recording
    val isBusy = !isConnected || (voiceFlowState != VoiceFlowState.Idle && voiceFlowState != VoiceFlowState.Error)

    // Hold stable references for the pointer input coroutine — using isBusy as a
    // pointerInput key would restart the coroutine mid-gesture, cancelling tryAwaitRelease()
    val currentIsBusy by rememberUpdatedState(isBusy)
    val currentOnStartRecording by rememberUpdatedState(onStartRecording)
    val currentOnStopRecording by rememberUpdatedState(onStopRecording)

    Row(
        modifier = Modifier
            .fillMaxWidth()
            .padding(horizontal = 16.dp, vertical = 8.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(8.dp),
    ) {
        // Text input
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

        // Send text button
        if (textInput.isNotBlank() && !isBusy) {
            IconButton(onClick = onSendText) {
                Icon(Icons.AutoMirrored.Filled.Send, contentDescription = "Send")
            }
        }

        // Mic button (hold-to-talk)
        Box(
            modifier = Modifier
                .size(48.dp)
                .clip(CircleShape)
                .background(
                    if (isRecording) Color(0xFFE53935)
                    else MaterialTheme.colorScheme.primary
                )
                .pointerInput(Unit) {
                    detectTapGestures(
                        onPress = {
                            if (!currentIsBusy) {
                                currentOnStartRecording()
                                tryAwaitRelease()
                                currentOnStopRecording()
                            }
                        }
                    )
                },
            contentAlignment = Alignment.Center,
        ) {
            Icon(
                Icons.Default.Mic,
                contentDescription = if (isRecording) "Release to stop" else "Hold to talk",
                tint = Color.White,
                modifier = Modifier.size(24.dp),
            )
        }
    }
}

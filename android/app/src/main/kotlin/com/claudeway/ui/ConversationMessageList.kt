package com.claudeway.ui

import androidx.compose.animation.core.RepeatMode
import androidx.compose.animation.core.animateFloat
import androidx.compose.animation.core.infiniteRepeatable
import androidx.compose.animation.core.rememberInfiniteTransition
import androidx.compose.animation.core.tween
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.LazyListState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Close
import androidx.compose.material.icons.filled.Refresh
import androidx.compose.material.icons.filled.Settings
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import com.claudeway.network.ConnectionState
import com.claudeway.voice.ConversationMessage
import com.claudeway.voice.MessageRole
import com.claudeway.voice.VoiceFlowState

@Composable
internal fun ConversationMessageList(
    modifier: Modifier = Modifier,
    listState: LazyListState,
    connectionState: ConnectionState,
    voiceFlowState: VoiceFlowState,
    statusText: String?,
    messages: List<ConversationMessage>,
    activeTranscript: String?,
    activeResponseText: String?,
    onCancel: () -> Unit,
    onRetryConnection: () -> Unit,
    onNavigateToSettings: () -> Unit,
) {
    val isConnected = connectionState == ConnectionState.Connected
    val connectionStatusText = when {
        connectionState == ConnectionState.Reconnecting -> "Reconnecting..."
        connectionState == ConnectionState.Connecting -> "Connecting..."
        !isConnected -> "Disconnected"
        else -> null
    }
    val activityStatusText = if (isConnected) statusText else null
    val isActive = voiceFlowState != VoiceFlowState.Idle && voiceFlowState != VoiceFlowState.Error

    Column(
        modifier = modifier.fillMaxWidth(),
    ) {
        if (connectionStatusText != null) {
            if (connectionState == ConnectionState.Error || connectionState == ConnectionState.Disconnected) {
                ConnectionRetryBanner(
                    text = connectionStatusText,
                    onRetry = onRetryConnection,
                    onSettings = onNavigateToSettings,
                )
            } else {
                StatusBar(
                    text = connectionStatusText,
                    flowState = VoiceFlowState.Error,
                    onCancel = {},
                    showCancel = false,
                )
            }
        }

        LazyColumn(
            state = listState,
            modifier = Modifier
                .fillMaxWidth()
                .padding(horizontal = 16.dp)
                .weight(1f),
            verticalArrangement = Arrangement.spacedBy(8.dp),
        ) {
            item { Spacer(modifier = Modifier.height(8.dp)) }

            items(messages, key = { "${it.requestId}-${it.role}-${it.timestamp}" }) { msg ->
                MessageBubble(message = msg)
            }

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

            if (activityStatusText != null && isActive) {
                item {
                    InlineStatusIndicator(
                        text = activityStatusText,
                        flowState = voiceFlowState,
                        onCancel = onCancel,
                    )
                }
            }

            item { Spacer(modifier = Modifier.height(8.dp)) }
        }
    }
}

@Composable
private fun StatusBar(
    text: String,
    flowState: VoiceFlowState,
    onCancel: () -> Unit,
    showCancel: Boolean = true,
) {
    val bgColor = when (flowState) {
        VoiceFlowState.Preparing -> Color(0xFFFFA726)
        VoiceFlowState.Recording -> Color(0xFFE53935)
        VoiceFlowState.Transcribing -> Color(0xFFFFA726)
        VoiceFlowState.Thinking -> Color(0xFF42A5F5)
        VoiceFlowState.Speaking -> Color(0xFF66BB6A)
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
        Box(
            modifier = Modifier
                .size(8.dp)
                .background(bgColor, CircleShape)
        )
        Spacer(modifier = Modifier.width(8.dp))
        Text(
            text = text,
            style = MaterialTheme.typography.bodySmall,
            modifier = Modifier.weight(1f),
        )
        if (showCancel && flowState != VoiceFlowState.Idle) {
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
private fun ConnectionRetryBanner(
    text: String,
    onRetry: () -> Unit,
    onSettings: () -> Unit,
) {
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .background(Color(0xFFE53935).copy(alpha = 0.15f))
            .padding(horizontal = 16.dp, vertical = 8.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Box(
            modifier = Modifier
                .size(8.dp)
                .background(Color(0xFFE53935), CircleShape)
        )
        Spacer(modifier = Modifier.width(8.dp))
        Text(
            text = text,
            style = MaterialTheme.typography.bodySmall,
            modifier = Modifier.weight(1f),
        )
        TextButton(onClick = onRetry) {
            Icon(
                Icons.Default.Refresh,
                contentDescription = null,
                modifier = Modifier.size(16.dp),
            )
            Spacer(modifier = Modifier.width(4.dp))
            Text("Retry", style = MaterialTheme.typography.labelMedium)
        }
        TextButton(onClick = onSettings) {
            Icon(
                Icons.Default.Settings,
                contentDescription = null,
                modifier = Modifier.size(16.dp),
            )
            Spacer(modifier = Modifier.width(4.dp))
            Text("Settings", style = MaterialTheme.typography.labelMedium)
        }
    }
}

@Composable
private fun InlineStatusIndicator(
    text: String,
    flowState: VoiceFlowState,
    onCancel: () -> Unit,
) {
    val color = when (flowState) {
        VoiceFlowState.Preparing -> Color(0xFFFFA726)
        VoiceFlowState.Recording -> Color(0xFFE53935)
        VoiceFlowState.Transcribing -> Color(0xFFFFA726)
        VoiceFlowState.Thinking -> Color(0xFF42A5F5)
        VoiceFlowState.Speaking -> Color(0xFF66BB6A)
        else -> MaterialTheme.colorScheme.onSurfaceVariant
    }

    val infiniteTransition = rememberInfiniteTransition(label = "status-pulse")
    val pulseAlpha by infiniteTransition.animateFloat(
        initialValue = 0.4f,
        targetValue = 1f,
        animationSpec = infiniteRepeatable(
            animation = tween(800),
            repeatMode = RepeatMode.Reverse,
        ),
        label = "status-dot-pulse",
    )

    Row(
        modifier = Modifier
            .fillMaxWidth()
            .padding(vertical = 4.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Box(
            modifier = Modifier
                .size(8.dp)
                .background(color.copy(alpha = pulseAlpha), CircleShape)
        )
        Spacer(modifier = Modifier.width(8.dp))
        Text(
            text = text,
            style = MaterialTheme.typography.bodySmall,
            color = color,
            modifier = Modifier.weight(1f),
        )
        IconButton(onClick = onCancel, modifier = Modifier.size(24.dp)) {
            Icon(
                Icons.Default.Close,
                contentDescription = "Cancel",
                tint = color.copy(alpha = 0.6f),
                modifier = Modifier.size(14.dp),
            )
        }
    }
}

@Composable
private fun MessageBubble(message: ConversationMessage, isPartial: Boolean = false) {
    val isUser = message.role == MessageRole.User
    val isError = message.role == MessageRole.Error
    val isStatus = message.role == MessageRole.Status

    if (isStatus) {
        StatusMessageRow(text = message.text)
        return
    }

    val bgColor = when {
        isError -> MaterialTheme.colorScheme.errorContainer
        isUser -> ObsidianTokens.PrimaryContainer
        else -> ObsidianTokens.SurfaceContainerHighest
    }
    val textColor = when {
        isError -> MaterialTheme.colorScheme.onErrorContainer
        isUser -> ObsidianTokens.OnPrimary
        else -> ObsidianTokens.OnSurface
    }
    val alignment = if (isUser) Alignment.End else Alignment.Start

    Column(
        modifier = Modifier.fillMaxWidth(),
        horizontalAlignment = alignment,
    ) {
        Box(
            modifier = Modifier
                .fillMaxWidth(0.85f)
                .background(
                    color = bgColor.copy(alpha = if (isPartial) 0.6f else 1f),
                    shape = RoundedCornerShape(12.dp),
                )
                .then(
                    if (!isUser && !isError) Modifier.border(
                        width = 1.dp,
                        color = ObsidianTokens.Primary.copy(alpha = 0.2f),
                        shape = RoundedCornerShape(12.dp),
                    ) else Modifier
                )
                .padding(horizontal = 12.dp, vertical = 8.dp),
        ) {
            Text(
                text = message.text,
                color = textColor,
                style = MaterialTheme.typography.bodyMedium,
                overflow = TextOverflow.Clip,
            )
        }
    }
}

@Composable
private fun StatusMessageRow(text: String) {
    val isAction = !text.startsWith("No speech")
    val dotColor = if (isAction) Color(0xFF66BB6A) else MaterialTheme.colorScheme.onSurfaceVariant.copy(alpha = 0.4f)
    val textAlpha = if (isAction) 0.7f else 0.5f

    Row(
        modifier = Modifier
            .fillMaxWidth()
            .padding(vertical = 2.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Text(
            text = if (isAction) "\u25CF" else "\u25CB",
            style = MaterialTheme.typography.bodySmall,
            color = dotColor,
        )
        Spacer(modifier = Modifier.width(6.dp))
        Text(
            text = text,
            style = MaterialTheme.typography.bodySmall,
            color = MaterialTheme.colorScheme.onSurfaceVariant.copy(alpha = textAlpha),
        )
    }
}

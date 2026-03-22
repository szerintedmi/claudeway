package com.claudeway.ui

import androidx.compose.animation.core.RepeatMode
import androidx.compose.animation.core.animateFloat
import androidx.compose.animation.core.animateFloatAsState
import androidx.compose.animation.core.infiniteRepeatable
import androidx.compose.animation.core.rememberInfiniteTransition
import androidx.compose.animation.core.tween
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
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
import androidx.compose.material.icons.filled.Headphones
import androidx.compose.material.icons.filled.Hearing
import androidx.compose.material.icons.filled.Keyboard
import androidx.compose.material.icons.filled.Mic
import androidx.compose.material.icons.filled.Refresh
import androidx.compose.material.icons.filled.Settings
import androidx.compose.material.icons.filled.VolumeOff
import androidx.compose.material.icons.filled.VolumeUp
import androidx.compose.material.icons.outlined.AddComment
import androidx.compose.material.icons.filled.Smartphone
import androidx.compose.material.icons.filled.Tune
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Scaffold
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.SnackbarHost
import androidx.compose.material3.SnackbarHostState
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TopAppBar
import androidx.compose.material3.TopAppBarDefaults
import androidx.compose.material3.rememberModalBottomSheetState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.blur
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.drawBehind
import androidx.compose.ui.draw.scale
import androidx.compose.ui.geometry.CornerRadius
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.claudeway.audio.AUTO_ROUTE_ID
import com.claudeway.audio.AudioDevice
import com.claudeway.audio.AudioRouteState
import com.claudeway.audio.DeviceToast
import com.claudeway.audio.EARPIECE_ROUTE_ID
import com.claudeway.audio.PHONE_SPEAKER_ROUTE_ID
import com.claudeway.network.ConnectionState
import com.claudeway.voice.ConversationMessage
import com.claudeway.voice.InputMode
import com.claudeway.voice.MessageRole
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
            val isConnected = connectionState == ConnectionState.Connected

            val connectionStatusText = when {
                connectionState == ConnectionState.Reconnecting -> "Reconnecting..."
                connectionState == ConnectionState.Connecting -> "Connecting..."
                !isConnected -> "Disconnected"
                else -> null
            }
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

            val activityStatusText = if (isConnected) statusText else null
            val isActive = voiceFlowState != VoiceFlowState.Idle && voiceFlowState != VoiceFlowState.Error

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
                .clip(CircleShape)
                .background(bgColor)
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
                .clip(CircleShape)
                .background(Color(0xFFE53935))
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
                .clip(CircleShape)
                .background(color.copy(alpha = pulseAlpha))
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
                .clip(RoundedCornerShape(12.dp))
                .background(bgColor.copy(alpha = if (isPartial) 0.6f else 1f))
                .then(
                    if (!isUser && !isError) Modifier.border(
                        width = 1.dp,
                        color = ObsidianTokens.Primary.copy(alpha = 0.2f),
                        shape = RoundedCornerShape(12.dp),
                    ) else Modifier
                )
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

@Composable
private fun TextInputBar(
    textInput: String,
    onTextChange: (String) -> Unit,
    onSendText: () -> Unit,
    voiceFlowState: VoiceFlowState,
    isConnected: Boolean,
    onSwitchToVoice: () -> Unit,
) {
    val isBusy = !isConnected ||
        voiceFlowState == VoiceFlowState.Preparing ||
        voiceFlowState == VoiceFlowState.Recording ||
        voiceFlowState == VoiceFlowState.Transcribing

    Row(
        modifier = Modifier
            .fillMaxWidth()
            .background(ObsidianTokens.SurfaceContainerLowest.copy(alpha = 0.9f))
            .padding(horizontal = 16.dp, vertical = 8.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(8.dp),
    ) {
        IconButton(
            onClick = onSwitchToVoice,
            modifier = Modifier.size(40.dp),
        ) {
            Icon(
                Icons.Default.Mic,
                contentDescription = "Switch to voice",
                tint = ObsidianTokens.OnSurfaceVariant,
                modifier = Modifier.size(20.dp),
            )
        }

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
                Icon(
                    Icons.AutoMirrored.Filled.Send,
                    contentDescription = "Send",
                    tint = ObsidianTokens.Primary,
                )
            }
        }
    }
}

@Composable
private fun VoiceInputBar(
    voiceFlowState: VoiceFlowState,
    micLevel: Float,
    isConnected: Boolean,
    onStartRecording: () -> Unit,
    onStopRecording: () -> Unit,
    onSwitchToText: () -> Unit,
    onOpenAudioSettings: () -> Unit,
) {
    val isRecording = voiceFlowState == VoiceFlowState.Preparing || voiceFlowState == VoiceFlowState.Recording
    val isBusy = !isConnected || voiceFlowState == VoiceFlowState.Transcribing

    val currentOnStartRecording by rememberUpdatedState(onStartRecording)
    val currentOnStopRecording by rememberUpdatedState(onStopRecording)
    val currentIsBusy by rememberUpdatedState(isBusy)

    Column(
        modifier = Modifier
            .fillMaxWidth()
            .background(ObsidianTokens.SurfaceContainerLowest.copy(alpha = 0.9f))
            .padding(top = 12.dp, bottom = 16.dp),
        horizontalAlignment = Alignment.CenterHorizontally,
    ) {
        if (isRecording) {
            AudioVisualizer(
                micLevel = micLevel,
                modifier = Modifier.padding(bottom = 12.dp),
            )
        }

        Row(
            modifier = Modifier
                .fillMaxWidth()
                .padding(horizontal = 24.dp),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.SpaceEvenly,
        ) {
            IconButton(
                onClick = onOpenAudioSettings,
                modifier = Modifier.size(48.dp),
            ) {
                Icon(
                    Icons.Default.Tune,
                    contentDescription = "Audio settings",
                    tint = ObsidianTokens.OnSurfaceVariant.copy(alpha = 0.7f),
                    modifier = Modifier.size(24.dp),
                )
            }

            MicButton(
                isRecording = isRecording,
                isBusy = currentIsBusy,
                onStartRecording = currentOnStartRecording,
                onStopRecording = currentOnStopRecording,
            )

            IconButton(
                onClick = onSwitchToText,
                modifier = Modifier.size(48.dp),
            ) {
                Icon(
                    Icons.Default.Keyboard,
                    contentDescription = "Switch to text",
                    tint = ObsidianTokens.OnSurfaceVariant.copy(alpha = 0.7f),
                    modifier = Modifier.size(24.dp),
                )
            }
        }
    }
}

@Composable
private fun MicButton(
    isRecording: Boolean,
    isBusy: Boolean,
    onStartRecording: () -> Unit,
    onStopRecording: () -> Unit,
) {
    val currentIsBusy by rememberUpdatedState(isBusy)
    val currentOnStartRecording by rememberUpdatedState(onStartRecording)
    val currentOnStopRecording by rememberUpdatedState(onStopRecording)

    val infiniteTransition = rememberInfiniteTransition(label = "mic-pulse")
    val pulseScale by infiniteTransition.animateFloat(
        initialValue = 1f,
        targetValue = 1.3f,
        animationSpec = infiniteRepeatable(
            animation = tween(1000),
            repeatMode = RepeatMode.Reverse,
        ),
        label = "ring-pulse",
    )

    Box(contentAlignment = Alignment.Center) {
        if (isRecording) {
            Box(
                modifier = Modifier
                    .size(120.dp)
                    .scale(pulseScale)
                    .blur(24.dp)
                    .clip(CircleShape)
                    .background(ObsidianTokens.Primary.copy(alpha = 0.2f))
            )
            Box(
                modifier = Modifier
                    .size(96.dp)
                    .scale(pulseScale)
                    .clip(CircleShape)
                    .background(ObsidianTokens.Primary.copy(alpha = 0.1f))
            )
        }

        Box(
            modifier = Modifier
                .size(if (isRecording) 80.dp else 72.dp)
                .clip(CircleShape)
                .background(
                    brush = Brush.linearGradient(
                        colors = listOf(
                            ObsidianTokens.PrimaryContainer,
                            ObsidianTokens.Primary,
                        ),
                    )
                )
                .then(
                    if (isRecording) Modifier.border(
                        width = 4.dp,
                        color = ObsidianTokens.Primary.copy(alpha = 0.1f),
                        shape = CircleShape,
                    ) else Modifier
                )
                .pointerInput(Unit) {
                    awaitEachGesture {
                        val down = awaitFirstDown(requireUnconsumed = false)
                        down.consume()
                        if (!currentIsBusy) {
                            currentOnStartRecording()
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
                tint = ObsidianTokens.OnPrimary,
                modifier = Modifier.size(32.dp),
            )
        }
    }
}

@Composable
private fun AudioVisualizer(
    micLevel: Float,
    modifier: Modifier = Modifier,
) {
    val barWeights = remember { floatArrayOf(0.5f, 0.7f, 0.9f, 0.6f, 1.0f, 0.8f, 0.6f, 0.4f) }
    val barCount = 8
    val barWidth = 5.dp
    val barSpacing = 7.dp
    val maxBarHeight = 56.dp
    val minBarHeight = 6.dp

    val smoothedLevel by animateFloatAsState(
        targetValue = micLevel,
        animationSpec = tween(100),
        label = "mic-smooth",
    )

    val infiniteTransition = rememberInfiniteTransition(label = "idle-pulse")
    val idlePulse by infiniteTransition.animateFloat(
        initialValue = 0.3f,
        targetValue = 0.6f,
        animationSpec = infiniteRepeatable(
            animation = tween(1200),
            repeatMode = RepeatMode.Reverse,
        ),
        label = "idle-pulse-anim",
    )

    val totalWidth = (barWidth + barSpacing) * barCount - barSpacing

    Box(
        modifier = modifier
            .height(maxBarHeight)
            .width(totalWidth)
            .drawBehind {
                val bw = barWidth.toPx()
                val bs = barSpacing.toPx()
                val maxH = maxBarHeight.toPx()
                val minH = minBarHeight.toPx()

                for (i in 0 until barCount) {
                    val weight = barWeights[i]
                    val effectiveLevel = if (smoothedLevel < 0.02f) {
                        idlePulse * weight * 0.15f
                    } else {
                        smoothedLevel * weight
                    }
                    val h = (minH + effectiveLevel * (maxH - minH)).coerceIn(minH, maxH)
                    val x = i * (bw + bs)
                    val y = (maxH - h) / 2f
                    val alpha = (0.3f + effectiveLevel * 0.7f).coerceIn(0.3f, 1f)
                    drawRoundRect(
                        color = ObsidianTokens.Primary.copy(alpha = alpha),
                        topLeft = Offset(x, y),
                        size = Size(bw, h),
                        cornerRadius = CornerRadius(bw / 2f),
                    )
                }
            },
    )
}

private const val NO_PENDING = Int.MIN_VALUE

@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun AudioSettingsSheet(
    availableRoutes: List<AudioDevice>,
    activeRouteId: Int?,
    selectedRouteId: Int,
    onApply: (routeId: Int) -> Unit,
    onDismiss: () -> Unit,
) {
    val sheetState = rememberModalBottomSheetState(skipPartiallyExpanded = true)
    var pendingRouteId by remember { mutableIntStateOf(NO_PENDING) }
    val effectiveRouteId = if (pendingRouteId == NO_PENDING) selectedRouteId else pendingRouteId

    ModalBottomSheet(
        onDismissRequest = onDismiss,
        sheetState = sheetState,
        containerColor = ObsidianTokens.SurfaceContainerLow,
        shape = RoundedCornerShape(topStart = 32.dp, topEnd = 32.dp),
        tonalElevation = 0.dp,
    ) {
        Column(
            modifier = Modifier
                .fillMaxWidth()
                .padding(horizontal = 24.dp)
                .padding(bottom = 32.dp),
        ) {
            Row(
                modifier = Modifier.fillMaxWidth(),
                horizontalArrangement = Arrangement.SpaceBetween,
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Text(
                    text = "Audio Settings",
                    style = MaterialTheme.typography.titleLarge,
                    fontWeight = FontWeight.Bold,
                    color = ObsidianTokens.Primary,
                )
                Box(
                    modifier = Modifier
                        .size(40.dp)
                        .clip(CircleShape)
                        .background(ObsidianTokens.SurfaceContainerHigh)
                        .clickable { onDismiss() },
                    contentAlignment = Alignment.Center,
                ) {
                    Icon(
                        Icons.Default.Close,
                        contentDescription = "Close",
                        tint = ObsidianTokens.OnSurfaceVariant,
                        modifier = Modifier.size(20.dp),
                    )
                }
            }

            Spacer(modifier = Modifier.height(16.dp))
            Spacer(modifier = Modifier.height(8.dp))

            RouteSection(
                routes = availableRoutes,
                activeRouteId = activeRouteId,
                selectedRouteId = effectiveRouteId,
                onSelect = { pendingRouteId = it },
            )

            Spacer(modifier = Modifier.height(24.dp))

            Box(
                modifier = Modifier
                    .fillMaxWidth()
                    .height(56.dp)
                    .clip(RoundedCornerShape(16.dp))
                    .background(
                        brush = Brush.horizontalGradient(
                            colors = listOf(
                                ObsidianTokens.PrimaryContainer,
                                ObsidianTokens.Primary,
                            ),
                        )
                    )
                    .clickable { onApply(effectiveRouteId) },
                contentAlignment = Alignment.Center,
            ) {
                Text(
                    text = "Apply Route",
                    fontWeight = FontWeight.Bold,
                    color = ObsidianTokens.OnPrimary,
                    fontSize = 16.sp,
                )
            }
        }
    }
}

@Composable
private fun RouteSection(
    routes: List<AudioDevice>,
    activeRouteId: Int?,
    selectedRouteId: Int,
    onSelect: (Int) -> Unit,
) {
    Row(
        verticalAlignment = Alignment.CenterVertically,
        modifier = Modifier.padding(bottom = 12.dp),
    ) {
        Icon(
            imageVector = Icons.Default.Tune,
            contentDescription = "Audio route",
            tint = ObsidianTokens.Tertiary,
            modifier = Modifier.size(16.dp),
        )
        Spacer(modifier = Modifier.width(8.dp))
        Text(
            text = "AUDIO ROUTE",
            style = MaterialTheme.typography.labelSmall,
            fontWeight = FontWeight.Bold,
            color = ObsidianTokens.OnSurfaceVariant,
            letterSpacing = 3.sp,
        )
    }

    Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
        routes.forEach { route ->
            RouteRow(
                route = route,
                isSelected = route.id == selectedRouteId,
                isActive = route.id == activeRouteId,
                onClick = { onSelect(route.id) },
            )
        }
    }
}

@Composable
private fun RouteRow(
    route: AudioDevice,
    isSelected: Boolean,
    isActive: Boolean,
    onClick: () -> Unit,
) {
    val bgColor = if (isSelected) ObsidianTokens.SurfaceContainerHighest else ObsidianTokens.SurfaceContainer
    val borderMod = if (isSelected) Modifier.border(
        width = 1.dp,
        color = ObsidianTokens.Primary.copy(alpha = 0.2f),
        shape = RoundedCornerShape(16.dp),
    ) else Modifier

    Row(
        modifier = Modifier
            .fillMaxWidth()
            .clip(RoundedCornerShape(16.dp))
            .then(borderMod)
            .background(bgColor)
            .clickable(onClick = onClick)
            .padding(16.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        val iconBg = if (isSelected) ObsidianTokens.Primary.copy(alpha = 0.1f) else ObsidianTokens.SurfaceContainerHighest
        val iconColor = if (isSelected) ObsidianTokens.Primary else ObsidianTokens.OnSurfaceVariant

        Box(
            modifier = Modifier
                .size(40.dp)
                .clip(CircleShape)
                .background(iconBg),
            contentAlignment = Alignment.Center,
        ) {
            Icon(
                imageVector = routeIcon(route.id),
                contentDescription = route.name,
                tint = iconColor,
                modifier = Modifier.size(20.dp),
            )
        }

        Spacer(modifier = Modifier.width(16.dp))

        Column(modifier = Modifier.weight(1f)) {
            Text(
                text = route.name,
                style = MaterialTheme.typography.bodyMedium,
                fontWeight = FontWeight.SemiBold,
                color = if (isSelected) ObsidianTokens.OnSurface else ObsidianTokens.OnSurfaceVariant,
            )
            Text(
                text = routeDescription(route),
                style = MaterialTheme.typography.labelSmall,
                color = if (isSelected) ObsidianTokens.Primary.copy(alpha = 0.75f)
                    else ObsidianTokens.OnSurfaceVariant.copy(alpha = 0.6f),
            )
        }

        if (isActive) {
            Text(
                text = "Current",
                style = MaterialTheme.typography.labelSmall,
                color = ObsidianTokens.Tertiary,
                modifier = Modifier.padding(end = 10.dp),
            )
        }

        Box(
            modifier = Modifier
                .size(20.dp)
                .border(
                    width = 2.dp,
                    color = if (isSelected) ObsidianTokens.Primary else ObsidianTokens.OutlineVariant,
                    shape = CircleShape,
                ),
            contentAlignment = Alignment.Center,
        ) {
            if (isSelected) {
                Box(
                    modifier = Modifier
                        .size(10.dp)
                        .clip(CircleShape)
                        .background(ObsidianTokens.Primary),
                )
            }
        }
    }
}

private fun routeIcon(routeId: Int) = when (routeId) {
    AUTO_ROUTE_ID -> Icons.Default.Tune
    PHONE_SPEAKER_ROUTE_ID -> Icons.Default.Smartphone
    EARPIECE_ROUTE_ID -> Icons.Default.Hearing
    else -> Icons.Default.Headphones
}

private fun routeDescription(route: AudioDevice): String = when (route.id) {
    AUTO_ROUTE_ID -> "Use headset when available, otherwise phone speaker"
    PHONE_SPEAKER_ROUTE_ID -> "Built-in speaker with built-in microphone"
    EARPIECE_ROUTE_ID -> "Private earpiece audio with built-in microphone"
    else -> route.subtitle ?: "Use the connected headset for voice"
}

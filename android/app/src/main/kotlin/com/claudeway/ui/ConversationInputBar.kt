package com.claudeway.ui

import androidx.compose.animation.core.RepeatMode
import androidx.compose.animation.core.animateFloat
import androidx.compose.animation.core.animateFloatAsState
import androidx.compose.animation.core.infiniteRepeatable
import androidx.compose.animation.core.rememberInfiniteTransition
import androidx.compose.animation.core.tween
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.gestures.awaitEachGesture
import androidx.compose.foundation.gestures.awaitFirstDown
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.Send
import androidx.compose.material.icons.filled.Keyboard
import androidx.compose.material.icons.filled.Mic
import androidx.compose.material.icons.filled.Tune
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.blur
import androidx.compose.ui.draw.drawBehind
import androidx.compose.ui.draw.scale
import androidx.compose.ui.geometry.CornerRadius
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.unit.dp
import com.claudeway.voice.VoiceFlowState

@Composable
internal fun TextInputBar(
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
internal fun VoiceInputBar(
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
                    .background(ObsidianTokens.Primary.copy(alpha = 0.2f), CircleShape)
            )
            Box(
                modifier = Modifier
                    .size(96.dp)
                    .scale(pulseScale)
                    .background(ObsidianTokens.Primary.copy(alpha = 0.1f), CircleShape)
            )
        }

        Box(
            modifier = Modifier
                .size(if (isRecording) 80.dp else 72.dp)
                .background(
                    brush = Brush.linearGradient(
                        colors = listOf(
                            ObsidianTokens.PrimaryContainer,
                            ObsidianTokens.Primary,
                        ),
                    ),
                    shape = CircleShape,
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

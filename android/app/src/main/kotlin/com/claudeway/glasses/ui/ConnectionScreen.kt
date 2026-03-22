package com.claudeway.glasses.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material3.Button
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.unit.dp
import com.claudeway.glasses.BuildConfig
import com.claudeway.glasses.glasses.GlassesState
import com.claudeway.glasses.network.ConnectionError
import com.claudeway.glasses.network.ConnectionState

@Composable
fun ConnectionScreen(
    connectionState: ConnectionState,
    connectionError: ConnectionError?,
    glassesState: GlassesState,
    savedUrl: String,
    savedToken: String,
    onConnect: (url: String, token: String) -> Unit,
    onDisconnect: () -> Unit,
    onRouteAudio: () -> Unit,
    onNavigateToConversation: () -> Unit,
) {
    var url by rememberSaveable { mutableStateOf(savedUrl) }
    var token by rememberSaveable { mutableStateOf(savedToken) }

    Scaffold { padding ->
        Column(
            modifier = Modifier
                .fillMaxSize()
                .padding(padding)
                .padding(24.dp),
            verticalArrangement = Arrangement.Center,
            horizontalAlignment = Alignment.CenterHorizontally,
        ) {
            Text(
                text = "Claudeway Glasses",
                style = MaterialTheme.typography.headlineMedium,
            )
            Text(
                text = "${BuildConfig.GIT_HASH} · ${BuildConfig.BUILD_TIME}",
                style = MaterialTheme.typography.bodySmall,
                color = Color.Gray,
            )

            Spacer(modifier = Modifier.height(32.dp))

            OutlinedTextField(
                value = url,
                onValueChange = { url = it },
                label = { Text("Server URL") },
                placeholder = { Text("ws://192.168.1.x:8765/ws") },
                singleLine = true,
                keyboardOptions = KeyboardOptions(
                    keyboardType = KeyboardType.Uri,
                    autoCorrectEnabled = false,
                ),
                modifier = Modifier.fillMaxWidth(),
            )

            Spacer(modifier = Modifier.height(12.dp))

            OutlinedTextField(
                value = token,
                onValueChange = { token = it },
                label = { Text("Auth Token") },
                singleLine = true,
                visualTransformation = PasswordVisualTransformation(),
                keyboardOptions = KeyboardOptions(
                    keyboardType = KeyboardType.Password,
                    autoCorrectEnabled = false,
                ),
                modifier = Modifier.fillMaxWidth(),
            )

            Spacer(modifier = Modifier.height(24.dp))

            // Connection status
            StatusRow(
                label = "Server",
                state = connectionState.displayText,
                color = connectionState.indicatorColor,
            )
            Spacer(modifier = Modifier.height(8.dp))
            StatusRow(
                label = "Glasses",
                state = glassesState.displayText,
                color = glassesState.indicatorColor,
            )

            Spacer(modifier = Modifier.height(24.dp))

            // Connection error message
            if (connectionError != null) {
                Spacer(modifier = Modifier.height(8.dp))
                Text(
                    text = connectionError.message,
                    color = MaterialTheme.colorScheme.error,
                    style = MaterialTheme.typography.bodyMedium,
                    modifier = Modifier.fillMaxWidth(),
                )
                Spacer(modifier = Modifier.height(8.dp))
            }

            when (connectionState) {
                ConnectionState.Disconnected, ConnectionState.Error -> {
                    Button(
                        onClick = { onConnect(url.trim(), token.trim()) },
                        enabled = url.isNotBlank() && token.isNotBlank(),
                        modifier = Modifier.fillMaxWidth(),
                    ) {
                        Text(if (connectionState == ConnectionState.Error) "Retry" else "Connect")
                    }
                }
                ConnectionState.Connecting, ConnectionState.Reconnecting -> {
                    OutlinedButton(
                        onClick = onDisconnect,
                        modifier = Modifier.fillMaxWidth(),
                    ) {
                        Text("Cancel")
                    }
                }
                ConnectionState.Connected -> {
                    Button(
                        onClick = onNavigateToConversation,
                        modifier = Modifier.fillMaxWidth(),
                    ) {
                        Text("Open Conversation")
                    }
                    Spacer(modifier = Modifier.height(8.dp))
                    OutlinedButton(
                        onClick = onRouteAudio,
                        modifier = Modifier.fillMaxWidth(),
                    ) {
                        Text("Route Audio to Glasses")
                    }
                    Spacer(modifier = Modifier.height(8.dp))
                    OutlinedButton(
                        onClick = onDisconnect,
                        modifier = Modifier.fillMaxWidth(),
                    ) {
                        Text("Disconnect")
                    }
                }
            }
        }
    }
}

@Composable
private fun StatusRow(label: String, state: String, color: Color) {
    Row(
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(8.dp),
        modifier = Modifier.fillMaxWidth(),
    ) {
        Box(
            modifier = Modifier
                .size(10.dp)
                .clip(CircleShape)
                .background(color)
        )
        Text(
            text = "$label: $state",
            style = MaterialTheme.typography.bodyMedium,
        )
    }
}

// --- Extension properties for display ---

private val ConnectionState.displayText: String
    get() = when (this) {
        ConnectionState.Disconnected -> "Disconnected"
        ConnectionState.Connecting -> "Connecting..."
        ConnectionState.Connected -> "Connected"
        ConnectionState.Reconnecting -> "Reconnecting..."
        ConnectionState.Error -> "Error"
    }

private val ConnectionState.indicatorColor: Color
    get() = when (this) {
        ConnectionState.Disconnected -> Color.Gray
        ConnectionState.Connecting -> Color.Yellow
        ConnectionState.Connected -> Color(0xFF4CAF50)
        ConnectionState.Reconnecting -> Color.Yellow
        ConnectionState.Error -> Color.Red
    }

private val GlassesState.displayText: String
    get() = when (this) {
        GlassesState.NotInitialized -> "Not initialized"
        GlassesState.Searching -> "Searching..."
        GlassesState.Found -> "Found"
        GlassesState.Connected -> "Connected"
        GlassesState.Disconnected -> "Disconnected"
        GlassesState.Error -> "Error"
        GlassesState.Unavailable -> "Standalone mode"
    }

private val GlassesState.indicatorColor: Color
    get() = when (this) {
        GlassesState.NotInitialized -> Color.Gray
        GlassesState.Searching -> Color.Yellow
        GlassesState.Found -> Color.Yellow
        GlassesState.Connected -> Color(0xFF4CAF50)
        GlassesState.Disconnected -> Color.Gray
        GlassesState.Error -> Color.Red
        GlassesState.Unavailable -> Color(0xFF2196F3) // Blue — working but without glasses
    }

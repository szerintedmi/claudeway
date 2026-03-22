package com.claudeway

import android.Manifest
import android.content.pm.PackageManager
import android.os.Build
import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.remember
import androidx.compose.ui.Modifier
import androidx.core.content.ContextCompat
import androidx.lifecycle.viewmodel.compose.viewModel
import androidx.navigation.compose.NavHost
import androidx.navigation.compose.composable
import androidx.navigation.compose.rememberNavController
import com.claudeway.voice.VoiceViewModel
import com.claudeway.ui.ClaudewayTheme
import com.claudeway.ui.ConnectionScreen
import com.claudeway.ui.ConversationScreen

class MainActivity : ComponentActivity() {
    private val requiredPermissions = buildList {
        add(Manifest.permission.RECORD_AUDIO)
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
            add(Manifest.permission.BLUETOOTH_CONNECT)
            add(Manifest.permission.BLUETOOTH_SCAN)
        }
    }.toTypedArray()

    private val permissionLauncher = registerForActivityResult(
        ActivityResultContracts.RequestMultiplePermissions()
    ) { /* Permissions handled — UI adapts based on state */ }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)

        // Request permissions if not already granted
        val missingPermissions = requiredPermissions.filter {
            ContextCompat.checkSelfPermission(this, it) != PackageManager.PERMISSION_GRANTED
        }
        if (missingPermissions.isNotEmpty()) {
            permissionLauncher.launch(missingPermissions.toTypedArray())
        }

        setContent {
            ClaudewayTheme {
                Surface(
                    modifier = Modifier.fillMaxSize(),
                    color = MaterialTheme.colorScheme.background,
                ) {
                    ClaudewayNavHost()
                }
            }
        }
    }
}

@Composable
private fun ClaudewayNavHost() {
    val navController = rememberNavController()
    val viewModel: VoiceViewModel = viewModel()
    val uiState by viewModel.uiState.collectAsState()
    val micLevel by viewModel.micLevel.collectAsState()
    val availableRoutes by viewModel.availableRoutes.collectAsState()
    val activeRouteId by viewModel.activeRouteId.collectAsState()
    val selectedRouteId by viewModel.selectedRouteId.collectAsState()

    val prefs = viewModel.getApplication<android.app.Application>()
        .getSharedPreferences("claudeway", android.content.Context.MODE_PRIVATE)

    // Read credentials live from prefs (not cached) so retry/settings always use latest values
    fun readUrl() = prefs.getString("server_url", "") ?: ""
    fun readToken() = prefs.getString("auth_token", "") ?: ""

    val initialUrl = remember { readUrl() }
    val initialToken = remember { readToken() }
    val hasSavedCredentials = initialUrl.isNotBlank() && initialToken.isNotBlank()
    val startDestination = if (hasSavedCredentials) "conversation" else "connection"

    // Auto-connect when launching directly to conversation with saved credentials
    if (hasSavedCredentials) {
        LaunchedEffect(Unit) {
            viewModel.connect(initialUrl, initialToken)
        }
    }

    NavHost(navController = navController, startDestination = startDestination) {
        composable("connection") {
            ConnectionScreen(
                connectionState = uiState.connectionState,
                connectionError = uiState.connectionError,
                glassesState = uiState.glassesState,
                audioRouteState = uiState.audioRouteState,
                savedUrl = readUrl(),
                savedToken = readToken(),
                onConnect = { url, token ->
                    prefs.edit().putString("server_url", url).putString("auth_token", token).apply()
                    viewModel.connect(url, token)
                },
                onDisconnect = { viewModel.disconnect() },
                onNavigateToConversation = { navController.navigate("conversation") },
            )
        }

        composable("conversation") {
            ConversationScreen(
                connectionState = uiState.connectionState,
                voiceFlowState = uiState.voiceFlowState,
                statusText = uiState.statusText,
                audioRouteState = uiState.audioRouteState,
                inputMode = uiState.inputMode,
                micLevel = micLevel,
                messages = uiState.messages,
                activeTranscript = uiState.activeTranscript,
                activeResponseText = uiState.activeResponseText,
                availableRoutes = availableRoutes,
                activeRouteId = activeRouteId,
                selectedRouteId = selectedRouteId,
                channelName = uiState.channelName,
                channelRepo = uiState.channelRepo,
                ttsEnabled = uiState.ttsEnabled,
                onNewChat = { viewModel.newChat(readUrl(), readToken()) },
                onToggleTts = { viewModel.toggleTts() },
                onSendText = { viewModel.sendText(it) },
                onStartRecording = { viewModel.startRecording() },
                onStopRecording = { viewModel.stopRecording() },
                onCancel = { viewModel.cancelCurrentRequest() },
                onSetInputMode = { viewModel.setInputMode(it) },
                onApplyAudioRoute = { routeId -> viewModel.applyAudioRouteSelection(routeId) },
                onNavigateToSettings = {
                    navController.navigate("connection") {
                        launchSingleTop = true
                    }
                },
                onRetryConnection = { viewModel.connect(readUrl(), readToken()) },
                deviceToasts = viewModel.deviceToasts,
            )
        }
    }
}

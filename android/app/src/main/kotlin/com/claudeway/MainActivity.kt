package com.claudeway

import android.Manifest
import android.content.pm.PackageManager
import android.os.Build
import android.os.Bundle
import android.view.KeyEvent
import androidx.activity.ComponentActivity
import androidx.activity.viewModels
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
import androidx.compose.ui.platform.LocalContext
import android.app.Activity
import androidx.compose.ui.Modifier
import androidx.core.content.ContextCompat
import androidx.lifecycle.viewmodel.compose.viewModel
import androidx.navigation.compose.NavHost
import androidx.navigation.compose.composable
import androidx.navigation.compose.rememberNavController
import com.claudeway.settings.ConnectionSettingsRepository
import com.claudeway.voice.VoiceViewModel
import com.claudeway.ui.ClaudewayTheme
import com.claudeway.ui.ConnectionScreen
import com.claudeway.ui.ConversationScreen

class MainActivity : ComponentActivity() {
    private val voiceViewModel: VoiceViewModel by viewModels()

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

    override fun onKeyDown(keyCode: Int, event: KeyEvent?): Boolean {
        if (keyCode == KeyEvent.KEYCODE_VOLUME_UP) {
            if (voiceViewModel.onVolumeUpPress()) return true
        }
        return super.onKeyDown(keyCode, event)
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)

        // Request permissions if not already granted
        val missingPermissions = requiredPermissions.filter {
            ContextCompat.checkSelfPermission(this, it) != PackageManager.PERMISSION_GRANTED
        }
        if (missingPermissions.isNotEmpty()) {
            permissionLauncher.launch(missingPermissions.toTypedArray())
        }

        // Use the activity-scoped ViewModel so onKeyDown can reach it
        // (Compose's viewModel() will return the same instance)

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
    val context = LocalContext.current
    val navController = rememberNavController()
    val viewModel: VoiceViewModel = viewModel()
    val uiState by viewModel.uiState.collectAsState()
    val micLevel by viewModel.micLevel.collectAsState()
    val availableRoutes by viewModel.availableRoutes.collectAsState()
    val activeRouteId by viewModel.activeRouteId.collectAsState()
    val selectedRouteId by viewModel.selectedRouteId.collectAsState()
    val settingsRepository = remember(context) { ConnectionSettingsRepository(context) }

    fun loadSettings() = settingsRepository.load()

    val initialSettings = remember(settingsRepository) { loadSettings() }
    val startDestination = if (initialSettings.hasCredentials) "conversation" else "connection"

    // Auto-connect when launching directly to conversation with saved credentials
    if (initialSettings.hasCredentials) {
        LaunchedEffect(Unit) {
            viewModel.connect(initialSettings.serverUrl, initialSettings.authToken)
        }
    }

    NavHost(navController = navController, startDestination = startDestination) {
        composable("connection") {
            val settings = loadSettings()
            ConnectionScreen(
                connectionState = uiState.connectionState,
                connectionError = uiState.connectionError,
                glassesState = uiState.glassesState,
                audioRouteState = uiState.audioRouteState,
                savedUrl = settings.serverUrl,
                savedToken = settings.authToken,
                onConnect = { url, token ->
                    settingsRepository.save(url, token)
                    viewModel.connect(url, token)
                },
                onDisconnect = { viewModel.disconnect() },
                onNavigateToConversation = { navController.navigate("conversation") },
                onRegisterGlasses = {
                    (context as? Activity)?.let { viewModel.registerGlasses(it) }
                },
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
                onNewChat = {
                    val settings = loadSettings()
                    viewModel.newChat(settings.serverUrl, settings.authToken)
                },
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
                onRetryConnection = {
                    val settings = loadSettings()
                    viewModel.connect(settings.serverUrl, settings.authToken)
                },
                deviceToasts = viewModel.deviceToasts,
            )
        }
    }
}

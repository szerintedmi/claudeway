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
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.remember
import androidx.compose.ui.Modifier
import androidx.core.content.ContextCompat
import androidx.lifecycle.viewmodel.compose.viewModel
import androidx.navigation.compose.NavHost
import androidx.navigation.compose.composable
import androidx.navigation.compose.rememberNavController
import com.claudeway.glasses.GlassesViewModel
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
    val viewModel: GlassesViewModel = viewModel()
    val uiState by viewModel.uiState.collectAsState()
    val prefs = viewModel.getApplication<android.app.Application>()
        .getSharedPreferences("claudeway", android.content.Context.MODE_PRIVATE)
    val savedUrl = remember { prefs.getString("server_url", "") ?: "" }
    val savedToken = remember { prefs.getString("auth_token", "") ?: "" }

    NavHost(navController = navController, startDestination = "connection") {
        composable("connection") {
            ConnectionScreen(
                connectionState = uiState.connectionState,
                connectionError = uiState.connectionError,
                glassesState = uiState.glassesState,
                audioRouteState = uiState.audioRouteState,
                savedUrl = savedUrl,
                savedToken = savedToken,
                onConnect = { url, token ->
                    prefs.edit().putString("server_url", url).putString("auth_token", token).apply()
                    viewModel.connect(url, token)
                },
                onDisconnect = { viewModel.disconnect() },
                onRouteAudio = { viewModel.tryRouteAudioToBluetooth() },
                onNavigateToConversation = { navController.navigate("conversation") },
            )
        }

        composable("conversation") {
            ConversationScreen(
                connectionState = uiState.connectionState,
                voiceFlowState = uiState.voiceFlowState,
                statusText = uiState.statusText,
                messages = uiState.messages,
                activeTranscript = uiState.activeTranscript,
                activeResponseText = uiState.activeResponseText,
                onSendText = { viewModel.sendText(it) },
                onStartRecording = { viewModel.startRecording() },
                onStopRecording = { viewModel.stopRecording() },
                onCancel = { viewModel.cancelCurrentRequest() },
            )
        }
    }
}

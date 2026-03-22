package com.claudeway.network

import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.SharedFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asSharedFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import java.util.concurrent.TimeUnit

enum class ConnectionState {
    Disconnected,
    Connecting,
    Connected,
    Reconnecting,
    Error,
}

/**
 * Connection error details surfaced to the UI.
 */
data class ConnectionError(
    val code: Int?,
    val message: String,
)

class ClaudewayWebSocket(
    private val scope: CoroutineScope,
) {
    private val client = OkHttpClient.Builder()
        .connectTimeout(10, TimeUnit.SECONDS)
        .readTimeout(0, TimeUnit.MINUTES) // No read timeout for WebSocket
        .pingInterval(30, TimeUnit.SECONDS) // OkHttp-level ping
        .build()

    private val _connectionState = MutableStateFlow(ConnectionState.Disconnected)
    val connectionState: StateFlow<ConnectionState> = _connectionState.asStateFlow()

    private val _connectionError = MutableStateFlow<ConnectionError?>(null)
    val connectionError: StateFlow<ConnectionError?> = _connectionError.asStateFlow()

    private val _messages = MutableSharedFlow<ServerMessage>(extraBufferCapacity = 256)
    val messages: SharedFlow<ServerMessage> = _messages.asSharedFlow()

    private var webSocket: WebSocket? = null
    private var serverUrl: String? = null
    private var authToken: String? = null
    private var shouldReconnect = false
    private var reconnectJob: Job? = null
    private var pingJob: Job? = null
    private var reconnectAttempt = 0

    fun connect(url: String, token: String) {
        disconnect()
        serverUrl = url
        authToken = token
        shouldReconnect = true
        reconnectAttempt = 0
        _connectionError.value = null
        doConnect()
    }

    fun disconnect() {
        shouldReconnect = false
        reconnectJob?.cancel()
        reconnectJob = null
        pingJob?.cancel()
        pingJob = null
        webSocket?.close(1000, "Client disconnect")
        webSocket = null
        _connectionState.value = ConnectionState.Disconnected
    }

    /**
     * If we should be connected but aren't, reconnect immediately
     * (skipping any backoff delay). Called on app resume.
     */
    fun reconnectNow() {
        if (!shouldReconnect) return
        if (_connectionState.value == ConnectionState.Connected) return
        reconnectJob?.cancel()
        reconnectJob = null
        reconnectAttempt = 0
        doConnect()
    }

    fun send(message: ClientMessage): Boolean {
        val ws = webSocket ?: return false
        if (_connectionState.value != ConnectionState.Connected) return false
        val json = ProtocolAdapters.serializeClientMessage(message)
        return ws.send(json)
    }

    private fun doConnect() {
        val url = serverUrl ?: return
        val token = authToken ?: return

        _connectionState.value = if (reconnectAttempt > 0) ConnectionState.Reconnecting else ConnectionState.Connecting

        val request = Request.Builder()
            .url(url)
            .header("Authorization", "Bearer $token")
            .build()

        webSocket = client.newWebSocket(request, object : WebSocketListener() {
            override fun onOpen(webSocket: WebSocket, response: Response) {
                reconnectAttempt = 0
                _connectionState.value = ConnectionState.Connected
                startPingLoop()
            }

            override fun onMessage(webSocket: WebSocket, text: String) {
                val msg = ProtocolAdapters.parseServerMessage(text) ?: return
                _messages.tryEmit(msg)
            }

            override fun onClosing(webSocket: WebSocket, code: Int, reason: String) {
                webSocket.close(code, reason)
            }

            override fun onClosed(webSocket: WebSocket, code: Int, reason: String) {
                pingJob?.cancel()
                if (shouldReconnect) {
                    scheduleReconnect()
                } else {
                    _connectionState.value = ConnectionState.Disconnected
                }
            }

            override fun onFailure(webSocket: WebSocket, t: Throwable, response: Response?) {
                pingJob?.cancel()
                val code = response?.code
                // Client errors (4xx) are not retriable — surface to UI immediately
                if (code != null && code in 400..499) {
                    shouldReconnect = false
                    val body = try { response.body?.string()?.take(200) } catch (_: Exception) { null }
                    val msg = body?.ifBlank { null } ?: response.message.ifBlank { "HTTP $code" }
                    _connectionError.value = ConnectionError(code, msg)
                    _connectionState.value = ConnectionState.Error
                    return
                }
                if (shouldReconnect) {
                    scheduleReconnect()
                } else {
                    _connectionError.value = ConnectionError(null, t.message ?: "Connection failed")
                    _connectionState.value = ConnectionState.Disconnected
                }
            }
        })
    }

    private fun scheduleReconnect() {
        reconnectJob?.cancel()
        reconnectJob = scope.launch {
            _connectionState.value = ConnectionState.Reconnecting
            val delayMs = minOf(1000L * (1L shl minOf(reconnectAttempt, 5)), 30_000L)
            reconnectAttempt++
            delay(delayMs)
            doConnect()
        }
    }

    private fun startPingLoop() {
        pingJob?.cancel()
        pingJob = scope.launch {
            while (true) {
                delay(30_000)
                send(PingMessage())
            }
        }
    }
}

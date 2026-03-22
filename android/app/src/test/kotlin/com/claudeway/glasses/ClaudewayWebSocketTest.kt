package com.claudeway.glasses

import com.claudeway.glasses.network.ClaudewayWebSocket
import com.claudeway.glasses.network.ConnectionState
import com.claudeway.glasses.network.PingMessage
import com.claudeway.glasses.network.TextMessage
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.test.TestScope
import kotlinx.coroutines.test.UnconfinedTestDispatcher
import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Test

@OptIn(ExperimentalCoroutinesApi::class)
class ClaudewayWebSocketTest {
    @Test
    fun `initial state is disconnected`() = runTest {
        val ws = ClaudewayWebSocket(TestScope(UnconfinedTestDispatcher(testScheduler)))
        assertEquals(ConnectionState.Disconnected, ws.connectionState.value)
    }

    @Test
    fun `send returns false when disconnected`() = runTest {
        val ws = ClaudewayWebSocket(TestScope(UnconfinedTestDispatcher(testScheduler)))
        val result = ws.send(TextMessage(requestId = "test", text = "hello"))
        assertFalse(result)
    }

    @Test
    fun `send ping returns false when disconnected`() = runTest {
        val ws = ClaudewayWebSocket(TestScope(UnconfinedTestDispatcher(testScheduler)))
        val result = ws.send(PingMessage())
        assertFalse(result)
    }

    @Test
    fun `disconnect sets state to disconnected`() = runTest {
        val ws = ClaudewayWebSocket(TestScope(UnconfinedTestDispatcher(testScheduler)))
        ws.disconnect()
        assertEquals(ConnectionState.Disconnected, ws.connectionState.value)
    }
}

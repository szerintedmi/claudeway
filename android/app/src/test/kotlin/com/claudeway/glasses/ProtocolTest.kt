package com.claudeway.glasses

import com.claudeway.glasses.network.AudioChunkMessage
import com.claudeway.glasses.network.AudioEndMessage
import com.claudeway.glasses.network.AudioFormat
import com.claudeway.glasses.network.AudioStartMessage
import com.claudeway.glasses.network.CancelMessage
import com.claudeway.glasses.network.ErrorServerMessage
import com.claudeway.glasses.network.PingMessage
import com.claudeway.glasses.network.PongServerMessage
import com.claudeway.glasses.network.ProtocolAdapters
import com.claudeway.glasses.network.ResponseAudioEndServerMessage
import com.claudeway.glasses.network.ResponseAudioServerMessage
import com.claudeway.glasses.network.ResponseTextServerMessage
import com.claudeway.glasses.network.StatusServerMessage
import com.claudeway.glasses.network.TextMessage
import com.claudeway.glasses.network.TranscriptServerMessage
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class ProtocolTest {
    // --- Client -> Server serialization ---

    @Test
    fun `serialize text message`() {
        val msg = TextMessage(requestId = "req-1", text = "hello")
        val json = ProtocolAdapters.serializeClientMessage(msg)
        assertTrue(json.contains(""""type":"text""""))
        assertTrue(json.contains(""""requestId":"req-1""""))
        assertTrue(json.contains(""""text":"hello""""))
    }

    @Test
    fun `serialize audio_start message`() {
        val msg = AudioStartMessage(
            requestId = "req-2",
            format = AudioFormat(
                mimeType = "audio/l16;rate=8000",
                sampleRate = 8000,
                channels = 1,
                encoding = "linear16",
            ),
        )
        val json = ProtocolAdapters.serializeClientMessage(msg)
        assertTrue(json.contains(""""type":"audio_start""""))
        assertTrue(json.contains(""""mimeType":"audio/l16;rate=8000""""))
        assertTrue(json.contains(""""sampleRate":8000"""))
    }

    @Test
    fun `serialize audio_chunk message`() {
        val msg = AudioChunkMessage(requestId = "req-2", data = "AQID")
        val json = ProtocolAdapters.serializeClientMessage(msg)
        assertTrue(json.contains(""""type":"audio_chunk""""))
        assertTrue(json.contains(""""data":"AQID""""))
    }

    @Test
    fun `serialize audio_end message`() {
        val msg = AudioEndMessage(requestId = "req-2")
        val json = ProtocolAdapters.serializeClientMessage(msg)
        assertTrue(json.contains(""""type":"audio_end""""))
    }

    @Test
    fun `serialize cancel message`() {
        val msg = CancelMessage(requestId = "req-3")
        val json = ProtocolAdapters.serializeClientMessage(msg)
        assertTrue(json.contains(""""type":"cancel""""))
    }

    @Test
    fun `serialize ping message`() {
        val msg = PingMessage()
        val json = ProtocolAdapters.serializeClientMessage(msg)
        assertTrue(json.contains(""""type":"ping""""))
    }

    // --- Server -> Client deserialization ---

    @Test
    fun `parse status message`() {
        val json = """{"type":"status","requestId":"req-1","status":"thinking"}"""
        val msg = ProtocolAdapters.parseServerMessage(json)
        assertNotNull(msg)
        assertTrue(msg is StatusServerMessage)
        val status = msg as StatusServerMessage
        assertEquals("req-1", status.requestId)
        assertEquals("thinking", status.status)
        assertNull(status.toolName)
    }

    @Test
    fun `parse status message with tool info`() {
        val json = """{"type":"status","requestId":"req-1","status":"tool","toolName":"Read","keyArg":"src/index.ts","phase":"running","description":"Reading file"}"""
        val msg = ProtocolAdapters.parseServerMessage(json) as StatusServerMessage
        assertEquals("tool", msg.status)
        assertEquals("Read", msg.toolName)
        assertEquals("src/index.ts", msg.keyArg)
        assertEquals("running", msg.phase)
        assertEquals("Reading file", msg.description)
    }

    @Test
    fun `parse transcript message`() {
        val json = """{"type":"transcript","requestId":"req-1","text":"hello world","final":true}"""
        val msg = ProtocolAdapters.parseServerMessage(json) as TranscriptServerMessage
        assertEquals("hello world", msg.text)
        assertTrue(msg.isFinal)
    }

    @Test
    fun `parse response_text message`() {
        val json = """{"type":"response_text","requestId":"req-1","text":"chunk","final":false}"""
        val msg = ProtocolAdapters.parseServerMessage(json) as ResponseTextServerMessage
        assertEquals("chunk", msg.text)
        assertEquals(false, msg.isFinal)
    }

    @Test
    fun `parse response_audio message`() {
        val json = """{"type":"response_audio","requestId":"req-1","data":"AQID","encoding":"linear16","sampleRate":24000}"""
        val msg = ProtocolAdapters.parseServerMessage(json) as ResponseAudioServerMessage
        assertEquals("AQID", msg.data)
        assertEquals("linear16", msg.encoding)
        assertEquals(24000, msg.sampleRate)
    }

    @Test
    fun `parse response_audio_end message`() {
        val json = """{"type":"response_audio_end","requestId":"req-1"}"""
        val msg = ProtocolAdapters.parseServerMessage(json) as ResponseAudioEndServerMessage
        assertEquals("req-1", msg.requestId)
    }

    @Test
    fun `parse error message with requestId`() {
        val json = """{"type":"error","requestId":"req-1","message":"cancelled"}"""
        val msg = ProtocolAdapters.parseServerMessage(json) as ErrorServerMessage
        assertEquals("req-1", msg.requestId)
        assertEquals("cancelled", msg.message)
    }

    @Test
    fun `parse error message with null requestId`() {
        val json = """{"type":"error","requestId":null,"message":"connection error"}"""
        val msg = ProtocolAdapters.parseServerMessage(json) as ErrorServerMessage
        assertNull(msg.requestId)
        assertEquals("connection error", msg.message)
    }

    @Test
    fun `parse pong message`() {
        val json = """{"type":"pong"}"""
        val msg = ProtocolAdapters.parseServerMessage(json)
        assertTrue(msg is PongServerMessage)
    }

    @Test
    fun `parse unknown type returns null`() {
        val json = """{"type":"unknown_message","foo":"bar"}"""
        val msg = ProtocolAdapters.parseServerMessage(json)
        assertNull(msg)
    }

    @Test
    fun `parse invalid json returns null`() {
        val msg = ProtocolAdapters.parseServerMessage("not json")
        assertNull(msg)
    }
}

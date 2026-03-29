package com.claudeway

import com.claudeway.network.AudioChunkMessage
import com.claudeway.network.AudioEndMessage
import com.claudeway.network.AudioFormat
import com.claudeway.network.AudioStartMessage
import com.claudeway.network.CancelMessage
import com.claudeway.network.ChannelInfoServerMessage
import com.claudeway.network.ErrorServerMessage
import com.claudeway.network.PingMessage
import com.claudeway.network.PongServerMessage
import com.claudeway.network.ProtocolAdapters
import com.claudeway.network.ResponseAudioEndServerMessage
import com.claudeway.network.ResponseAudioServerMessage
import com.claudeway.network.ResponseTextServerMessage
import com.claudeway.network.StatusServerMessage
import com.claudeway.network.TextMessage
import com.claudeway.network.TranscriptServerMessage
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

    // --- Snapshot tests: Kotlin JSON output matches TypeScript protocol definition ---

    /**
     * Compare JSON structures for equivalence, ignoring key order.
     * Both inputs must be valid JSON objects.
     */
    private fun assertJsonEquals(expected: String, actual: String) {
        val expectedObj = org.json.JSONObject(expected)
        val actualObj = org.json.JSONObject(actual)
        val expectedKeys = expectedObj.keys().asSequence().toSet()
        val actualKeys = actualObj.keys().asSequence().toSet()
        assertEquals(expectedKeys, actualKeys)
        for (key in expectedKeys) {
            val ev = expectedObj.get(key)
            val av = actualObj.get(key)
            if (ev is org.json.JSONObject) {
                assertTrue("Expected JSONObject for key '$key'", av is org.json.JSONObject)
                assertJsonEquals(ev.toString(), av.toString())
            } else {
                assertEquals("Mismatch for key '$key'", ev.toString(), av.toString())
            }
        }
    }

    // --- Client -> Server snapshot fixtures (must match TypeScript protocol.ts) ---

    @Test
    fun `snapshot - text message matches TypeScript format`() {
        val msg = TextMessage(requestId = "req-1", text = "hello")
        val json = ProtocolAdapters.serializeClientMessage(msg)
        val expected = """{"type":"text","requestId":"req-1","text":"hello"}"""
        assertJsonEquals(expected, json)
    }

    @Test
    fun `snapshot - text message with tts flag`() {
        val msg = TextMessage(requestId = "req-1", text = "hello", tts = false)
        val json = ProtocolAdapters.serializeClientMessage(msg)
        val expected = """{"type":"text","requestId":"req-1","text":"hello","tts":false}"""
        assertJsonEquals(expected, json)
    }

    @Test
    fun `snapshot - audio_start matches TypeScript format`() {
        val msg = AudioStartMessage(
            requestId = "req-2",
            format = AudioFormat(
                mimeType = "audio/l16;rate=16000",
                sampleRate = 16000,
                channels = 1,
                encoding = "linear16",
            ),
        )
        val json = ProtocolAdapters.serializeClientMessage(msg)
        val expected = """{"type":"audio_start","requestId":"req-2","format":{"mimeType":"audio/l16;rate=16000","sampleRate":16000,"channels":1,"encoding":"linear16"}}"""
        assertJsonEquals(expected, json)
    }

    @Test
    fun `snapshot - audio_start with tts flag`() {
        val msg = AudioStartMessage(
            requestId = "req-2",
            format = AudioFormat(mimeType = "audio/l16;rate=16000", sampleRate = 16000, channels = 1, encoding = "linear16"),
            tts = false,
        )
        val json = ProtocolAdapters.serializeClientMessage(msg)
        val expected = """{"type":"audio_start","requestId":"req-2","format":{"mimeType":"audio/l16;rate=16000","sampleRate":16000,"channels":1,"encoding":"linear16"},"tts":false}"""
        assertJsonEquals(expected, json)
    }

    @Test
    fun `snapshot - audio_chunk matches TypeScript format`() {
        val msg = AudioChunkMessage(requestId = "req-2", data = "AQIDBA==")
        val json = ProtocolAdapters.serializeClientMessage(msg)
        val expected = """{"type":"audio_chunk","requestId":"req-2","data":"AQIDBA=="}"""
        assertJsonEquals(expected, json)
    }

    @Test
    fun `snapshot - audio_end matches TypeScript format`() {
        val msg = AudioEndMessage(requestId = "req-2")
        val json = ProtocolAdapters.serializeClientMessage(msg)
        val expected = """{"type":"audio_end","requestId":"req-2"}"""
        assertJsonEquals(expected, json)
    }

    @Test
    fun `snapshot - cancel matches TypeScript format`() {
        val msg = CancelMessage(requestId = "req-3")
        val json = ProtocolAdapters.serializeClientMessage(msg)
        val expected = """{"type":"cancel","requestId":"req-3"}"""
        assertJsonEquals(expected, json)
    }

    @Test
    fun `snapshot - ping matches TypeScript format`() {
        val msg = PingMessage()
        val json = ProtocolAdapters.serializeClientMessage(msg)
        val expected = """{"type":"ping"}"""
        assertJsonEquals(expected, json)
    }

    // --- Server -> Client round-trip: parse then verify all fields ---

    @Test
    fun `snapshot - status with usage round-trips correctly`() {
        val json = """{"type":"status","requestId":"req-1","status":"tool","toolName":"Bash","keyArg":"ls","phase":"running","description":"Listing files","usage":{"toolUses":3,"tokens":1500,"durationMs":2000}}"""
        val msg = ProtocolAdapters.parseServerMessage(json) as StatusServerMessage
        assertEquals("req-1", msg.requestId)
        assertEquals("tool", msg.status)
        assertEquals("Bash", msg.toolName)
        assertEquals("ls", msg.keyArg)
        assertEquals("running", msg.phase)
        assertEquals("Listing files", msg.description)
        assertNotNull(msg.usage)
        assertEquals(3, msg.usage?.toolUses)
        assertEquals(1500, msg.usage?.tokens)
        assertEquals(2000L, msg.usage!!.durationMs)
    }

    @Test
    fun `snapshot - channel_info round-trips correctly`() {
        val json = """{"type":"channel_info","channelId":"glasses-default","channelName":"my-glasses","repo":"claudeway","model":"opus"}"""
        val msg = ProtocolAdapters.parseServerMessage(json) as ChannelInfoServerMessage
        assertEquals("glasses-default", msg.channelId)
        assertEquals("my-glasses", msg.channelName)
        assertEquals("claudeway", msg.repo)
        assertEquals("opus", msg.model)
    }

    @Test
    fun `snapshot - channel_info with null repo`() {
        val json = """{"type":"channel_info","channelId":"ch-1","channelName":"test","repo":null,"model":"sonnet"}"""
        val msg = ProtocolAdapters.parseServerMessage(json) as ChannelInfoServerMessage
        assertNull(msg.repo)
    }

    @Test
    fun `snapshot - response_audio matches TypeScript fields`() {
        val json = """{"type":"response_audio","requestId":"req-1","data":"AQID","encoding":"linear16","sampleRate":24000}"""
        val msg = ProtocolAdapters.parseServerMessage(json) as ResponseAudioServerMessage
        assertEquals("AQID", msg.data)
        assertEquals("linear16", msg.encoding)
        assertEquals(24000, msg.sampleRate)
    }
}

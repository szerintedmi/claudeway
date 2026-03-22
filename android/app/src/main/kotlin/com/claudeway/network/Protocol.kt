package com.claudeway.network

import org.json.JSONObject

// --- Audio format descriptor (matches server AudioFormat) ---

data class AudioFormat(
    val mimeType: String,
    val sampleRate: Int? = null,
    val channels: Int? = null,
    val encoding: String? = null,
)

// --- Client -> Server messages ---

sealed interface ClientMessage {
    fun toJson(): String
}

data class TextMessage(
    val requestId: String,
    val text: String,
) : ClientMessage {
    override fun toJson(): String = JSONObject().apply {
        put("type", "text")
        put("requestId", requestId)
        put("text", text)
    }.toString()
}

data class AudioStartMessage(
    val requestId: String,
    val format: AudioFormat,
) : ClientMessage {
    override fun toJson(): String = JSONObject().apply {
        put("type", "audio_start")
        put("requestId", requestId)
        put("format", JSONObject().apply {
            put("mimeType", format.mimeType)
            format.sampleRate?.let { put("sampleRate", it) }
            format.channels?.let { put("channels", it) }
            format.encoding?.let { put("encoding", it) }
        })
    }.toString()
}

data class AudioChunkMessage(
    val requestId: String,
    val data: String, // base64-encoded audio bytes
) : ClientMessage {
    override fun toJson(): String = JSONObject().apply {
        put("type", "audio_chunk")
        put("requestId", requestId)
        put("data", data)
    }.toString()
}

data class AudioEndMessage(
    val requestId: String,
) : ClientMessage {
    override fun toJson(): String = JSONObject().apply {
        put("type", "audio_end")
        put("requestId", requestId)
    }.toString()
}

data class CancelMessage(
    val requestId: String,
) : ClientMessage {
    override fun toJson(): String = JSONObject().apply {
        put("type", "cancel")
        put("requestId", requestId)
    }.toString()
}

class PingMessage : ClientMessage {
    override fun toJson(): String = """{"type":"ping"}"""
}

// --- Server -> Client messages ---

sealed interface ServerMessage

data class ToolUsage(
    val toolUses: Int = 0,
    val tokens: Int = 0,
    val durationMs: Long = 0,
)

data class StatusServerMessage(
    val requestId: String,
    val status: String,
    val toolName: String? = null,
    val keyArg: String? = null,
    val phase: String? = null,
    val description: String? = null,
    val usage: ToolUsage? = null,
) : ServerMessage

data class TranscriptServerMessage(
    val requestId: String,
    val text: String,
    val isFinal: Boolean,
) : ServerMessage

data class ResponseTextServerMessage(
    val requestId: String,
    val text: String,
    val isFinal: Boolean,
) : ServerMessage

data class ResponseAudioServerMessage(
    val requestId: String,
    val data: String, // base64-encoded audio bytes
    val encoding: String, // e.g. "linear16"
    val sampleRate: Int, // e.g. 24000
) : ServerMessage

data class ResponseAudioEndServerMessage(
    val requestId: String,
) : ServerMessage

data class ErrorServerMessage(
    val requestId: String?,
    val message: String,
) : ServerMessage

data class ChannelInfoServerMessage(
    val channelId: String,
    val channelName: String,
    val repo: String?,
    val model: String,
) : ServerMessage

class PongServerMessage : ServerMessage

// --- Serialization helpers ---

object ProtocolAdapters {
    /** Parse a server JSON message by reading the "type" field and dispatching. */
    fun parseServerMessage(json: String): ServerMessage? {
        return try {
            val obj = JSONObject(json)
            when (obj.optString("type")) {
                "status" -> {
                    val usageObj = obj.optJSONObject("usage")
                    val usage = if (usageObj != null) {
                        ToolUsage(
                            toolUses = usageObj.optInt("toolUses", 0),
                            tokens = usageObj.optInt("tokens", 0),
                            durationMs = usageObj.optLong("durationMs", 0),
                        )
                    } else null
                    StatusServerMessage(
                        requestId = obj.getString("requestId"),
                        status = obj.getString("status"),
                        toolName = obj.optStringOrNull("toolName"),
                        keyArg = obj.optStringOrNull("keyArg"),
                        phase = obj.optStringOrNull("phase"),
                        description = obj.optStringOrNull("description"),
                        usage = usage,
                    )
                }
                "transcript" -> TranscriptServerMessage(
                    requestId = obj.getString("requestId"),
                    text = obj.getString("text"),
                    isFinal = obj.getBoolean("final"),
                )
                "response_text" -> ResponseTextServerMessage(
                    requestId = obj.getString("requestId"),
                    text = obj.getString("text"),
                    isFinal = obj.getBoolean("final"),
                )
                "response_audio" -> ResponseAudioServerMessage(
                    requestId = obj.getString("requestId"),
                    data = obj.getString("data"),
                    encoding = obj.getString("encoding"),
                    sampleRate = obj.getInt("sampleRate"),
                )
                "response_audio_end" -> ResponseAudioEndServerMessage(
                    requestId = obj.getString("requestId"),
                )
                "error" -> ErrorServerMessage(
                    requestId = if (obj.isNull("requestId")) null else obj.getString("requestId"),
                    message = obj.getString("message"),
                )
                "channel_info" -> ChannelInfoServerMessage(
                    channelId = obj.getString("channelId"),
                    channelName = obj.getString("channelName"),
                    repo = if (obj.isNull("repo")) null else obj.optString("repo", null),
                    model = obj.getString("model"),
                )
                "pong" -> PongServerMessage()
                else -> null
            }
        } catch (_: Exception) {
            null
        }
    }

    /** Serialize a client message to JSON. */
    fun serializeClientMessage(msg: ClientMessage): String = msg.toJson()

    /** Helper: returns null instead of empty string for missing JSON keys. */
    private fun JSONObject.optStringOrNull(key: String): String? {
        return if (has(key) && !isNull(key)) getString(key) else null
    }
}

# TTS Mode Options

**Date**: 2026-03-22
**Status**: Draft

## Overview

Add configurable TTS modes to the voice channel. Currently, TTS is server-side only: the server calls Deepgram Aura-2, generates PCM audio, and streams it to the client over WebSocket. This spec adds two additional modes — client-side Deepgram and Android built-in TTS — to reduce latency and provide flexibility.

## Motivation

The server-side TTS path adds an extra network hop (Deepgram → Server → App). For latency-sensitive voice interactions, generating audio closer to the output device is beneficial. Different modes also serve different use cases: high-quality voice (Deepgram) vs. zero-network-latency voice (local TTS).

## TTS Modes

| Mode | Where TTS runs | Latency | Voice Quality | Network cost |
|---|---|---|---|---|
| `server` (default, current) | Server calls Deepgram, streams PCM to app | ~200-400ms | High (Aura-2) | High (PCM audio over WS) |
| `client-deepgram` | App calls Deepgram directly | ~150-300ms | High (Aura-2) | Low over WS (text only); app↔Deepgram separate |
| `local` | Android built-in `TextToSpeech` | ~10-50ms | Medium (device-dependent) | None (text only over WS) |

### Mode: `server` (current behavior, no changes)

1. Server receives Claude response text
2. `ProseChunker` splits text at sentence boundaries
3. Server sends chunks to Deepgram TTS WebSocket (`wss://api.deepgram.com/v1/speak`)
4. Deepgram returns PCM audio
5. Server base64-encodes PCM and sends `response_audio` messages to the app
6. App decodes and plays via `AudioTrack`

### Mode: `client-deepgram`

1. Server receives Claude response text
2. Server sends `response_text` chunks to the app (these messages already exist in the protocol)
3. Server does **not** send `response_audio` or `response_audio_end`
4. App opens its own WebSocket to `wss://api.deepgram.com/v1/speak`
5. App feeds `response_text` chunks to Deepgram, receives PCM audio
6. App plays PCM via `AudioTrack` (reuses existing `AudioPlayer`)

**Android app requirements**:
- Deepgram API key stored as a user-configurable setting (DataStore/SharedPreferences), not hardcoded
- Settings screen with a field for the Deepgram API key
- `ProseChunker`-equivalent logic on the client, or rely on server-side chunking via `response_text` boundaries
- Deepgram TTS WebSocket management (open on first chunk, close on `response_text` with `final: true`)

### Mode: `local`

1. Server receives Claude response text
2. Server sends `response_text` chunks to the app
3. Server does **not** send `response_audio` or `response_audio_end`
4. App feeds text to Android's `android.speech.tts.TextToSpeech` engine
5. Audio plays through system audio routing (respects `AudioRouter` Bluetooth SCO settings)

**Android app requirements**:
- Initialize `TextToSpeech` engine on app startup
- Feed `response_text` chunks sequentially (TTS engine queues utterances)
- Handle engine availability (some devices may not have a TTS engine installed)
- Language/voice selection in settings (optional)

## Config

```yaml
voice:
  ttsMode: server        # server | client-deepgram | local (default: server)
  provider: deepgram
  deepgram:
    apiKey: '${DEEPGRAM_API_KEY}'
    sttModel: nova-3
    ttsModel: aura-2-thalia-en
    ttsSampleRate: 24000
```

The `ttsMode` setting controls where TTS happens. The server-side `deepgram` config is still used for STT regardless of TTS mode. For `client-deepgram`, the Deepgram API key lives in the Android app's local settings (separate from the server config).

## Protocol Impact

No new message types needed. The existing protocol already supports both paths:

- **`server` mode**: Server sends `response_audio` + `response_audio_end` (current behavior)
- **`client-deepgram` / `local` modes**: Server sends `response_text` with `final: boolean` (already defined in protocol)

The server decides which messages to send based on the `ttsMode` config. The app must handle both paths: if it receives `response_audio`, play audio directly; if it receives only `response_text`, run TTS locally.

## Android App Changes

### Settings Screen

Add a TTS settings section:
- **TTS Mode** selector: Server / Client Deepgram / Local
- **Deepgram API Key** field (visible only when Client Deepgram is selected)
- **Local TTS Voice** selector (visible only when Local is selected)

Store in DataStore (preferred over SharedPreferences for coroutine support).

### TTS Manager

New component to abstract over the three modes:

```kotlin
// Conceptual interface
interface TtsManager {
    fun speak(text: String, isFinal: Boolean)
    fun stop()
    fun release()
}

// Implementations:
// - ServerTtsManager: no-op (audio comes via response_audio messages)
// - DeepgramTtsManager: WebSocket to Deepgram, feeds to AudioPlayer
// - LocalTtsManager: Android TextToSpeech engine
```

### Mode Negotiation

The app could send its preferred TTS mode in the WebSocket handshake (e.g., query param `?ttsMode=local`) so the server knows whether to generate audio or just send text. Alternatively, the server config is authoritative and the app adapts based on which message types it receives.

## Tradeoffs

### API Key Security (`client-deepgram`)

The Deepgram API key must live on the device. Mitigations:
- Store in Android Keystore (encrypted at rest)
- Use a scoped API key with TTS-only permissions (Deepgram supports key scoping)
- For a single-user personal tool, this is acceptable risk

### Offline Behavior (`local`)

Android built-in TTS works offline if the voice data is downloaded. This makes `local` mode the most resilient to network issues — useful when the server is reachable but Deepgram is not.

### Consistency

Different TTS engines produce different voices. Switching modes changes how Claude "sounds." This is a UX tradeoff the user accepts by choosing a mode.

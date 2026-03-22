# STT Optimization Options

**Date**: 2026-03-22
**Status**: Draft
**Related**: [Voice Latency Benchmarking](2026-03-22-voice-latency-benchmarking.md), [Voice Channel Spec](2026-03-16-meta-glasses-channel.md) (Phase 5: Streaming STT)

## Overview

The current STT pipeline is batch-only: audio chunks are buffered on the server until `audio_end`, then sent as a single POST to Deepgram's REST API. This adds ~200-600ms after the user stops speaking before a transcript is ready. This spec documents options to reduce STT latency, including alternative providers and client-side transcription.

## Current Architecture

```
User speaks → Android mic (8kHz PCM) → base64 chunks over WS → Server buffers
→ audio_end → Buffer.concat → POST to Deepgram /v1/listen → transcript
```

**Latency breakdown** (after user stops speaking):
- Buffer assembly: ~1-10ms
- Deepgram REST API (network + processing): ~200-500ms
- Total: ~200-600ms

## STT Modes

| Mode | Where STT runs | Latency | Quality | Network cost |
|---|---|---|---|---|
| `server-deepgram` (current) | Server → Deepgram REST | ~200-600ms after speech | High (Nova-3) | Audio over WS + server→Deepgram |
| `server-deepgram-streaming` | Server → Deepgram WS | Partial results during speech | High (Nova-3) | Audio over WS + server→Deepgram |
| `client-deepgram` | App → Deepgram directly | ~200-500ms (skip server relay) | High (Nova-3) | App→Deepgram only (no audio over WS) |
| `local` | Android `SpeechRecognizer` | ~50-200ms | Good (device-dependent) | None (text only over WS) |

### Mode: `server-deepgram` (current, no changes)

1. Client sends `audio_start`, `audio_chunk`, `audio_end` over WebSocket
2. Server buffers all chunks, concatenates on `audio_end`
3. Server POSTs full audio to Deepgram REST API (`/v1/listen`)
4. Server receives transcript, sends `transcript` message to client, queues for Claude

### Mode: `server-deepgram-streaming`

Already documented as [Phase 5 in the voice channel spec](2026-03-16-meta-glasses-channel.md). Audio chunks are forwarded to Deepgram's streaming WebSocket API in real-time during speech. Partial transcripts sent to client during recording. Final transcript available almost immediately after `audio_end`.

**Benefit over batch**: Transcript is ~ready when user stops speaking (Deepgram has been processing in parallel).

### Mode: `client-deepgram`

The Android app calls Deepgram directly, bypassing the server for audio entirely.

1. User speaks → app captures audio
2. App sends audio to Deepgram (REST or streaming) directly
3. App receives transcript
4. App sends `text` message to server (not `audio_start`/`audio_chunk`/`audio_end`)
5. Server processes text through Claude as normal

**Benefits**:
- Eliminates audio upload to server (saves bandwidth, reduces latency on slow uplinks)
- Server never handles audio — simpler server-side code path
- Can use Deepgram streaming API from the app for partial results

**Requirements**:
- Deepgram API key stored in app settings (same pattern as client-side TTS)
- App implements Deepgram API client (REST or WebSocket)
- App handles transcription errors/retries locally

### Mode: `local`

Use Android's built-in `SpeechRecognizer` API for on-device transcription.

1. User speaks → `SpeechRecognizer` processes audio locally
2. App receives transcript (partial and final results)
3. App sends `text` message to server
4. Server processes text through Claude as normal

**Benefits**:
- Zero network latency for transcription
- Works offline (if server is reachable but Deepgram is not)
- No Deepgram API cost for STT
- Built-in on all Android devices

**Limitations**:
- Quality varies by device and installed speech model
- Google's on-device models are good but not as accurate as Nova-3 for technical speech
- Language support depends on downloaded models
- Less control over formatting (punctuation, capitalization)
- May require Google Play Services on some devices

## Config

### Server-side

```yaml
voice:
  sttMode: server-deepgram   # server-deepgram | server-deepgram-streaming
  # client-deepgram and local are app-only modes — server doesn't need to know
  # (it just receives a text message instead of audio)
```

Only server-side modes need server config. When the app does STT locally (`client-deepgram` or `local`), it sends a `text` message — the server doesn't know or care how the text was produced.

### App-side

The STT mode should be a setting in the Android app:

- **STT Mode** selector: Server (default) / Client Deepgram / Local
- **Deepgram API Key** field (visible when Client Deepgram selected)
- **Language** selector (visible when Local selected)

Defaults could be provided via server config or hardcoded in the app. The key insight is that `client-deepgram` and `local` modes are purely app-side decisions — they change what the app sends over the WebSocket (`text` instead of `audio_*`), but the server protocol already supports both paths.

## Protocol Impact

No new message types needed. The `text` message type already exists:

```typescript
{ type: 'text', requestId: string, text: 'direct text input' }
```

When the app does STT locally, it sends `text` instead of `audio_start`/`audio_chunk`/`audio_end`. The server handles `text` messages identically regardless of whether the text came from the user typing or from local STT.

## Other Optimization Ideas

### Audio compression before upload

**Current**: Raw PCM (8kHz 16-bit mono) = ~16 kB/s, sent as base64 = ~21 kB/s over WS.

**Opus encoding on Android**: Compress audio before sending. Opus at 16kbps = ~2 kB/s (10x smaller). Faster upload on slow mobile networks.

- Android has built-in Opus encoding via `MediaCodec`
- Deepgram accepts Opus/WebM natively (already handled in server via `mimetype` param)
- Trade-off: slight encoding latency (~5-10ms), but saves significant upload time on slow connections

### Reduced audio chunk size

**Current**: ~100ms chunks (1600 bytes at 8kHz).

Larger chunks (200-400ms) would reduce WebSocket frame overhead but increase end-of-speech latency. Smaller chunks (50ms) would reduce last-chunk delay but increase overhead. Current 100ms is a reasonable default.

### Parallel STT + Claude prefetch

When using streaming STT, start a Claude session with partial transcript context before the final transcript is ready. Risky (may waste compute on wrong transcript) but could shave off the serial wait.

## Priority

| # | Option | Latency Impact | Effort | Recommended |
|---|---|---|---|---|
| 1 | `local` (Android SpeechRecognizer) | HIGH (~150-400ms saved) | MEDIUM | Yes, biggest win for perceived latency |
| 2 | `server-deepgram-streaming` | HIGH (transcript ready at speech end) | MEDIUM | Yes, already planned as Phase 5 |
| 3 | `client-deepgram` | MEDIUM (~50-100ms saved) | MEDIUM | Yes, pairs well with client-side TTS |
| 4 | Audio compression (Opus) | LOW-MEDIUM (upload speed) | MEDIUM | Later, helps on slow mobile networks |

The `local` mode gives the biggest perceived improvement because transcription is instant — the user stops speaking and the transcript is ready in ~50-200ms with no network round-trip.

# Voice Latency Benchmarking

**Date**: 2026-03-22
**Status**: Draft
**Related**: [TTS Latency Optimizations](2026-03-22-tts-latency-optimizations.md)

## Overview

Add end-to-end latency measurement across the full voice pipeline (STT and TTS) so we can establish baselines and validate any optimization. Without measurement, we risk adding complexity for unverified gains.

## What to Measure

### STT Pipeline (audio in → text)

**Server-side timestamps** (per requestId):

| Metric | When | Where |
|---|---|---|
| `t_audio_start` | `audio_start` message received from client | `handler.ts` |
| `t_audio_end` | `audio_end` message received from client | `handler.ts` |
| `t_stt_start` | STT request sent to Deepgram | `voice-deepgram.ts` |
| `t_stt_done` | Transcript received from Deepgram | `voice-deepgram.ts` |
| `t_claude_start` | Message queued to Claude CLI | `engine.ts` |

**Derived metrics**:

| Metric | Formula | What it tells you |
|---|---|---|
| Recording duration | `t_audio_end - t_audio_start` | How long the user spoke |
| STT latency | `t_stt_done - t_stt_start` | Deepgram transcription time |
| Audio-to-text | `t_stt_done - t_audio_end` | Time from stop speaking to transcript ready |
| Handoff delay | `t_claude_start - t_stt_done` | Overhead between transcript and Claude processing |

### TTS Pipeline (text → audio out)

**Server-side timestamps** (per requestId):

| Metric | When | Where |
|---|---|---|
| `t_text_first` | First `onTextDelta` from Claude | `responder.ts` |
| `t_chunk_first` | First chunk emitted by ProseChunker | `responder.ts` → `handleChunk()` |
| `t_tts_connected` | TTS WebSocket open confirmed | `voice-deepgram.ts` → `onopen` |
| `t_tts_sent` | First `sendText()` to Deepgram | `voice-deepgram.ts` |
| `t_audio_first` | First PCM chunk received from Deepgram | `voice-deepgram.ts` → `onmessage` |
| `t_audio_sent` | First `response_audio` sent to client | `responder.ts` |
| `t_audio_last` | Last `response_audio` sent | `responder.ts` |

**Derived metrics**:

| Metric | Formula | What it tells you |
|---|---|---|
| Chunker delay | `t_chunk_first - t_text_first` | How long text sits in the buffer |
| TTS setup | `t_tts_connected - t_chunk_first` | WebSocket handshake cost |
| Deepgram synthesis | `t_audio_first - t_tts_sent` | Time-to-first-audio from Deepgram |
| Server pipeline | `t_audio_sent - t_text_first` | Total server-side latency |
| Total TTS duration | `t_audio_last - t_tts_sent` | Full synthesis time |

### Client-Side Timestamps

| Metric | When | Where |
|---|---|---|
| `t_audio_received` | First `response_audio` message received | Android app / test UI |
| `t_audio_playing` | First audio sample scheduled for playback | `AudioPlayer` / Web Audio API |

### Full Round-Trip (end-to-end)

| Metric | Formula | What it tells you |
|---|---|---|
| Voice-to-voice | `t_audio_playing - t_audio_end` | User-perceived: stop speaking → hear response |
| Server total | `t_audio_sent - t_audio_end` | Server portion of voice-to-voice |
| Network + client | `t_audio_playing - t_audio_sent` | Transit + decode + playback scheduling |

## Implementation Approach

### Server: `VoiceLatencyTracker`

A lightweight class that collects timestamps per requestId. Created at request start, finalized at request end. Logs a structured summary line:

```
[voice-latency] requestId=abc
  stt: recording=2340ms transcription=890ms audio_to_text=920ms
  tts: chunker=245ms setup=0ms deepgram=312ms pipeline=580ms total=2340ms chunks=8
  e2e: voice_to_voice_server=4250ms
```

Should be minimal overhead — just `Date.now()` calls at each instrumentation point, no allocations during the hot path.

### Client (test UI)

Add a timing display showing per-request:
- Time from first `response_text` to first `response_audio` received
- Time from first `response_audio` to first audio sample playing
- Total round-trip if timestamps available

### Client (Android app)

Same metrics, logged via `Log.d`. Optionally displayed as a debug overlay in the conversation UI (toggled in settings).

### Protocol: `timing` message

A new server→client message type that lets the client compute end-to-end latency without clock synchronization:

```typescript
{
  type: 'timing',
  requestId: string,
  timestamps: {
    audioEnd: number,    // when server received audio_end
    sttDone: number,     // when transcript was ready
    textFirst: number,   // when first Claude text arrived
    audioFirst: number,  // when first TTS audio was sent to client
  }
}
```

Sent once per request, after `response_audio_end`. The client uses deltas between these server timestamps (which share a clock) combined with its own wall-clock measurements to compute each segment.

## Files to Modify

- `src/adapters/glasses/responder.ts` — TTS timestamp collection
- `src/adapters/glasses/handler.ts` — STT timestamp collection
- `src/core/voice-deepgram.ts` — Deepgram timing hooks (STT + TTS)
- `src/adapters/glasses/protocol.ts` — `timing` message type
- `src/adapters/glasses/test-ui/index.html` — client-side timing display
- Android app: `GlassesViewModel.kt` / `AudioPlayer.kt` — client-side timing

## Verification

- Send a voice request via test UI, confirm latency summary appears in server logs
- Confirm client-side timing display shows in test UI
- Verify timestamps are reasonable (no negative values, no missing segments)

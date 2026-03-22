# TTS Latency Optimizations

**Date**: 2026-03-22
**Status**: Draft
**Related**: [TTS Mode Options](2026-03-22-tts-mode-options.md), [Voice Latency Benchmarking](2026-03-22-voice-latency-benchmarking.md)

## Overview

The voice channel has a noticeable delay between text being generated and audio playing. This spec documents the latency sources in the current pipeline and optimization options to reduce time-to-first-audio.

## Current Latency Breakdown

**End-to-end: ~350-1200ms from text available to audio playing**

```
[Text delta arrives]
  ↓ 0-300ms   ProseChunker waits for sentence boundary
[Chunk emitted]
  ↓ 0-100ms   Flush rate limiting / coalescing
[ensureTtsStream]
  ↓ 100-300ms TLS + WebSocket handshake (first chunk only)
[sendText to Deepgram]
  ↓ 200-400ms Deepgram synthesis
[PCM audio arrives]
  ↓ 0.5-2ms   Base64 encoding
  ↓ 20-100ms  WebSocket transmission to client
[Client receives]
  ↓ 4-10ms    Base64 decode + type conversion
[Audio plays]
```

The two biggest controllable bottlenecks are the **ProseChunker buffering** and the **TTS connection setup**.

## Optimization 1: ProseChunker Max-Age Timeout

**Impact**: HIGH | **Effort**: LOW

### Problem

The chunker waits for sentence boundaries (`.?!` + whitespace) before sending text to TTS. If a boundary isn't found, text buffers indefinitely until `drain()` at turn end. Short sentences (<20 chars, `MIN_SENTENCE_LENGTH`) are held back and combined with the next chunk.

### Proposal

Add a max-age timer that flushes buffered text after a configurable timeout (e.g., 500-1000ms), regardless of whether a sentence boundary was found.

### Files

- `src/core/prose-chunker.ts` — add timer-based flush
- Constants: `MIN_SENTENCE_LENGTH = 20`, `HARD_CAP = 300`

### Trade-offs

- May send mid-sentence fragments to TTS → slightly less natural pauses
- Timer adds complexity (need to clear on boundary flush, reset on new text)

## Optimization 2: TTS WebSocket Preconnect

**Impact**: MEDIUM (100-300ms saved on first chunk) | **Effort**: LOW

### Problem

The Deepgram TTS WebSocket is opened lazily on the first text chunk (`ensureTtsStream()` in responder). The TLS + WebSocket handshake takes 100-300ms, delaying the first audio.

### Proposal

Open the TTS WebSocket connection earlier — when the responder is created (at request start), or when the thinking phase begins. The connection sits idle until text arrives, then sends immediately with no handshake delay.

### Files

- `src/adapters/glasses/responder.ts` — move `ensureTtsStream()` call to constructor or `onStart()`

### Trade-offs

- Wastes a connection if the response errors out before producing text (minimal cost)
- Deepgram may timeout idle connections (mitigate with keepalive or reconnect)

## Optimization 3: Reduce Chunker Flush Thresholds

**Impact**: MEDIUM | **Effort**: LOW

### Problem

Sentences shorter than 140 characters wait up to 2 seconds before being flushed to TTS (`SENTENCE_FLUSH_MIN_MS = 2000`, `SENTENCE_FLUSH_MIN_CHARS = 140`). Most conversational responses from Claude are shorter than 140 chars per sentence.

### Proposal

Reduce the flush delay to 500-800ms and the minimum chars to 40-80.

### Files

- `src/adapters/glasses/responder.ts` — `SENTENCE_FLUSH_MIN_CHARS`, `SENTENCE_FLUSH_MIN_MS`

### Trade-offs

- More frequent Deepgram flushes → closer to the 20/60s rate limit
- Very short fragments may sound choppy
- Current limits (16/60s internal cap) leave headroom, so moderate reduction is safe

## Optimization 4: Lower Sample Rate

**Impact**: LOW-MEDIUM | **Effort**: LOW

### Problem

24kHz linear16 PCM produces ~48 kB/s raw audio (~64 kB/s after base64). On mobile networks, transmission time for each chunk adds latency.

### Options

| Sample Rate | Bandwidth (raw) | Bandwidth (base64) | Quality |
|---|---|---|---|
| 24kHz (current) | 48 kB/s | 64 kB/s | High |
| 16kHz | 32 kB/s | 43 kB/s | Good (speech fine) |
| 8kHz | 16 kB/s | 21 kB/s | Acceptable (telephony) |

### Proposal

Make sample rate easily configurable per use case. Use 16kHz as default for mobile clients (good quality, lower bandwidth). Keep 24kHz for test UI / browser where network is fast.

### Files

- `src/adapters/glasses/index.ts` — default TTS config
- Config: `voice.deepgram.ttsSampleRate`

### Trade-offs

- 8kHz sounds noticeably worse (telephony quality)
- 16kHz is a good middle ground for speech
- Bluetooth HFP speaker is limited anyway — 24kHz may be overkill

## Optimization 5: Binary WebSocket Frames

**Impact**: LOW | **Effort**: MEDIUM

### Problem

Audio is base64-encoded into JSON text frames, adding 33% size overhead and encode/decode CPU time.

### Proposal

Send raw PCM as binary WebSocket frames. Use a preceding JSON message with metadata (requestId, encoding, sampleRate), then send binary frames until an `response_audio_end` JSON message.

### Files

- `src/adapters/glasses/responder.ts` — send binary instead of JSON
- `src/adapters/glasses/protocol.ts` — document binary frame semantics
- Android app: `ClaudewayWebSocket.kt` — handle binary frames
- Test UI: `index.html` — handle binary frames

### Trade-offs

- Protocol becomes mixed text/binary — harder to debug (can't just log JSON)
- All clients must be updated simultaneously
- Savings (~20ms per chunk on typical networks) may not justify the complexity

## Optimization 6: Opus/WebM Encoding

**Impact**: MEDIUM (on bandwidth) | **Effort**: HIGH

### Problem

Uncompressed PCM is large. Opus at 16kbps would be ~6x smaller than 24kHz PCM.

### Proposal

Use Opus encoding for audio transmission. Deepgram supports `opus` as an output encoding option.

### Trade-offs

- Deepgram WebSocket TTS may not support Opus output (needs verification)
- Client needs Opus decoder (Android: built-in; Browser: via Web Audio API or library)
- Adds encode/decode latency (typically small, ~5-10ms)
- Complexity of codec management across clients

## Prerequisite

Implement [Voice Latency Benchmarking](2026-03-22-voice-latency-benchmarking.md) first to establish a baseline before applying any optimization.

## Priority Ranking

| # | Optimization | Impact | Effort | Recommended |
|---|---|---|---|---|
| 1 | ProseChunker max-age timeout | HIGH | LOW | Yes, implement first |
| 2 | TTS WebSocket preconnect | MEDIUM | LOW | Yes, easy win |
| 3 | Reduce flush thresholds | MEDIUM | LOW | Yes, tune values |
| 4 | Lower sample rate (16kHz) | LOW-MEDIUM | LOW | Yes, config change |
| 5 | Binary WebSocket frames | LOW | MEDIUM | Later, if needed |
| 6 | Opus encoding | MEDIUM | HIGH | Later, if needed |

**Approach**: Apply optimizations 1-4 one at a time, measuring after each to validate the improvement. This avoids adding complexity for unverified gains.

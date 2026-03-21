# Meta Ray-Ban Glasses Voice Channel

**Date**: 2026-03-16
**Status**: Draft
**Author**: Claude + Petro

## Overview

Add a voice-driven channel to Claudeway using Meta Ray-Ban smart glasses. Users speak to Claude through the glasses and hear responses through the glasses speaker. This requires: (1) modularizing the existing Slack-coupled codebase into a channel-agnostic core, (2) building a voice pipeline (STT/TTS), (3) a WebSocket server adapter, and (4) an Android companion app using Meta's DAT SDK.

**Voice model (MVP)**: Push-to-talk with post-stop transcription. The user taps to start, speaks, and releases/stops. Audio is buffered and transcribed after `audio_end`. This is not real-time streaming STT — it's a simpler, more reliable model for MVP. Streaming STT (transcribe while speaking) is Phase 5, after the batch path is proven end-to-end.

## E2E User Journey (MVP)

1. User puts on Ray-Ban Meta glasses; they auto-connect to the companion Android app via Bluetooth
2. User **taps the touchpad** to activate listening
3. User speaks: *"What's the status of the queue refactor in claudeway?"*
4. Glasses mic streams **8kHz mono audio** over Bluetooth HFP to companion app
5. Companion app streams audio over **WebSocket** to Claudeway server
6. Server runs **STT** (Deepgram Nova-3) to transcribe speech to text
7. Text enters the core pipeline: queue -> config/permissions -> `claude -p` -> response
8. Claude response text -> **TTS** (Deepgram Aura-2) -> audio stream
9. Audio streams back over WebSocket to companion app -> glasses speaker
10. User hears Claude's response through the glasses

## Architecture

### Design Principles

- **Voice is a core capability, not adapter-specific** -- the STT/TTS pipeline lives in `src/core/` so any future adapter (web chat, phone app) can use it
- **Adapters are thin transport layers** -- they handle connection lifecycle and message framing, then delegate to the core engine
- **Existing Slack behavior is unchanged** -- modularization is a pure refactor with no behavior changes
- **1 channel = 1 repo** -- each configured glasses channel maps to a repo/folder, same as Slack channels

### Module Structure (Post-Refactor)

```
src/
  core/
    engine.ts           # processQueuedMessage, drainChannel, concurrency pool
    interfaces.ts       # ChannelAdapter, ChannelResponder, IStreamingResponder
    voice.ts            # STT/TTS pipeline (provider-agnostic interface)
    voice-deepgram.ts   # Deepgram Nova-3 (STT) + Aura-2 (TTS) implementation
  adapters/
    slack/
      index.ts          # Slack Bolt app setup, entrypoint
      handler.ts        # registerMessageHandler, message filtering
      responder.ts      # StreamingResponder, NativeStreamingResponder, sendResponse
      formatting.ts     # markdownToSlackMrkdwn, splitMessage
      thread.ts         # fetchThreadContext, resolveUserName (Slack impl)
      commands.ts       # Magic commands (!ps, !kill, etc.)
      utils.ts          # safeReact, warnInThread
      files.ts          # downloadSlackFiles, uploadAttachedFiles
    glasses/
      index.ts          # WebSocket server setup, entrypoint
      handler.ts        # WS message routing, session management
      responder.ts      # WS-based ChannelResponder (text + audio streaming)
      protocol.ts       # WS message types/protocol definition
      test-ui/          # Simple HTML/JS page for local browser testing
  # Unchanged, already generic:
  queue.ts
  claude.ts
  config.ts
  mcp.ts
  prompt.ts             # Minor: remove Slack-specific string from formatUserDirectory
  sync-repos.ts
  tempdir.ts            # Minor: extract uploadAttachedFiles to adapter

android/                # Companion app (Kotlin/Gradle)
  app/src/main/
    kotlin/.../
      MainActivity.kt
      glasses/           # DAT SDK connection, device management
      audio/             # Bluetooth HFP mic/speaker routing
      network/           # WebSocket client to Claudeway server
      ui/                # Minimal UI (connection status, transcript)
```

### Core Interfaces

Defined in `src/core/interfaces.ts` and `src/core/voice.ts`. Key types: `ChannelResponder` (adapter response delivery), `IStreamingResponder` (streaming text/tool events), `VoiceProvider` (STT/TTS pipeline), `AudioFormat`.

### WebSocket Protocol

The glasses adapter exposes a WebSocket server. Messages are JSON-framed:

Every request/response exchange is correlated by a `requestId` (UUID, client-generated). This enables cancellation, concurrent requests, and unambiguous response routing. A `requestId` must be unique across all in-flight state within a session — the server rejects a `requestId` that is already pending (queued text) or recording (active audio).

```typescript
// Client -> Server
{ type: 'audio_start', requestId: string, format: AudioFormat }
{ type: 'audio_chunk', requestId: string, data: '<base64 PCM>' }
{ type: 'audio_end', requestId: string }
{ type: 'text', requestId: string, text: 'direct text input' }
{ type: 'cancel', requestId: string }       // Cancel an in-flight request (see cancellation semantics below)
{ type: 'ping' }

// Server -> Client
{ type: 'status', requestId: string, status: 'transcribing' | 'thinking' | 'speaking' }
{ type: 'transcript', requestId: string, text: 'what user said', final: boolean }
{ type: 'response_text', requestId: string, text: 'claude response chunk', final: boolean }
{ type: 'response_audio', requestId: string, data: '<base64 PCM>' }
{ type: 'response_audio_end', requestId: string }
{ type: 'error', requestId: string | null, message: '...' }  // null requestId = connection-level error
{ type: 'pong' }
```

**Cancellation semantics**: A `cancel` message applies to a specific `requestId`. The server's behavior depends on the current state of that request:

- **Queued** (not yet processing): removed from queue, server sends `error` with message `"cancelled"`.
- **Transcribing** (STT in progress): STT request is aborted, partial transcript discarded, server sends `error` with `"cancelled"`.
- **Thinking** (Claude processing): Claude CLI process is killed (`SIGTERM`), server sends `error` with `"cancelled"`.
- **Speaking** (TTS streaming): TTS generation is aborted, no further `response_audio` chunks sent, server sends `response_audio_end` followed by `error` with `"cancelled"`.
- **Unknown requestId** or already completed: server ignores the `cancel` silently (no error).

### Config Extension

```yaml
# config.yaml additions
glassesServer:
  enabled: true
  port: 8765
  # Auth model: each token maps to a userId + default channel.
  # The userId is resolved against channel allowedUsers for permissions,
  # exactly like Slack userId resolution.
  auth:
    tokens:
      - token: '${GLASSES_AUTH_TOKEN}'
        userId: glasses-petro           # Used for permission resolution
        defaultChannel: glasses-default  # Channel to use when client doesn't specify

voice:
  provider: deepgram
  deepgram:
    apiKey: '${DEEPGRAM_API_KEY}'
    sttModel: nova-3
    ttsModel: aura-2
    ttsVoice: asteria

# Glasses channels work the same as Slack channels
channels:
  glasses-default:            # Not a Slack channel ID, just an identifier
    name: my-glasses
    repo: claudeway
    allowedUsers:
      - 'glasses-petro'    # Must match the userId from glassesServer.auth.tokens
    model: opus
```

### Voice Pipeline Detail

```mermaid
sequenceDiagram
    actor User as User (Glasses)
    participant App as Android Companion
    participant WS as WS Server (Glasses Adapter)
    participant STT as STT: Deepgram Nova-3 (core/voice)
    participant Engine as Core Engine (claude -p)
    participant TTS as TTS: Deepgram Aura-2 (core/voice)

    User->>App: Tap touchpad to activate
    activate App
    App->>WS: audio_start {8kHz mono PCM}
    activate WS

    loop Voice streaming
        User-)App: BT HFP audio
        App-)WS: audio_chunk (WebSocket)
    end

    User->>App: Release / silence detected
    App->>WS: audio_end

    WS->>STT: Audio buffer
    activate STT
    STT-->>WS: transcript (text)
    deactivate STT

    WS->>Engine: Queued text message
    activate Engine
    Note right of Engine: queue → config/permissions → claude -p

    loop Streaming response
        Engine-)WS: response text chunk
        WS-)TTS: Sentence buffer
        activate TTS
        TTS-)WS: audio chunk
        deactivate TTS
        WS-)App: response_audio (WebSocket)
        App-)User: BT HFP audio (speaker)
    end

    Engine-->>WS: response complete
    deactivate Engine
    WS-->>App: response_audio_end
    deactivate WS
    deactivate App
```

**Audio resampling**: The glasses mic outputs 8kHz mono (Bluetooth HFP limitation). Deepgram Nova-3 accepts 8kHz natively (no upsample needed -- it handles it). TTS output can be generated at any sample rate; we'll request 8kHz to match the glasses speaker output path, avoiding unnecessary conversion.

## Implementation Phases

### Phase 0: Modularize Core (Server-Side Refactor) [COMPLETE]

**Goal**: Extract reusable core from Slack-coupled code. Slack continues working identically.

Extracted `src/core/engine.ts` (processQueuedMessage, drainChannel, concurrency pool) and `src/core/interfaces.ts` (ChannelResponder, IStreamingResponder) from the Slack-coupled `src/slack.ts`. Moved all Slack-specific code to `src/adapters/slack/`. New top-level `src/index.ts` boots configured adapters. Zero Slack imports in `src/core/`, all existing tests pass.

### Phase 1: WebSocket Server + Text Pipeline [COMPLETE]

**Goal**: A working WebSocket endpoint that accepts text and returns text via Claude.

Built `src/adapters/glasses/` — protocol.ts (message types, parsing), handler.ts (session management, queue key namespacing as `sessionId:requestId`, owner-aware drain), responder.ts (GlassesChannelResponder + GlassesStreamingResponder), index.ts (Bun.serve WS server, token auth). Extended config.ts with `GlassesServerConfig`, `resolveGlassesToken()`, `interpolateEnvVars()`. Added single-file browser test UI. Security: path-traversal-safe test UI, cross-session response routing with `queueKeyToWs` map, fallback to drain initiator on owner disconnect.

### Phase 2: STT Integration (Audio In) [COMPLETE]

**Goal**: Push-to-talk audio input — user speaks, audio is buffered, transcribed after stop, then processed by Claude.

**Status**: Complete. 401 tests pass, typecheck/lint clean.

**What was built**:
- `src/core/voice.ts` -- `VoiceProvider` interface, `AudioFormat` type
- `src/core/voice-deepgram.ts` -- Deepgram Nova-3 batch STT via `@deepgram/sdk` prerecorded API (TTS deferred to Phase 3)
- `src/adapters/glasses/audio-session.ts` -- `AudioRecording`, `createRecording()`, `appendChunk()`, `assembleBuffer()`, `MAX_AUDIO_BYTES` (120s ceiling ~3.84MB)
- `src/adapters/glasses/handler.ts` -- audio_start/chunk/end routing, async `handleAudioEnd()`, `enqueueText()` shared by text and audio paths, duplicate requestId rejection across all in-flight state
- `src/adapters/glasses/index.ts` -- voice config validation at startup (fails if glasses enabled without voice config), DeepgramVoiceProvider singleton
- `src/config.ts` -- `VoiceConfig` interface, validation of voice section
- Test UI updated with push-to-talk via `MediaRecorder` (WebM/Opus)

**Key design decisions**:
- **Batch STT, not streaming**: Audio chunks buffered until `audio_end`, then one HTTP call to Deepgram. Streaming STT is Phase 5.
- **Shared conversation context**: All requests in a WS session share `threadTs` = `sessionId`, so Claude sees prior history. Queue keys (`ts`) remain unique per-request for routing/cancel.
- **Cancellation scope**: Queue-only + active recordings. Full barge-in (abort during transcription/thinking/speaking) requires engine-level abort plumbing — prerequisite for Phase 3.
- **Dual audio format**: Browser test path sends WebM/Opus, glasses device sends raw PCM. `format` in `audio_start` declares encoding; Deepgram handles both natively.

**Tests**: 4 test files covering audio session, Deepgram STT, handler audio flow, protocol parsing. Edge cases: late chunks after audio_end, double audio_end, session close during async transcription, overlapping recordings, size limit enforcement.

### Phase 3: TTS Integration (Audio Out)

**Goal**: Full voice loop -- audio in, audio out.

**Changes**:

1. Add TTS to `src/core/voice-deepgram.ts` -- Deepgram Aura-2 streaming synthesis
2. Update glasses responder: after Claude responds, stream TTS audio back over WS
3. Update test UI: add audio playback (Web Audio API), play response audio chunks as they arrive
4. Add `response_audio` / `response_audio_end` WS message handling
5. Handle interruption: client sends `cancel` with the in-flight `requestId` before starting a new request. Server handles cancellation per the state-dependent semantics defined in the WebSocket Protocol section (queued, transcribing, thinking, or speaking).

**Tests**:
- `src/__tests__/voice-deepgram.test.ts` -- extend with TTS tests (mocked HTTP):
  - TTS: sends correct text and voice config to Deepgram API
  - TTS: `synthesizeStream()` yields audio chunks as they arrive
  - TTS: handles Deepgram API errors gracefully
- `src/__tests__/voice-tts-buffer.test.ts` -- sentence buffering logic:
  - Buffers text until sentence boundary (`.`, `?`, `!`)
  - Flushes partial buffer on stream end
  - Handles edge cases: ellipsis (`...`), abbreviations (`e.g.`), code blocks
- `src/__tests__/glasses-handler-voice.test.ts` -- full voice round-trip (mocked STT + TTS + Claude):
  - Audio in → `status: transcribing` → `transcript` → `status: thinking` → `response_text` → `response_audio` → `response_audio_end`
  - Interruption: `cancel` message stops in-progress TTS and Claude for that `requestId`
  - Concurrent requests from same client are serialized
- Manual: browser test UI with mic + speaker for full voice loop

**Streaming TTS approach**:
- Claude responses arrive as text (potentially streaming via `onTextDelta`)
- Buffer text to sentence boundaries (period, question mark, exclamation)
- Send each sentence to TTS immediately (sentence-level streaming)
- Stream audio chunks back to client as they're generated
- This gives ~1-2 second latency from Claude's first sentence to audio playback start

### Phase 4: Android Companion App

**Goal**: End-to-end with actual Meta Ray-Ban glasses.

**Structure**:
```
android/
  app/
    build.gradle.kts
    src/main/
      AndroidManifest.xml
      kotlin/com/claudeway/glasses/
        ClaudewayApp.kt          # Application class, DAT SDK init
        MainActivity.kt           # Single-activity app
        glasses/
          GlassesViewModel.kt     # DAT SDK device connection state
          GlassesManager.kt       # Device discovery, registration, permissions
        audio/
          AudioRouter.kt          # Bluetooth HFP routing (mic + speaker)
          AudioRecorder.kt        # PCM capture from glasses mic
          AudioPlayer.kt          # PCM playback to glasses speaker
        network/
          ClaudewayWebSocket.kt   # WS client (OkHttp or Ktor)
          Protocol.kt             # Message types matching server protocol
        ui/
          ConnectionScreen.kt     # Jetpack Compose: server URL, connection status
          ConversationScreen.kt   # Transcript display, manual text input fallback
      res/
        ...
  build.gradle.kts
  settings.gradle.kts
  gradle/
    libs.versions.toml            # DAT SDK, OkHttp, Compose versions
```

**Key implementation details**:

1. **DAT SDK setup**: `Wearables.initialize()` in `Application.onCreate()`, registration flow via Meta AI companion app
2. **Audio routing**: Standard Android `AudioManager.setCommunicationDevice()` to route to Bluetooth SCO device. Must configure HFP **before** any DAT camera sessions.
3. **Audio capture**: `AudioRecord` with Bluetooth SCO source, 8kHz mono PCM Int16
4. **Audio playback**: `AudioTrack` routed to Bluetooth SCO device, matching format from TTS
5. **WebSocket**: OkHttp's WS client, auto-reconnect, auth via bearer token
6. **Activation**: Touchpad tap detected via DAT SDK gesture events, or a simple "hold to talk" UI button as fallback

**DAT SDK requirements**:
- Android 10+ (API 29+)
- Meta AI companion app installed on phone
- Developer Mode enabled in Meta AI app settings
- GitHub token for pulling SDK from GitHub Packages
- Supported: Ray-Ban Meta Gen 1 & Gen 2

**Tests (Android, JUnit + MockK)**:
- `ClaudewayWebSocketTest` -- WebSocket client:
  - Connects with auth token, receives `pong` on `ping`
  - Reconnects automatically on connection drop
  - Serializes/deserializes protocol messages correctly
- `AudioRouterTest` -- Bluetooth HFP routing:
  - Finds SCO device from `AudioManager.availableCommunicationDevices`
  - Sets communication device correctly
  - Handles missing SCO device (no glasses connected) gracefully
- `AudioRecorderTest` -- PCM capture:
  - Produces 8kHz mono Int16 PCM buffers
  - Stops cleanly on release
- `ProtocolTest` -- shared protocol types:
  - Kotlin message types match TypeScript protocol definition (snapshot test against JSON fixtures)
- **Integration** (requires DAT MockDeviceKit, no physical glasses):
  - `GlassesManagerTest` -- device discovery and registration flow using `MockDeviceKit`
  - Full pipeline mock: simulated touchpad event → audio capture → WS send → mock server response → audio playback
- **Manual E2E**: put on glasses, tap touchpad, speak, hear response

### Phase 5: Streaming STT

**Goal**: Replace batch transcription with real-time streaming STT for lower perceived latency. Partial transcripts appear while the user is still speaking.

**Prerequisite**: Phases 0–4 complete and stable. Batch voice path working end-to-end with glasses hardware.

**Changes**:

1. Add `transcribeStream()` implementation in `src/core/voice-deepgram.ts` using Deepgram's real-time WebSocket API
2. Update glasses handler: on `audio_start`, open a streaming STT session; forward `audio_chunk` directly to Deepgram WS instead of buffering
3. Emit `transcript` messages with `final: false` as partial results arrive, `final: true` on utterance end
4. On `audio_end`, close the Deepgram STT stream and wait for the final transcript before passing to Claude
5. Update `cancel` handling: cancellation during streaming transcription closes the Deepgram WS session
6. Add config flag `voice.sttMode: 'batch' | 'streaming'` (default: `batch`) — batch remains the fallback until streaming is proven stable

**Tests**:
- `src/__tests__/voice-deepgram-streaming.test.ts` -- streaming STT (mocked Deepgram WS):
  - Opens Deepgram WS with correct model/format params
  - Forwards audio chunks as they arrive
  - Emits partial transcripts from Deepgram interim results
  - Emits final transcript on utterance_end
  - Handles Deepgram WS disconnect/reconnect gracefully
- `src/__tests__/glasses-handler-streaming-stt.test.ts` -- integration with glasses handler:
  - Partial `transcript` messages sent to client during recording
  - Final transcript triggers Claude processing (same as batch path)
  - `cancel` during streaming STT closes Deepgram session cleanly
  - Fallback: if `sttMode: 'batch'`, handler uses existing buffer-then-transcribe path
- Latency benchmark: first partial transcript appears within 500ms of first `audio_chunk`
- No regression: batch path tests still pass, text-only path unaffected

**Exit criteria**:
- First partial transcript within defined latency target (~500ms)
- Final transcript quality matches or improves on batch path
- Cancel works during recording, transcribing, and speaking
- No regression to text-only or batch voice path
- Batch remains default in config until streaming passes soak testing

**Design constraint**: Streaming STT adds a persistent WebSocket connection to Deepgram per active recording session. This is fine for single-user MVP but would need connection pooling for multi-user. The `VoiceProvider` interface already has the `transcribeStream()` method stubbed — this phase implements it.

## Key Technical Decisions

### Why Deepgram (Single Provider for STT + TTS)?

| Criteria | Deepgram | Groq | OpenAI |
|----------|----------|------|--------|
| STT streaming | Yes (real-time WS) | No (batch only) | No |
| TTS streaming | Yes | No | Yes |
| STT quality | Nova-3 (excellent) | Whisper v3 (excellent) | Whisper (good) |
| TTS quality | Aura-2 (good) | Orpheus (good, 200 char limit) | TTS-1-HD (very good) |
| Latency | Very low | Very low (STT), unknown (TTS) | Moderate |
| Single provider | Yes (both) | No (TTS too limited) | Yes (both, but no streaming STT) |

Deepgram wins on streaming support for both directions. The `VoiceProvider` interface makes it swappable.

### Why Kotlin Native (Not Cross-Platform)?

The DAT SDK is a native Android library using Kotlin coroutines and `StateFlow`. Cross-platform frameworks (React Native, Flutter) would require building a native bridge module that wraps every SDK call -- adding complexity without benefit since:
- The companion app is thin (transport + audio routing only)
- iPad support would use a separate Swift thin client connecting to the same WebSocket server
- The DAT SDK has no iOS equivalent API surface (iOS uses Swift's MWDATCore framework)

### Why WebSocket (Not HTTP)?

Real-time bidirectional audio streaming requires persistent connections. HTTP would add per-request overhead and can't push audio chunks server->client without polling. WebSocket provides:
- Low-latency bidirectional framing
- Natural fit for audio chunk streaming
- Connection state management (know when client disconnects)
- Compatible with Bun's native WebSocket support

### Monorepo Layout

Server (TypeScript/Bun) and Android app (Kotlin/Gradle) in one repo:
- Shared `config.yaml` (server reads it, Android app just needs WS URL from it)
- Atomic cross-stack changes (protocol changes update both sides in one commit)
- Single CI pipeline
- `docker-compose.yml` only builds/runs the server; Android builds separately via Gradle

## Security Considerations

- **Auth**: Bearer token in WS handshake (`Sec-WebSocket-Protocol` header or query param). Token maps to a `userId` + `defaultChannel` via `glassesServer.auth.tokens` config. Auth flow: bearer token -> lookup in config -> resolve `userId` -> use `userId` with `resolveUserPermissions()` against channel's `allowedUsers`. Single-user tool, so a shared secret suffices for MVP.
- **Network**: WS server binds to `localhost` by default. For remote access (glasses on different network), use a reverse proxy with TLS or a tunnel (e.g., Tailscale).
- **Permissions**: Glasses channels use the same `resolveUserPermissions` as Slack. The `userId` from the token mapping resolves against the channel's `allowedUsers` list, exactly like Slack user IDs.
- **Voice data**: Audio is processed in-memory, streamed to Deepgram, not persisted to disk. Transcripts flow through the normal queue (file-based, same as Slack messages).

## Out of Scope (Future)

- Camera/photo input (Phase 6+)
- iPad/iOS companion app
- Multi-user glasses support
- Custom voice triggers (replacing "Hey Meta")
- Conversation history display on glasses HUD (Ray-Ban Display only)
- Wake word detection (server-side)
- Offline/edge STT

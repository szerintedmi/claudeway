# Audio Feedback Design for Glasses Voice Channel

## Context

The full round-trip of a voice interaction (press mic -> STT -> Claude thinking -> TTS -> playback) can take several seconds. When the user isn't looking at the phone screen, there's no feedback that anything is happening. This spec adds subtle audio cues at each stage transition so the user knows the system is alive and progressing.

## Interaction Phases & Audio Cues

| Phase | Trigger | Sound Design | Duration |
|-------|---------|-------------|----------|
| **1. Listening started** | User presses mic button | Short rising tone (like a soft "boop") — confirms mic is active | ~150ms |
| **2. Input captured** | User releases mic button | Short descending tone (like a soft "doop") — confirms recording stopped | ~150ms |
| **3. Transcribing** | Server sends `status: "transcribing"` | Single subtle tick — brief phase, usually <1s | ~100ms |
| **4. Thinking heartbeat** | Server sends `status: "thinking"`, repeats every ~2s | Gentle periodic ping — soft, non-intrusive, like a sonar blip | ~80ms each |
| **5. Generating speech** | First `response_text` arrives (text ready, TTS working) | Heartbeat changes character — slightly warmer/higher tone, same rhythm | ~80ms each |
| **6. Speaking** | First `response_audio` chunk arrives | Heartbeat stops, TTS audio plays naturally | N/A |

### Design Rationale

- **Phases 1 & 2** are purely client-side — no server round-trip needed, instant feedback
- **Phase 3** (transcribing) is usually very fast (<1s), so just a single tick rather than a repeating heartbeat
- **Phase 4 vs 5** distinction matters: during "thinking" you don't know if Claude is stuck or working; once text arrives you know audio is coming soon. A subtle tone change communicates "almost there"
- **Phase 6** — the response audio itself is the feedback, so heartbeat stops cleanly

### Sound Characteristics

All cues should be:
- **Very subtle** — quiet relative to TTS speech volume (~30-40% of speech volume)
- **Short** — under 200ms for one-shots, ~80ms for heartbeat pings
- **Non-speech** — pure tones or simple synth to avoid confusion with TTS output
- **Pleasant frequency range** — 800-1200Hz base, avoiding harsh high frequencies

Suggested tone palette:
- **Listening start**: 800Hz -> 1000Hz sine sweep, 150ms, gentle attack/decay
- **Input captured**: 1000Hz -> 800Hz sine sweep, 150ms
- **Transcribing tick**: 1000Hz sine, 100ms, quick decay
- **Thinking ping**: 900Hz sine, 80ms, soft envelope, every 2 seconds
- **Generating ping**: 1100Hz sine, 80ms, soft envelope, every 2 seconds (same rhythm, different pitch)

## Implementation Approach

### Client-side (Android) — all feedback sounds generated locally

This is the right place because:
1. Zero latency for press/release cues (phases 1 & 2)
2. Server already sends the status messages needed for phases 3-5
3. No protocol changes needed — the client reacts to existing messages
4. Works even with poor network (press/release cues still play)

### Key Files to Modify

- **`android/app/src/main/kotlin/com/claudeway/glasses/audio/`**
  - New: `FeedbackToneGenerator.kt` — generates all cue tones using Android's `AudioTrack` (procedural sine wave synthesis, no asset files needed)

- **`android/app/src/main/kotlin/com/claudeway/glasses/glasses/GlassesViewModel.kt`**
  - `startRecording()` — play "listening started" tone before starting capture
  - `stopRecording()` — play "input captured" tone
  - Status message handler — start/stop heartbeat based on `voiceFlowState` transitions
  - `response_audio` handler — stop heartbeat when TTS audio arrives

### FeedbackToneGenerator Design

```kotlin
class FeedbackToneGenerator {
    // One-shot cues
    fun playListeningStart()      // rising tone
    fun playInputCaptured()       // descending tone
    fun playTranscribingTick()    // single tick

    // Heartbeat (auto-repeating)
    fun startThinkingHeartbeat()  // 2s interval, 900Hz pings
    fun switchToGeneratingHeartbeat() // same interval, 1100Hz pings
    fun stopHeartbeat()           // stops any active heartbeat

    // Volume control
    fun setVolume(fraction: Float) // relative to system volume
}
```

Implementation notes:
- Use `AudioTrack` in static mode for one-shots (pre-generated short PCM buffers)
- Use a coroutine with `delay(2000)` loop for heartbeat
- Generate tones procedurally: `sin(2 * PI * freq * t / sampleRate)` with envelope
- Apply raised-cosine envelope for smooth attack/decay (avoids clicks)
- Sample rate: 44100Hz (standard, works on all devices)
- Use `USAGE_ASSISTANCE_SONIFICATION` audio attributes so it mixes properly with voice

### State Machine Integration

```
Idle ──press──> Recording (play listeningStart)
Recording ──release──> Transcribing (play inputCaptured)
Transcribing ──status:transcribing──> (play transcribingTick)
Transcribing ──status:thinking──> Thinking (start thinkingHeartbeat)
Thinking ──response_text──> Generating (switch to generatingHeartbeat)
Generating ──response_audio──> Speaking (stop heartbeat, play TTS)
Speaking ──audio_end──> Idle (silence)
Any ──cancel/error──> Idle (stop heartbeat)
```

Note: The existing `VoiceFlowState` enum may need a new `Generating` state (currently goes directly from `Thinking` to `Speaking`), or we can track the text-received-but-no-audio-yet condition internally in the tone generator without adding a new UI state.

### Browser Test UI

Optionally add matching feedback to `test-ui/index.html` using Web Audio API `OscillatorNode` — same frequencies and timing, but lower priority since the test UI has visual feedback.

## Verification

1. **Unit test**: `FeedbackToneGenerator` generates valid PCM buffers of expected length
2. **Manual test on device**:
   - Press mic -> hear rising tone
   - Release mic -> hear descending tone
   - During thinking -> hear periodic pings
   - When text starts streaming -> ping character changes
   - When audio plays -> pings stop cleanly, no overlap
3. **Edge cases**:
   - Barge-in (new request while speaking) -> heartbeat stops, new listening tone plays
   - Cancel during thinking -> heartbeat stops immediately
   - Very fast response (thinking < 2s) -> only 0-1 pings before audio, which is fine
   - Network error -> heartbeat stops on error state
4. **Volume**: Feedback tones should be clearly audible but not startling, especially over Bluetooth SCO

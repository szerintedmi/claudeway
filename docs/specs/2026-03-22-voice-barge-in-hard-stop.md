# Voice Barge-In vs Hard Stop

**Date**: 2026-03-22
**Status**: Draft

## Overview

Change voice interruption semantics from a single hard-cancel path to two distinct intents:

1. **Soft barge-in**: the user speaks over the assistant to interrupt playback and continue the conversation naturally
2. **Hard stop**: the user explicitly stops the current turn and any in-flight Claude/tool/agent work

Today, the Android client sends `cancel` whenever the user barges in, and the server kills the active Claude CLI process with `SIGTERM`. This is reliable but too aggressive as the default: speaking over output should usually mean "stop talking, I want to say something," not "tear down the current Claude run immediately."

This spec makes soft barge-in the default voice behavior while preserving an explicit hard stop for dangerous or unwanted tool/agent work.

## Goals

- Make voice interaction feel conversational: speaking over playback should usually interrupt audio, not kill Claude
- Preserve a reliable escape hatch when Claude is doing the wrong thing
- Support both screenful and screenless usage:
  - Android phone UI
  - browser/web voice UI
  - glasses / hands-free voice-only usage
- Keep the current request-state model simple enough to implement on top of the existing WebSocket protocol and voice handler

## Non-Goals

- Full duplex "live conversation" where Claude consumes new user speech during the same turn without any queueing
- Fine-grained cancellation of a specific sub-agent while keeping the parent Claude turn alive
- Undoing external tool side effects after a hard stop

## Problem

The current behavior conflates these user intents:

- "Stop speaking so I can say something"
- "Stop this turn completely"
- "Abort the tool/agent because it is doing the wrong thing"

That creates avoidable downsides:

- ordinary interruption kills useful in-flight reasoning
- hard process termination becomes too easy to trigger by accident
- side-effectful tool runs are not clearly separated from harmless speech interruption

## Proposed Interaction Model

### Two interruption types

#### 1. Soft barge-in

Soft barge-in means:

- stop local playback immediately
- stop rendering the active speaking indicator
- preserve the current session/thread context
- accept new user speech as the next queued turn
- do **not** kill the active Claude process by default

The user experience should feel like:

1. Claude is speaking
2. User starts talking
3. Audio output stops immediately
4. User speaks their next utterance
5. That utterance becomes the next turn in the same session

#### 2. Hard stop

Hard stop means:

- stop local playback immediately
- send explicit `cancel` for the active `requestId`
- abort STT if still transcribing
- remove queued request if not yet processing
- cancel TTS generation
- kill the active Claude CLI process if it is processing

This is the current cancellation behavior and remains the correct behavior for an explicit stop action.

## Intent Detection

### Default rule

If the user speaks while the assistant is speaking, interpret that as **soft barge-in**, not hard stop.

### Voice-only hard stop

For screenless usage, hard stop is identified by a narrow set of explicit spoken commands with high confidence.

Accepted hard-stop phrases:

- `stop`
- `cancel`
- `stop that`
- `cancel that`
- `never mind`
- `claude, stop`
- `claude, cancel`

### Hard-stop phrase guardrails

A spoken transcript is treated as hard stop only if all of these are true:

- there is an active request in `thinking`, `tool`, `agent`, or `speaking`
- the transcript is short: 1 to 3 words after normalization, except the prefixed forms above
- the normalized transcript exactly matches an allowed hard-stop phrase
- there is no additional semantic content before or after the phrase
- STT confidence is high enough, if the provider exposes confidence

Examples:

- `stop` -> hard stop
- `claude stop` -> hard stop
- `stop that` -> hard stop
- `stop and open the file` -> **not** hard stop
- `wait what did you say` -> **not** hard stop

### Ambiguous phrases

Do not use these as hard stop commands by default:

- `wait`
- `hold on`
- `no`

They are too common in normal speech and create false positives.

## State-Based Policy

### Speaking only

When Claude is only speaking and no tool/agent activity is in progress:

- spoken overlap -> soft barge-in
- stop button -> hard stop
- spoken hard-stop phrase -> hard stop

### Thinking, no active tool yet

When Claude is thinking but no tool/agent event has started:

- typed/text input from UI -> enqueue as next turn
- spoken overlap or fresh push-to-talk utterance -> enqueue as next turn
- explicit stop button or hard-stop phrase -> hard stop

Implementation note: if the underlying Claude CLI path cannot safely append a new user message mid-turn, the server may let the current turn complete and queue the next message behind it. The key UX rule is that this must not kill the process unless the user explicitly asked to stop.

### Tool or sub-agent active

When a tool or agent is active:

- explicit stop button -> hard stop immediately
- spoken hard-stop phrase -> hard stop immediately
- ordinary spoken overlap -> by default, soft barge-in of audio only, but the new utterance should not be assumed to cancel tool work

This distinction matters because tool/agent phases may have side effects. The system must not imply that merely talking over Claude has safely stopped the tool run.

## UI Changes

### Android app

Add a dedicated **Stop** button for hard stop in the conversation UI.

Requirements:

- visible whenever there is an active request in `thinking`, `speaking`, `transcribing`, or `recording`
- visually distinct from the mic affordance
- triggers hard stop, not soft barge-in
- label should be explicit: `Stop`
- icon-only close affordance is not sufficient for the primary hard-stop control

Behavior:

- tap `Stop` -> send `cancel` for the active `requestId`
- if audio is playing, stop playback immediately
- UI transitions to idle when `cancelled` terminal event is received

The existing inline cancel/close affordances in the Android conversation screen should be replaced or backed by a clearly labeled stop action so the semantics are obvious.

### Web voice UI

Add a dedicated **Stop** button for hard stop in both:

- the current browser test voice UI
- the Next.js replacement UI, if/when it is the primary voice UI

Requirements:

- visible whenever there is an active request
- explicit text label: `Stop`
- triggers the same hard-stop behavior as Android

## Protocol / Client Semantics

### Keep existing `cancel`

The existing WebSocket message remains the hard-stop primitive:

```typescript
{ type: 'cancel', requestId: string }
```

No change to server-side cancellation semantics for `cancel`.

### Add client-side soft-barge-in behavior

Soft barge-in is initially a client behavior, not a new server message:

- client stops local playback immediately
- client captures new user speech/text
- client submits that as a normal new request
- client does not send `cancel` automatically

This avoids protocol churn for the first phase.

### Optional future protocol extension

If needed later, add an explicit non-terminal message such as:

```typescript
{ type: 'interrupt_output', requestId: string }
```

That would allow the server to distinguish:

- stop speaking audio
- keep current Claude turn alive

This is not required for the initial rollout.

## Server Behavior

### Hard stop

No change from current behavior:

- queued -> dequeue
- transcribing -> abort STT
- thinking/tool/agent -> kill Claude process
- speaking -> stop TTS stream and terminate active work

### Soft barge-in

For the initial implementation:

- the server is not asked to cancel anything
- the current request continues running
- the new user utterance is enqueued as a new request in the same session

This means the new message may wait behind the current turn if the engine is still busy. That is acceptable for the first version as long as the system does not incorrectly present ordinary overlap as a cancellation.

## Session / History Semantics

- Partial assistant text already received should remain in chat history if the user hard-stops after text has started streaming
- Soft barge-in should not clear or discard the current turn's partial text
- If the current turn later completes after a soft barge-in, its final text should still be preserved in history
- The next user turn should remain in the same session/thread so Claude retains context

## Audio / UX Semantics

### Soft barge-in

- stop playback immediately
- remove active speaking indicator
- optionally play a short local cue indicating that the assistant has yielded the floor

### Hard stop

- stop playback immediately
- stop heartbeat/activity cues
- show `Stopping...` until the terminal `cancelled` state is received

## Edge Cases

### Tool side effects already in progress

Hard stop cannot undo external side effects that already happened. The UI and documentation should not imply rollback.

### False-positive voice stop

A false-positive hard stop is worse than a false-negative one. The phrase matcher must be conservative.

### Multiple quick interruptions

If the user repeatedly talks over playback:

- each overlap should stop local playback immediately
- only explicit hard-stop intent should send `cancel`
- clients should avoid creating duplicate queued turns from partial/noisy STT fragments

### Voice-only usage with no screen

Because glasses users may not have a stop button available, spoken hard-stop phrases must work even when the phone UI is not visible.

## Implementation Plan

### Phase 1: Spec and UI clarity

- document soft vs hard interruption semantics
- add explicit `Stop` button to Android conversation UI
- add explicit `Stop` button to web voice UI
- rename any ambiguous close/cancel affordances in voice surfaces to `Stop`

### Phase 2: Soft barge-in on speaking

- change Android voice interruption during `speaking` to stop playback locally without auto-sending `cancel`
- allow next utterance to be submitted as a fresh request
- keep hard stop wired to explicit `Stop`

### Phase 3: Voice-only hard-stop phrase detection

- add normalized spoken phrase matcher on final transcript
- only issue hard stop when the transcript exactly matches an approved stop phrase
- otherwise treat transcript as a normal next-turn utterance

### Phase 4: Optional smarter server support

- evaluate whether a protocol-level `interrupt_output` message is needed
- evaluate whether Claude CLI can safely accept appended user messages mid-turn in the chosen integration mode

## Verification

1. While Claude is speaking, user starts talking:
   - audio stops immediately
   - no `cancel` is sent
   - next utterance becomes a new turn

2. While Claude is speaking, user taps `Stop`:
   - audio stops immediately
   - `cancel` is sent
   - request ends as `cancelled`

3. While tool/agent activity is active, user says `stop`:
   - hard stop is triggered
   - Claude process is terminated

4. While tool/agent activity is active, user says a non-stop phrase over playback:
   - audio yields locally
   - tool run is not falsely represented as cancelled

5. Android and web both expose a dedicated visible `Stop` action during active requests

## Open Questions

- Can the current Claude CLI integration safely append user turns mid-generation in the modes Claudeway uses today, or must the server queue the next turn until the current one completes?
- Should soft barge-in during active tool/agent work be allowed to enqueue immediately, or should the UI force an explicit choice between `Stop` and `Wait`?
- Should `claude, stop` be preferred over bare `stop` for glasses mode to reduce accidental triggers?

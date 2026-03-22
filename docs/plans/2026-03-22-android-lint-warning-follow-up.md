# Android Lint Warning Follow-up Plan

**Date:** 2026-03-22

**Status:** Draft

## Goal

Address the remaining Android lint warnings with the right level of caution.

The current warning set is down to:

- `targetSdk = 35` not being the latest available target
- dependency update suggestions in the Android version catalog

These are no longer cleanup or structural issues. They are upgrade decisions and should be handled in isolated passes with explicit validation.

## Current warning breakdown

### 1. Target SDK warning

File:

- [android/app/build.gradle.kts](/Users/petro/projects/claudeway/android/app/build.gradle.kts)

Warning:

- `OldTargetApi` because `targetSdk = 35`

This is the only remaining warning with meaningful platform-behavior implications.

### 2. Dependency version warnings

File:

- [android/gradle/libs.versions.toml](/Users/petro/projects/claudeway/android/gradle/libs.versions.toml)

Warnings:

- AndroidX lifecycle `2.9.0 -> 2.10.0`
- Navigation Compose `2.9.0 -> 2.9.7`
- DataStore Preferences `1.1.3 -> 1.2.1`
- Activity Compose `1.10.1 -> 1.13.0`
- Core KTX `1.16.0 -> 1.18.0`
- Kotlin Compose plugin `2.3.0 -> 2.3.20`
- Coroutines `1.10.1 -> 1.10.2`
- OkHttp `5.0.0-alpha.14 -> 5.3.2`
- MockK `1.13.16 -> 1.14.9`
- Turbine `1.2.0 -> 1.2.1`
- Robolectric `4.14.1 -> 4.16.1`
- `org.json` `20240303 -> 20251224`

## Recommended strategy

Do not resolve all remaining warnings in one sweep.

Split them into four passes:

1. Lowest-risk library bumps
2. Grouped AndroidX refresh
3. OkHttp upgrade
4. Target SDK bump

This keeps regressions attributable and makes rollback straightforward.

## Pass 1: Lowest-risk library bumps

### Scope

Update only:

- coroutines `1.10.1 -> 1.10.2`
- turbine `1.2.0 -> 1.2.1`

### Why this pass is first

These are the clearest no-brainer updates in the current set:

- patch-level updates
- limited API surface change risk
- unlikely to affect app behavior materially

### Validation

- `make test`
- Android lint
- quick manual smoke test of connect, text send, and voice send

## Pass 2: Grouped AndroidX refresh

### Scope

Update together:

- lifecycle `2.9.0 -> 2.10.0`
- navigation `2.9.0 -> 2.9.7`
- datastore `1.1.3 -> 1.2.1`
- activity-compose `1.10.1 -> 1.13.0`
- core-ktx `1.16.0 -> 1.18.0`

### Why these should be grouped

These libraries are part of the same Android app stack and interact more closely with Compose, lifecycle collection, navigation, and persistence behavior than the patch-level test/runtime utilities.

Batching them together is reasonable, but they still deserve a dedicated pass rather than being mixed with transport or platform-target changes.

### Areas to watch

- Compose navigation startup and back-stack behavior
- `collectAsState` / lifecycle-driven UI refresh
- activity recreation and resume flows
- persisted settings loading and reconnect bootstrap

### Validation

- `make test`
- Android lint
- Android build
- manual smoke test:
  - first launch to connection screen
  - saved credentials auto-connect
  - retry connection
  - new chat
  - rotate/resume app if practical

## Pass 3: OkHttp upgrade

### Scope

Update:

- OkHttp `5.0.0-alpha.14 -> 5.3.2`

### Why this should be isolated

This is not just a patch bump. The app is currently on an alpha line and the warning suggests a much newer stable line.

That is probably a good move, but this app depends on WebSocket behavior and streaming stability in:

- [ClaudewayWebSocket.kt](/Users/petro/projects/claudeway/android/app/src/main/kotlin/com/claudeway/network/ClaudewayWebSocket.kt)

The correct way to do this is as its own transport-focused change so any regression is easy to spot and revert.

### Areas to watch

- WebSocket connection establishment
- reconnect/disconnect behavior
- message framing and callback ordering
- long-lived voice session stability
- failure handling on network interruption

### Validation

- `make test`
- Android lint
- Android build
- manual smoke test:
  - connect/disconnect
  - text conversation round-trip
  - voice round-trip
  - reconnect after server restart or temporary disconnect

## Pass 4: Target SDK bump

### Scope

Update:

- `targetSdk` `35 -> 36`

### Why this is separate

This is the only remaining warning that can change runtime behavior due to new Android compatibility modes and platform policy enforcement.

This app has elevated risk around:

- Bluetooth permissions
- microphone capture
- audio routing
- resume/reconnect lifecycle

Those areas should be tested intentionally after the bump instead of hiding the change inside a dependency refresh.

### Areas to watch

- Bluetooth permission grant flow
- headset and glasses connection behavior
- audio route switching
- recorder startup and interruption handling
- app background/foreground reconnect behavior

### Validation

- `make test`
- Android lint
- Android build
- manual smoke test on device:
  - first launch and permissions
  - connect and reconnect
  - text send
  - voice recording/send
  - Bluetooth route changes
  - app background and resume during an active session

## Low-priority items

These can wait until they are useful or bundled into a broader maintenance pass:

- MockK `1.13.16 -> 1.14.9`
- Robolectric `4.14.1 -> 4.16.1`
- `org.json` `20240303 -> 20251224`

Reason:

- they are test-only or low-leverage for the current app behavior
- they do not address structural debt
- they are unlikely to unlock anything urgent right now

## Suggested execution order

1. Coroutines + Turbine
2. AndroidX refresh
3. OkHttp
4. targetSdk 36

## Exit criteria

For each pass:

- no new lint errors
- `make test` passes
- Android build passes
- manual smoke test passes for the affected area

Overall:

- remaining lint warnings are either intentionally deferred or eliminated by the completed upgrade pass


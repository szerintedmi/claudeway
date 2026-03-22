# Claudeway — Android Companion App

Connects to a Claudeway WebSocket voice server for voice interaction with Claude. Supports Meta Ray-Ban smart glasses (via DAT SDK) or any Bluetooth headset, or the phone's own mic/speaker.

## Prerequisites

- **JDK 17+**: `brew install openjdk@17`
- **Android SDK**: `brew install --cask android-commandlinetools`, then:
  ```bash
  export ANDROID_HOME=~/Library/Android/sdk
  sdkmanager --sdk_root="$ANDROID_HOME" "platforms;android-36" "build-tools;36.0.0" "platform-tools"
  ```
- **Environment**: Add to `~/.zshrc`:
  ```bash
  export JAVA_HOME=/opt/homebrew/opt/openjdk@17
  export ANDROID_HOME=~/Library/Android/sdk
  export PATH="$JAVA_HOME/bin:$ANDROID_HOME/platform-tools:$PATH"
  ```

## Build

```bash
cd android
gradle build          # Build debug + release APKs
gradle assembleDebug  # Debug APK only
gradle test           # Unit tests
```

APK output: `app/build/outputs/apk/debug/app-debug.apk`

## Stack

| Component | Version |
|-----------|---------|
| AGP | 9.1.0 |
| Kotlin | 2.3.0 (built-in with AGP 9) |
| Gradle | 9.4.1 |
| Compose BOM | 2026.03.00 |
| compileSdk | 36 (Android 16) |
| targetSdk | 35 (Android 15) |
| minSdk | 29 (Android 10) |
| OkHttp | 5.0.0-alpha.14 |

## Architecture

Thin transport layer: mic → WebSocket → Claudeway server → WebSocket → speaker.

```
network/     — WebSocket client (OkHttp), protocol types matching server
audio/       — Bluetooth SCO routing, PCM capture (8kHz mono), playback
voice/       — VoiceViewModel (state machine), UI state types
glasses/     — Meta DAT SDK integration (GlassesManager, GlassesState)
ui/          — Jetpack Compose (connection + conversation screens)
```

## DAT SDK (optional)

The Meta Device Access Toolkit SDK is required only for glasses-specific features (touchpad gestures, device discovery). Without it, the app works as a standalone voice client using the phone mic/speaker.

To enable: uncomment `implementation(libs.dat.sdk)` in `app/build.gradle.kts` and add GitHub Packages credentials to `local.properties`:
```properties
gpr.user=YOUR_GITHUB_USERNAME
gpr.key=YOUR_GITHUB_TOKEN
```

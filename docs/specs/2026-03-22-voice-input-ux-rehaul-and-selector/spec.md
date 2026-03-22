# Voice Input UX Rehaul & Audio Device Selector

**Date:** 2026-03-22
**Component:** Android companion app
**Mockups:** `voice-input-bar.html`, `voice-settings-screen.html`

---

## 1. Input Bar — Dual Mode (Text / Voice)

The bottom input bar has two states toggled by a small icon button.

### Text Mode
- Standard text input field with send button
- Small mic icon on the left to switch to voice mode

### Voice Mode
- Prominent centered mic button (matches mockup: large circular, `primary-container` gradient, glow effect)
- **Idle:** Mic icon, ready to press and hold
- **Listening (pressed/active):** Visual indicator changes while the user is actively holding the button:
  - Pulsing ring animation around the mic button (concentric rings, `primary/10` → `primary/5`)
  - Simple input-level visualizer above the button (8 vertical bars driven by current mic level; does not need to render a true waveform — see mockup's `voice-input-bar.html` lines 135–144 for the visual style target)
- Small keyboard icon on one side to switch back to text mode
- Small audio settings icon (non-prominent, e.g., `tune` or `volume_up` icon) to open the audio device sheet

### Visual Feedback on Sound Input
- The 8-bar visualizer reflects current mic input level, not a literal waveform
- Implementation goal: use the simplest signal already available from the recorder path (for example, peak or RMS level per captured chunk)
- Bars animate smoothly enough to feel responsive; lightweight interpolation/smoothing is sufficient
- When silent: bars remain near minimum height with a subtle idle pulse
- When speaking: bars rise proportionally to the measured level

---

## 2. Audio Device Settings — Bottom Sheet

Opened via the small settings icon in voice mode. Slides up as a bottom sheet over the current screen (with scrim overlay, see `voice-settings-screen.html`).

### Layout
- Drag handle at top
- "Audio Settings" header with close button
- Two sections: **INPUT** and **OUTPUT**
- Each section lists available devices as selectable rows
- Active device has: highlighted background (`surface-container-highest`), `primary` border accent, filled radio indicator
- Inactive devices have: default surface background, outline-only radio indicator
- "Apply Configuration" button at bottom (gradient `primary-container` → `primary`)

### Selection Semantics
- Device taps update the pending selection in the sheet only; they do **not** immediately re-route audio
- Tapping "Apply Configuration" commits the pending selections and activates pinned mode for the affected route(s)
- Closing/dismissing the sheet without tapping "Apply Configuration" discards pending edits
- The visible highlighted state inside the sheet should distinguish between:
  - the device currently active in the app
  - any pending selection the user has made but not yet applied

### Device Row Format
- Icon (in circle, contextual: `smartphone`, `headset_mic`, `headphones`, `speaker_phone`, `hearing`)
- Device name (bold)
- Device detail subtitle when applicable (e.g., "Sony WH-1000XM4", "Built-in array")
- Radio button indicator on the right

---

## 3. Audio Routing Logic

### Design Principle
**Auto by default, manual pin with auto-reset.** Keep the current auto-routing behavior as the happy path. The settings sheet exists only for manual overrides.

### Supported Device Scope
- For this iteration, treat device selection generically: surface whatever Android reports as available/selectable communication devices for the current session
- Do not block this UX redesign on perfect coverage of every hardware category or edge-case device behavior
- If certain connected devices cannot yet be routed reliably on some phones/headsets, that follow-up work is out of scope for this spec and can be addressed later
- The UX should still be structured around **INPUT** and **OUTPUT** selections even if the initial implementation shares lower-level routing behavior

### States

| State | Behavior |
|-------|----------|
| **Auto (default)** | System follows device priority: connected headset > phone mic/speaker. No manual selection stored. |
| **Pinned** | User tapped a specific device in settings. That device is forced regardless of what's connected. A subtle "Auto" chip/link is shown in the sheet header to reset. |

### Device Connect/Disconnect Rules

| Event | If Auto Mode | If Pinned |
|-------|-------------|-----------|
| **Headset connects** | Auto-switch to headset (both input & output) | Show toast: "Headset connected — tap to switch." Do NOT override user's pin. |
| **Headset disconnects** | Fall back to phone mic + phone speaker | If pinned device was the headset → revert to auto mode + fall back to phone. If pinned device was phone → no change. |
| **User selects a device and taps "Apply Configuration"** | Transitions to pinned state for that route (input or output independently) | Changes the pin to the new device. |
| **User taps "Auto" reset** | No-op (already auto) | Clears pin, returns to auto mode. |

### UX Details
- The "Auto" reset action is only visible when a manual override is active (small text link or chip near the section header, e.g., "INPUT · Pinned" with a reset icon)
- In auto mode, the currently-active device is highlighted but there's no "pinned" indicator — it just shows what's currently in use
- Toast notifications for device connect/disconnect events are brief and non-blocking
- Input and output can be pinned independently (e.g., pin output to phone speaker, leave input on auto)

---

## 4. Color Scheme

Adopt the Obsidian dark theme from the mockups. Key tokens:

| Token | Value | Usage |
|-------|-------|-------|
| `background` / `surface` | `#131313` | App background |
| `surface-container-lowest` | `#0e0e0e` | Nav bar bg |
| `surface-container-low` | `#1c1b1b` | Bottom sheet bg |
| `surface-container` | `#20201f` | Inactive device rows |
| `surface-container-high` | `#2a2a2a` | Hover states |
| `surface-container-highest` | `#353535` | Active/selected items |
| `primary` | `#ffb59e` | Accent color, text highlights |
| `primary-container` | `#d97757` | Mic button bg, CTA buttons |
| `on-primary` | `#5c1902` | Text on primary surfaces |
| `on-surface` | `#e5e2e1` | Primary text |
| `on-surface-variant` | `#dbc1b9` | Secondary text |
| `outline-variant` | `#55433d` | Borders, inactive radio buttons |
| `tertiary` | `#e3c0a2` | Section label icons |
| `error` | `#ffb4ab` | Error states |

Fonts: **Manrope** (headlines, bold), **Inter** (body, labels).

Theme rules:
- Use the fixed Obsidian palette for this redesign instead of Android dynamic color theming
- The goal is visual consistency with the mockups across devices, not wallpaper-based personalization
- Apply this fixed theme direction across the Android app surfaces touched by this redesign

---

## 5. Scope Notes

- Header and chat bubble redesign are **out of scope** for this spec
- The interaction model remains **push-to-talk / press-and-hold** from the current implementation; this spec does **not** introduce tap-to-toggle recording
- Server-side STT/TTS provider selection is unchanged — this spec covers only the Android client UX

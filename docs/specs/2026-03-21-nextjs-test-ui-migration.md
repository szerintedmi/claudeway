# Plan: Migrate Glasses Test UI to Next.js with Streamdown

## Context

The glasses test UI (`src/adapters/glasses/test-ui/index.html`) currently renders Claude responses using a hand-rolled regex-based markdown parser (~20 lines) that only handles basic formatting (code blocks, bold, italic, links, paragraphs). This produces an "inline HTML mess" and lacks support for tables, nested lists, headings, etc.

The dashboard-v3 project uses **Streamdown** (v2.5.0), a React-only markdown renderer with streaming support, word-by-word blur-in animations, and proper GFM rendering. Since Streamdown requires React 18+, we need to migrate the test UI from plain HTML to a React-based framework. Next.js is chosen as it provides a modern React setup with minimal configuration.

**Additional goals:**
- The glasses adapter + UI should be runnable **independently** from the Slack adapter (no need to start the full app)
- Docker support must be maintained
- README updates needed

## Approach

Create a Next.js app inside `src/adapters/glasses/test-ui/` that replaces the single `index.html` file. The Bun server serves the static export in production. Also add a standalone glasses entry point so it can run without Slack.

---

## Phase 1: Scaffold Next.js App

1. **Create Next.js project** at `src/adapters/glasses/test-ui/`
   - Use `npx create-next-app@latest` with App Router, TypeScript, CSS Modules
   - No Tailwind (keep styling consistent with current dark theme)
   - Static export mode (`output: 'export'` in next.config) so Bun can serve the built files

2. **Install dependencies:**
   - `streamdown` (^2.5.0)
   - `react` and `react-dom` (18 or 19, peer deps of streamdown)

3. **Update `.gitignore`** to exclude `test-ui/node_modules/`, `test-ui/.next/`, `test-ui/out/`

## Phase 2: Build React Components

Migrate the existing UI into React components, preserving all current functionality:

### Component Structure
```
test-ui/app/
  layout.tsx          -- Root layout, global styles, streamdown CSS import
  page.tsx            -- Main page component, orchestrates state
  components/
    ConnectionBar.tsx  -- URL input, auth token, connect/disconnect, status dot
    MessageList.tsx    -- Scrollable message area, auto-scroll
    MessageBubble.tsx  -- Individual message (sent/received/error/system/status/transcript)
    StreamingMarkdown.tsx -- Streamdown wrapper (ported from dashboard-v3)
    InputBar.tsx       -- Text input + send button + mic button
    StatusIndicator.tsx -- Tool activity spinner, agent nesting
  hooks/
    useWebSocket.ts    -- WebSocket connection, message routing, reconnection
    useAudioRecorder.ts -- MediaRecorder API, chunk buffering, base64 encoding
  styles/
    globals.css        -- Dark theme base styles (ported from current index.html)
    markdown.module.css -- Streamdown overrides + table scroll shadows (ported from dashboard-v3)
```

### Key Component Details

**`useWebSocket` hook:**
- Manages connection lifecycle (connect/disconnect)
- Parses incoming JSON messages and dispatches to callbacks
- Sends typed messages (text, audio_start, audio_chunk, audio_end, cancel, ping)
- Auth token from localStorage (same key: `glasses-auth-token`)

**`StreamingMarkdown` (ported from dashboard-v3):**
- `bufferTableContent()` function to hold back incomplete tables during streaming
- `<Streamdown mode="streaming"|"static">` with blur-in animation config
- Custom table component wrapper for horizontal scrolling
- Import `streamdown/styles.css` + custom markdown CSS module

**`MessageList` + `MessageBubble`:**
- Replace `streamingDivs` Map with React state: `messages` array with `{ id, type, text, streaming, final }` objects
- Streaming messages update in-place via requestId lookup
- Tool status rendered as nested indicators (Agent with sub-tool detail lines)
- Tool-to-text transitions: finalize previous block, start new one (same logic as current)

**`useAudioRecorder` hook:**
- MIME type detection (webm/opus → webm → default)
- 250ms chunk interval
- Client-side buffering, single base64 chunk on stop
- Recording state for UI pulse animation

### Styles
- Port the dark theme CSS from current `index.html` (background `#1a1a2e`, text `#e0e0e0`, etc.)
- Port table scroll-shadow technique from dashboard-v3 SCSS
- Override Streamdown default styles to match dark theme (code blocks `#0f3460`, links `#74b9ff`, etc.)

## Phase 3: Integrate with Bun Server

Modify `src/adapters/glasses/index.ts` to serve the Next.js static export:

- **Current:** Serves `test-ui/index.html` as a single file response for `/`, `/test-ui`, `/test-ui/`
- **New:** Serve files from `test-ui/out/` directory (Next.js static export output)
  - `/` and `/test-ui` → `test-ui/out/index.html`
  - Static assets (`_next/*`) → serve from `test-ui/out/_next/`
- WebSocket endpoint (`/ws`) remains unchanged
- No protocol changes needed — all message types stay the same

### Dev Workflow
- `cd src/adapters/glasses/test-ui && npm run dev` — Next.js dev server on a separate port
- Point the UI's WS URL input to the Bun server (already configurable in the UI)
- `npm run build` in test-ui → generates `out/` for production

## Phase 4: Standalone Glasses Entry Point

Currently both adapters start from `src/index.ts` and at least one must be configured. To run glasses independently:

1. **Create `src/index-glasses.ts`** — a lightweight entry point that:
   - Loads config and validates `glassesServer` is enabled
   - Runs shared startup (pidfile lock, repo sync, MCP config generation)
   - Calls `startGlassesAdapter(config)` only — skips all Slack initialization
   - No `SLACK_BOT_TOKEN` or `SLACK_APP_TOKEN` required

2. **Add scripts to root `package.json`:**
   ```json
   {
     "start:glasses": "bun src/index-glasses.ts",
     "dev:glasses": "bun --watch src/index-glasses.ts"
   }
   ```

3. **Why this works easily:** The glasses adapter is already loosely coupled:
   - Uses the shared `ChannelResponder` interface (adapter-agnostic)
   - Shares the file-based queue and core engine (no Slack dependency)
   - Has its own protocol types in `src/adapters/glasses/protocol.ts`
   - Only coupling is the shared startup sequence in `src/index.ts`

## Phase 5: Docker Support

The current Docker setup (`Dockerfile`, `docker-compose.yml`) runs the main `bun start` entry point. Changes needed:

1. **Add test-ui build step to Dockerfile:**
   ```dockerfile
   # Build test UI static export (after npm/bun install)
   WORKDIR /app/src/adapters/glasses/test-ui
   RUN npm ci && npm run build
   WORKDIR /app
   ```
   This produces the `out/` directory inside the image so the Bun server can serve it.

2. **Add glasses-only service to `docker-compose.yml`:**
   ```yaml
   services:
     claudeway:
       # ... existing config (runs both adapters)

     claudeway-glasses:
       # Same image, different command
       build: .
       command: bun src/index-glasses.ts
       ports:
         - "${GLASSES_PORT:-8765}:${GLASSES_PORT:-8765}"
       # Same volumes/env as main service, minus Slack tokens
   ```
   Users can run `docker compose up claudeway-glasses` to start only the glasses adapter.

3. **Ensure `test-ui/node_modules` is not in `.dockerignore`** — or better, add a multi-stage build where the test-ui is built in a separate stage and only `out/` is copied to the final image.

## Phase 6: README & Documentation Updates

1. **Update main `README.md`** with:
   - Glasses adapter section: what it is, how to configure it
   - How to run glasses-only: `bun start:glasses` or `docker compose up claudeway-glasses`
   - Test UI section: how to access (`http://localhost:8765/`), how to develop (`bun run dev:test-ui`)

2. **Update `CLAUDE.md`** Architecture section:
   - Add `src/index-glasses.ts` — Glasses-only entry point
   - Update `src/adapters/glasses/test-ui/` description (Next.js app, not single HTML file)
   - Add new scripts to Development section

3. **Note for future:** This test UI is effectively becoming a proper glasses channel UI. Consider renaming from "test-ui" to just "ui" or "web-ui" in a future iteration once it's stable.

## Phase 7: Build Scripts

Add to root `package.json`:
```json
{
  "scripts": {
    "build:test-ui": "cd src/adapters/glasses/test-ui && npm run build",
    "dev:test-ui": "cd src/adapters/glasses/test-ui && npm run dev",
    "start:glasses": "bun src/index-glasses.ts",
    "dev:glasses": "bun --watch src/index-glasses.ts"
  }
}
```

---

## Verification

1. **Build:** `cd src/adapters/glasses/test-ui && npm install && npm run build` succeeds
2. **Standalone start:** `bun run start:glasses` starts without Slack tokens configured
3. **Serve:** Navigate to `http://localhost:8765/` → Next.js app loads
4. **Connect:** Enter WS URL + auth token → green status dot
5. **Text messaging:** Send a message → streaming response renders with Streamdown (blur-in animation during stream, static render on completion)
6. **Markdown quality:** Response with tables, code blocks, nested lists, headings all render correctly
7. **Tool status:** Tool events show spinners, Agent nesting works, checkmarks on completion
8. **Audio:** Mic button records → transcription → response (if voice provider configured)
9. **Docker:** `docker compose up claudeway-glasses` starts glasses-only service, UI accessible
10. **Existing tests pass:** `bun test` — glasses protocol/handler/responder tests unaffected

## Files to Create
- `src/adapters/glasses/test-ui/package.json`
- `src/adapters/glasses/test-ui/next.config.ts`
- `src/adapters/glasses/test-ui/tsconfig.json`
- `src/adapters/glasses/test-ui/app/layout.tsx`
- `src/adapters/glasses/test-ui/app/page.tsx`
- `src/adapters/glasses/test-ui/app/components/*.tsx` (6 components)
- `src/adapters/glasses/test-ui/app/hooks/*.ts` (2 hooks)
- `src/adapters/glasses/test-ui/app/styles/*.css` (2 style files)
- `src/index-glasses.ts` — standalone glasses entry point

## Files to Modify
- `src/adapters/glasses/index.ts` — serve static export instead of single HTML file
- `.gitignore` — add test-ui build artifacts
- `Dockerfile` — add test-ui build step
- `docker-compose.yml` — add glasses-only service
- `package.json` — add build/dev/start scripts
- `README.md` — glasses adapter docs
- `CLAUDE.md` — architecture and scripts updates

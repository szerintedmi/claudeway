# Claude CLI `stream-json` Event Reference

Documentation of the NDJSON events emitted by `claude -p --output-format stream-json`, discovered through runtime logging. This covers both the documented API-level events and the CLI-specific events for sub-agent execution.

## Event Structure

Each line is a JSON object with a `type` field. There are two categories:

1. **`stream_event`** - Wraps Anthropic API streaming events (`obj.type === "stream_event"`, actual event in `obj.event`)
2. **Top-level events** - CLI-specific events (`system`, `assistant`, `result`, `user`, `rate_limit_event`)

## API Streaming Events (`type: "stream_event"`)

### Text Delta

Text content streaming from the assistant.

```json
{
  "type": "stream_event",
  "event": {
    "type": "content_block_delta",
    "index": 0,
    "delta": { "type": "text_delta", "text": "Hello" }
  }
}
```

### Tool Use Start

Assistant begins a tool call. The `index` identifies this content block.

```json
{
  "type": "stream_event",
  "event": {
    "type": "content_block_start",
    "index": 1,
    "content_block": { "type": "tool_use", "id": "toolu_01Xyz...", "name": "Read", "input": {} }
  }
}
```

### Tool Input Delta

Partial JSON for tool arguments, streamed incrementally. Matched to a tool block by `index`.

```json
{
  "type": "stream_event",
  "event": {
    "type": "content_block_delta",
    "index": 1,
    "delta": { "type": "input_json_delta", "partial_json": "{\"file_path\":" }
  }
}
```

### Content Block Stop

Signals the end of a content block (text or tool_use). Matched by `index`.

```json
{
  "type": "stream_event",
  "event": { "type": "content_block_stop", "index": 1 }
}
```

### Message Lifecycle

These bracket the assistant's message turns. Not currently used but present in the stream:

- `message_start` - Beginning of a new assistant message
- `message_delta` - Message-level metadata updates (e.g., stop_reason)
- `message_stop` - End of the assistant message

## CLI Top-Level Events

### `result`

Final event for a completed response. Contains the full response text, session ID, and cost.

```json
{
  "type": "result",
  "result": "Here is my response...",
  "session_id": "abc-123",
  "cost_usd": 0.0234,
  "total_cost_usd": 0.0567,
  "usage": { "input_tokens": 1500, "output_tokens": 300 }
}
```

### `user`

Echoed user message (seen in persistent mode with `--replay-user-messages`).

```json
{ "type": "user", "message": { "role": "user", "content": "..." } }
```

### `system`

CLI system events. The `subtype` field distinguishes them:

#### `init` - Session initialization

Emitted once at session start. Contains tools, model, MCP servers, agents, skills, etc.

```json
{
  "type": "system",
  "subtype": "init",
  "cwd": "/path/to/project",
  "session_id": "uuid",
  "tools": ["Bash", "Read", "Edit", "..."],
  "model": "claude-opus-4-6",
  "permissionMode": "...",
  "agents": [...],
  "skills": [...]
}
```

#### `hook_started` / `hook_response` - Hook lifecycle

```json
{
  "type": "system",
  "subtype": "hook_started",
  "hook_id": "uuid",
  "hook_name": "SessionStart:startup",
  "hook_event": "SessionStart",
  "session_id": "uuid"
}
```

```json
{
  "type": "system",
  "subtype": "hook_response",
  "hook_id": "uuid",
  "hook_name": "SessionStart:startup",
  "hook_event": "SessionStart",
  "output": "OK\n",
  "exit_code": 0,
  "outcome": "success"
}
```

#### `task_started` - Sub-agent launched

Emitted when a sub-agent begins execution (after the parent's Agent tool call is fully streamed).

```json
{
  "type": "system",
  "subtype": "task_started",
  "task_id": "ac092f000898ac868",
  "tool_use_id": "toolu_018DzpBWsRhMe3bqh8yb1kFJ",
  "description": "Search .md files with fd",
  "task_type": "local_agent",
  "prompt": "Search for \"markdown streaming\" in .md files...",
  "session_id": "uuid"
}
```

#### `task_progress` - Sub-agent tool activity

Emitted each time a sub-agent completes a tool call. Provides a human-readable description of what the agent is doing.

```json
{
  "type": "system",
  "subtype": "task_progress",
  "task_id": "ac092f000898ac868",
  "tool_use_id": "toolu_018DzpBWsRhMe3bqh8yb1kFJ",
  "description": "Running Find .md files containing \"markdown streaming\" (case-insensitive)",
  "usage": { "total_tokens": 13756, "tool_uses": 1, "duration_ms": 3130 },
  "last_tool_name": "Bash",
  "session_id": "uuid"
}
```

Key fields:
- `description` - Human-readable summary of the agent's current/last action
- `last_tool_name` - The tool the agent just used
- `tool_use_id` - Links back to the parent Agent tool call
- `usage` - Cumulative token/tool usage for this sub-agent

#### `task_notification` - Sub-agent completed

Emitted when a sub-agent finishes all its work and returns results to the parent.

```json
{
  "type": "system",
  "subtype": "task_notification",
  "task_id": "ac092f000898ac868",
  "tool_use_id": "toolu_018DzpBWsRhMe3bqh8yb1kFJ",
  "status": "completed",
  "output_file": "",
  "summary": "Search .md files with fd",
  "usage": { "total_tokens": 14763, "tool_uses": 2, "duration_ms": 18434 },
  "session_id": "uuid"
}
```

Key fields:
- `status` - `"completed"` (only value we parse; other statuses are ignored)
- `summary` - Human-readable description of what the agent did
- `usage.tool_uses` - Number of tool calls the sub-agent made
- `usage.total_tokens` - Cumulative token count
- `usage.duration_ms` - Wall-clock time the sub-agent ran
- `tool_use_id` - Links back to the parent Agent tool call

### `assistant`

Sub-agent conversation turns. These contain the sub-agent's actual messages (thinking, tool calls, text responses). Identified by the `parent_tool_use_id` field linking to the parent Agent tool call.

```json
{
  "type": "assistant",
  "message": {
    "model": "claude-opus-4-6",
    "id": "msg_01EA3...",
    "role": "assistant",
    "content": [
      { "type": "thinking", "thinking": "..." },
      { "type": "tool_use", "id": "toolu_01Jq7...", "name": "Bash", "input": { "command": "fd -e md ." } }
    ]
  },
  "parent_tool_use_id": "toolu_018DzpBWsRhMe3bqh8yb1kFJ",
  "session_id": "uuid"
}
```

Note: These are full message snapshots, not streaming deltas. Each `assistant` event contains the complete message content array up to that point. The sub-agent's internal tool calls do NOT appear as separate `stream_event` blocks -- they are only visible through these `assistant` events and the `task_progress` system events.

The `content` array can also include `tool_result` blocks with command output (e.g., Bash stdout). This could be parsed to display tool output in the UI (similar to how Claude CLI shows Bash output as expandable sub-detail), but is not currently implemented (see TODO).

### `rate_limit_event`

Emitted when the API rate limit is approached or hit. Not currently parsed.

## Event Flow: Tool Call Lifecycle

```
tool_start (index=N)          # Assistant decides to use a tool
  tool_input_delta (index=N)  # Tool params streaming (may be many)
  tool_input_delta (index=N)
content_block_stop (index=N)  # Tool call definition complete
                              # ... tool executes (no events) ...
                              # Next assistant turn begins with result
```

## Event Flow: Sub-Agent Lifecycle

```
tool_start (Agent, index=N)        # Parent decides to spawn agent
  tool_input_delta (index=N)       # Agent params streaming (description, prompt)
content_block_stop (index=N)       # Agent tool call definition complete
system:task_started                # CLI launches the sub-agent
  system:task_progress             # Agent uses a tool (repeats)
  assistant (parent_tool_use_id)   # Agent's full message snapshot
  system:task_progress             # Agent uses another tool
  assistant (parent_tool_use_id)   # Updated message snapshot
system:task_notification(completed)# Agent finished, result returned to parent
```

Important: between `content_block_stop` for the Agent tool and `task_started`, there is a brief gap. The `task_progress` events provide the best real-time visibility into sub-agent work. The `assistant` events are full snapshots but are verbose and harder to parse for status display.

## What We Parse in Claudeway

Currently parsed in `src/claude.ts` `parseStreamLine()`:

| Event | StreamLineEvent type | Used for |
|-------|---------------------|----------|
| text_delta | `text_delta` | Streaming response text to client |
| content_block_start (tool_use) | `tool_start` | Tool status indicators |
| input_json_delta | `tool_input_delta` | Extracting tool key arguments |
| content_block_stop | `tool_stop` | Tool completion + key arg extraction |
| result | `result` | Session ID, cost, final text |
| user | `user_receipt` | Persistent mode message echo |
| system:task_progress | `subagent_progress` | Sub-agent detail status updates |
| system:task_notification (completed) | `subagent_completed` | Marking sub-agents as done + usage stats (tool_uses, tokens, duration) |

Not parsed (ignored):
- `message_start`, `message_delta`, `message_stop` - message lifecycle
- `system:init` - session initialization metadata
- `system:hook_started`, `system:hook_response` - hook lifecycle
- `system:task_started` - could be used but `task_progress` covers the need
- `assistant` (with `parent_tool_use_id`) - sub-agent message snapshots (verbose; `task_progress` is sufficient for status). Contains `tool_result` blocks with command output that could be used for displaying Bash output
- `rate_limit_event` - rate limiting info

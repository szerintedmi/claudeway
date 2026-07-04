// Stream-json line parser + tool-argument extraction (pure, no I/O). Split out
// of claude.ts so the NDJSON parsing job stands alone and stays unit-testable.

export type ToolEventPayload =
  // `index` is the stream content-block index — a stable per-call key so a
  // completion is matched to the exact open call (parallel same-name tools can
  // finish out of order; matching by toolName alone mislabels the wrong card).
  // Optional: the runners always set it; consumers fall back to LIFO-by-name.
  | { phase: 'start'; toolName: string; index?: number }
  | { phase: 'complete'; toolName: string; keyArg: string | null; index?: number }
  | { phase: 'subagent_progress'; toolName: string; description: string }
  | {
      phase: 'subagent_completed';
      toolName: string;
      description: string;
      usage?: { toolUses: number; tokens: number; durationMs: number };
    };

export type StreamLineEvent =
  | { type: 'text_delta'; text: string }
  | { type: 'reasoning_delta'; text: string }
  | {
      type: 'result';
      text: string;
      sessionId: string | null;
      cost: number | null;
      tokens: number | null;
    }
  | { type: 'user_receipt' }
  | { type: 'tool_start'; toolName: string; index: number }
  | { type: 'tool_input_delta'; partialJson: string; index: number }
  | { type: 'tool_stop'; index: number }
  | { type: 'subagent_progress'; description: string; toolName: string }
  | {
      type: 'subagent_completed';
      description: string;
      usage?: { toolUses: number; tokens: number; durationMs: number };
    }
  | null;

/**
 * Parse one NDJSON line from Claude CLI --output-format stream-json output.
 * Returns a typed event or null (unrecognised / whitespace / invalid JSON).
 */
export function parseStreamLine(line: string): StreamLineEvent {
  if (!line.trim()) return null;
  try {
    const obj = JSON.parse(line);

    // Text delta — {"type":"stream_event","event":{"type":"content_block_delta","delta":{"type":"text_delta","text":"..."}}}
    if (
      obj.type === 'stream_event' &&
      obj.event?.type === 'content_block_delta' &&
      obj.event.delta?.type === 'text_delta' &&
      obj.event.delta.text
    ) {
      return { type: 'text_delta', text: obj.event.delta.text };
    }

    // Reasoning (extended thinking) delta — same envelope as text_delta but the
    // delta carries `thinking` instead of `text`. Surfaced separately so it can be
    // shown as "working notes" without polluting the final-answer text stream.
    if (
      obj.type === 'stream_event' &&
      obj.event?.type === 'content_block_delta' &&
      obj.event.delta?.type === 'thinking_delta' &&
      obj.event.delta.thinking
    ) {
      return { type: 'reasoning_delta', text: obj.event.delta.thinking };
    }

    // Result event
    if (obj.type === 'result') {
      const usage = obj.usage;
      const tokens = usage != null ? (usage.input_tokens ?? 0) + (usage.output_tokens ?? 0) : null;
      return {
        type: 'result',
        text: obj.result ?? '',
        sessionId: obj.session_id ?? null,
        cost: obj.cost_usd ?? obj.total_cost_usd ?? null,
        tokens,
      };
    }

    // User message receipt (persistent mode --replay-user-messages)
    if (obj.type === 'user') {
      return { type: 'user_receipt' };
    }

    // Tool use start — content_block_start with tool_use type
    if (
      obj.type === 'stream_event' &&
      obj.event?.type === 'content_block_start' &&
      obj.event.content_block?.type === 'tool_use'
    ) {
      return {
        type: 'tool_start',
        toolName: obj.event.content_block.name ?? 'unknown',
        index: obj.event.index ?? -1,
      };
    }

    // Tool input delta — partial JSON for tool arguments
    if (
      obj.type === 'stream_event' &&
      obj.event?.type === 'content_block_delta' &&
      obj.event.delta?.type === 'input_json_delta'
    ) {
      return {
        type: 'tool_input_delta',
        partialJson: obj.event.delta.partial_json ?? '',
        index: obj.event.index ?? -1,
      };
    }

    // Content block stop — only meaningful when matched with a tool block by index
    if (obj.type === 'stream_event' && obj.event?.type === 'content_block_stop') {
      return { type: 'tool_stop', index: obj.event.index ?? -1 };
    }

    // Sub-agent progress: system events with task_progress subtype
    if (obj.type === 'system' && obj.subtype === 'task_progress' && obj.description) {
      return {
        type: 'subagent_progress',
        description: obj.description,
        toolName: obj.last_tool_name ?? 'unknown',
      };
    }

    // Sub-agent completed
    if (
      obj.type === 'system' &&
      obj.subtype === 'task_notification' &&
      obj.status === 'completed'
    ) {
      const usage = obj.usage;
      return {
        type: 'subagent_completed',
        description: obj.summary ?? obj.description ?? '',
        ...(usage
          ? {
              usage: {
                toolUses: usage.tool_uses ?? 0,
                tokens: usage.total_tokens ?? 0,
                durationMs: usage.duration_ms ?? 0,
              },
            }
          : {}),
      };
    }

    return null;
  } catch {
    return null;
  }
}

// Known tool parameter priority map for extracting the most relevant argument
const TOOL_KEY_PARAMS: Record<string, string[]> = {
  Read: ['file_path'],
  Write: ['file_path'],
  Edit: ['file_path'],
  MultiEdit: ['file_path'],
  Bash: ['command'],
  Glob: ['pattern'],
  Grep: ['pattern'],
  LS: ['path'],
  WebFetch: ['url'],
  WebSearch: ['query'],
  Agent: ['description'],
};

export function extractKeyArg(toolName: string, accumulatedJson: string): string | null {
  try {
    const parsed = JSON.parse(accumulatedJson);
    const priority = TOOL_KEY_PARAMS[toolName] ?? [];
    for (const key of priority) {
      if (typeof parsed[key] === 'string' && parsed[key].length > 0) {
        const val: string = parsed[key];
        return val.length > 80 ? val.substring(0, 77) + '...' : val;
      }
    }
    // Fallback: first string-valued key
    for (const val of Object.values(parsed)) {
      if (typeof val === 'string' && val.length > 0) {
        return (val as string).length > 80
          ? (val as string).substring(0, 77) + '...'
          : (val as string);
      }
    }
  } catch {
    // Partial JSON may not be valid — return null gracefully
  }
  return null;
}

/** Accumulates a tool_use block's streamed partial JSON until its stop event. */
export interface ToolAccumulator {
  toolName: string;
  partialJson: string;
  index: number;
}

/**
 * Tracks in-flight tool_use blocks keyed by stream content-block index, so
 * overlapping blocks (index 1 starting before index 0 stops) accumulate
 * independently — a single-slot accumulator would drop the first block's
 * completion. `content_block_stop` fires for non-tool blocks too; those have
 * no entry here and `stop()` returns null for them.
 */
export class ToolUseAccumulators {
  private byIndex = new Map<number, ToolAccumulator>();

  start(toolName: string, index: number): void {
    this.byIndex.set(index, { toolName, partialJson: '', index });
  }

  appendInput(index: number, partialJson: string): void {
    const acc = this.byIndex.get(index);
    if (acc) acc.partialJson += partialJson;
  }

  /** Close the block at `index`, returning its accumulator (null if not a tool block). */
  stop(index: number): ToolAccumulator | null {
    const acc = this.byIndex.get(index);
    if (!acc) return null;
    this.byIndex.delete(index);
    return acc;
  }
}

# Phase 1: Mention-Only Mode & Thread Context Injection

## Overview

Enable Claudeway to work naturally in shared/public Slack channels by (a) only responding when explicitly `@mentioned` and (b) providing Claude with the full thread context when invoked within a thread.

Claudeway is designed as a **personal developer assistant** — one person's Claude instance that they can invoke in channels where they collaborate with others. The `allowedUsers` setting controls who can trigger the bot; the bot owner is the primary user, and may optionally grant access to additional users at their discretion.

## Motivation

Today, every message in a configured channel is forwarded to Claude. This works for dedicated channels where the bot owner works directly with Claude, but breaks down in shared channels where colleagues are having their own conversations. The bot owner needs the ability to pull their Claude assistant into a conversation on demand (`@Claude summarize this thread`) while keeping it silent otherwise.

When Claude is invoked mid-thread, it currently only sees the single triggering message. It has no awareness of the preceding conversation, making tasks like summarization or follow-up questions impossible.

## User Stories

1. **As the bot owner in a shared channel**, I want Claude to ignore messages unless I explicitly `@mention` it, so my colleagues' conversations aren't disrupted by my assistant.

2. **As the bot owner**, I want to `@mention` Claude in a thread and have it see the full thread history, so I can ask it to summarize, analyze, or respond to a discussion I'm part of.

3. **As the bot owner**, I want to `@mention` Claude in a top-level channel message (not inside a thread) and get a response, so I can ask one-off questions in the channel.

4. **As the bot owner**, I want to configure whether a channel uses always-on mode (current behavior) or mention-only mode, so I can choose the right behavior per channel.

5. **As the bot owner in an always-on channel**, when I reply inside a thread, I want Claude to see the thread context too, so it understands what part of the conversation I'm referring to.

## Requirements

### R1: Trigger mode configuration

- Add a per-channel config option `triggerMode` with values `"all"` (default) or `"mention"`.
- `"all"` preserves current behavior: every message in the channel is sent to Claude.
- `"mention"` means only messages that `@mention` the bot are processed; all other messages are silently ignored.
- The default is `"all"` for full backward compatibility. Existing configs require no changes.
- `triggerMode` can also be set in `defaults` to apply to all channels that don't override it.
- DMs are unaffected by this setting (they always behave as `"all"`).

**Config example (YAML):**

```yaml
defaults:
  triggerMode: all

channels:
  C_DEDICATED:
    name: claude-bot
    folder: ./projects/bot
    # triggerMode defaults to "all" -- every message goes to Claude

  C_PUBLIC:
    name: engineering
    folder: ./projects/eng
    triggerMode: mention  # Claude only responds when @mentioned
```

### R2: Mention detection and stripping

- In `"mention"` mode, a message is only processed if it contains an `@mention` of the bot user (Slack encodes this as `<@BOT_USER_ID>`).
- Before sending the message text to Claude, the `@mention` tag must be stripped so Claude doesn't see `<@U12345>` in the prompt. Replace it with nothing (or a space if needed to avoid word concatenation).
- Mention stripping applies in **both** trigger modes (`"all"` and `"mention"`). If someone `@mentions` the bot in an always-on channel, the raw `<@U12345>` is still cleaned from the prompt.
- If a message contains multiple mentions of the bot, all should be stripped.
- Messages that don't mention the bot are silently ignored (no reaction, no reply, no queue entry).

### R3: Thread context injection

- When a message is a thread reply (`thread_ts` differs from `ts`), fetch the full thread history using the Slack API (`conversations.replies`) before sending to Claude.
- This applies to **both** trigger modes (`"all"` and `"mention"`).
- The thread context includes **all messages** in the thread: human messages, bot messages (including previous Claude replies), file shares, etc. This gives Claude the complete picture.
- The thread context is prepended to the user's message as formatted text in the prompt. It is **not** injected as Claude session history — it's simply part of the message content.
- The triggering message itself should not be duplicated (it appears in the thread replies but is also the user's actual message).

**Prompt format:**

```
[Thread context — {N} prior messages]

{user_display_name}: {message_text}
{user_display_name}: {message_text}
...

[Current message]
{actual user message text}
```

- Use display names (not user IDs) in the thread context for readability. Resolve user IDs to display names via the Slack API (with caching to avoid excessive API calls).
- No message count cap. Send the full thread. Rely on Claude CLI's own context window limits as the natural boundary.

### R4: Thread context for top-level messages

- When a message is a **top-level** message (not a thread reply, i.e. `thread_ts` is absent or equals `ts`), no thread context is fetched. The message is sent to Claude as-is (current behavior).

### R5: Bot user ID resolution

- The bot's own user ID is needed for mention detection (R2). Resolve it at startup via the Slack API (`auth.test`) and cache it for the lifetime of the process.
- This is also useful for filtering the bot's own messages from thread context if needed in the future (not required now — bot messages are already filtered by `msg.bot_id` check).

## Non-Requirements (Explicitly Out of Scope)

- **Per-thread sessions**: Session ID derivation remains `channel + folder`. All threads in a channel share one Claude session. This is a Phase 2 concern.
- **Parallel thread processing**: The `channelBusy` serialization remains per-channel. Only one message is processed at a time per channel. This is a Phase 3 concern.
- **Thread context summarization or truncation**: No smart summarization of long threads. Full thread content is sent.
- **Reactions or acknowledgments for ignored messages**: In mention-only mode, messages without a mention are silently dropped. No "I'm ignoring you" feedback.

## Edge Cases

1. **Bot mentioned multiple times in one message**: Strip all mentions, process the message once.
2. **Bot mentioned in a thread reply in always-on mode**: The mention is incidental (the message would be processed anyway). No special handling needed, but the mention text should still be stripped to keep the prompt clean.
3. **Empty message after mention stripping**: If a message is just `@Claude` with no other text and no images, treat it the same as an empty message (current behavior — likely ignored).
4. **Thread starter is the only message**: If someone `@mentions` Claude in a top-level message that has no thread yet, there's no thread context to fetch. Just process the message normally.
5. **Very large threads**: No cap. The Slack API paginates `conversations.replies` at 1000 messages per call. Handle pagination if the thread exceeds this (unlikely but possible).
6. **Rate limiting on user ID resolution**: Cache display name lookups. A simple in-memory map of `userId -> displayName` is sufficient. Cache entries can live for the process lifetime.
7. **Thread contains file attachments or non-text content**: Include the text portion of each message. Files in thread context messages are not downloaded — only files in the triggering message are handled (current behavior).

## Config Schema Changes

```typescript
export interface ChannelConfig {
  name: string;
  folder: string;
  model?: string;
  systemPrompt?: string;
  timeoutMs?: number;
  responseMode?: ResponseMode;
  processMode?: ProcessMode;
  allowedUsers?: string[];
  triggerMode?: TriggerMode;       // NEW
}

export interface Defaults {
  model: string;
  systemPrompt: string;
  timeoutMs: number;
  responseMode: ResponseMode;
  processMode?: ProcessMode;
  triggerMode?: TriggerMode;       // NEW
}

export type TriggerMode = 'all' | 'mention';  // NEW
```

## Future Considerations (Not Phase 1)

- **Per-thread session IDs**: Derive session from `threadTs + folder` instead of `channelId + folder` for isolated thread conversations.
- **Concurrent thread processing**: Per-thread busy tracking and process pooling.
- **Slash commands**: An alternative invocation method (e.g., `/claude summarize`) instead of or in addition to `@mention`.
- **Configurable thread context depth**: A `maxThreadMessages` setting for channels where threads get very long.

import type { TriggerMode } from './config.js';
import type { ThreadMessage } from './thread.js';

export function stripBotMention(text: string, botUserId: string): string {
  return text
    .replace(new RegExp(`<@${botUserId}>`, 'g'), '')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

export function shouldRespond(
  text: string | undefined,
  botUserId: string,
  triggerMode: TriggerMode,
): boolean {
  if (triggerMode === 'all') return true;
  return !!text && text.includes(`<@${botUserId}>`);
}

export function formatThreadContext(messages: ThreadMessage[]): string {
  if (messages.length === 0) return '';
  const lines = messages.map((m) => `[${m.authorName}]: ${m.text}`);
  return (
    `[Thread context — ${messages.length} prior message${messages.length !== 1 ? 's' : ''}]\n\n` +
    lines.join('\n') +
    '\n\n[Current message]\n'
  );
}

export function buildPrompt(
  rawText: string,
  botUserId: string,
  threadMessages: ThreadMessage[],
): string {
  const stripped = stripBotMention(rawText, botUserId);
  const context = formatThreadContext(threadMessages);
  return context + stripped;
}

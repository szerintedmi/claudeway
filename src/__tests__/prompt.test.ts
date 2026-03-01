import { stripBotMention, shouldRespond, formatThreadContext, buildPrompt } from '../prompt.js';
import type { ThreadMessage } from '../thread.js';

const BOT_ID = 'U_BOT';

describe('stripBotMention', () => {
  it('removes a leading mention', () => {
    expect(stripBotMention(`<@${BOT_ID}> hello`, BOT_ID)).toBe('hello');
  });

  it('removes mid-text mentions', () => {
    expect(stripBotMention(`hey <@${BOT_ID}> help`, BOT_ID)).toBe('hey help');
  });

  it('leaves text unchanged when no mention present', () => {
    expect(stripBotMention('just a message', BOT_ID)).toBe('just a message');
  });

  it('handles multiple mentions', () => {
    expect(stripBotMention(`<@${BOT_ID}> foo <@${BOT_ID}>`, BOT_ID)).toBe('foo');
  });

  it('returns empty string for mention-only message', () => {
    expect(stripBotMention(`<@${BOT_ID}>`, BOT_ID)).toBe('');
  });

  it('does not strip mentions of other users', () => {
    expect(stripBotMention('<@U_OTHER> hello', BOT_ID)).toBe('<@U_OTHER> hello');
  });
});

describe('shouldRespond', () => {
  it('returns true in "all" mode regardless of mention', () => {
    expect(shouldRespond('hello world', BOT_ID, 'all')).toBe(true);
  });

  it('returns true in "all" mode even without text', () => {
    expect(shouldRespond(undefined, BOT_ID, 'all')).toBe(true);
  });

  it('returns true in "mention" mode when bot is mentioned', () => {
    expect(shouldRespond(`<@${BOT_ID}> help`, BOT_ID, 'mention')).toBe(true);
  });

  it('returns false in "mention" mode when bot is not mentioned', () => {
    expect(shouldRespond('help me', BOT_ID, 'mention')).toBe(false);
  });

  it('returns false in "mention" mode for undefined text', () => {
    expect(shouldRespond(undefined, BOT_ID, 'mention')).toBe(false);
  });
});

describe('formatThreadContext', () => {
  it('returns empty string for no messages', () => {
    expect(formatThreadContext([])).toBe('');
  });

  it('formats a single message with count', () => {
    const msgs: ThreadMessage[] = [{ authorName: 'Alice', isBot: false, text: 'hello' }];
    const result = formatThreadContext(msgs);
    expect(result).toContain('[Thread context — 1 prior message]');
    expect(result).toContain('[Alice]: hello');
    expect(result).toContain('[Current message]');
  });

  it('formats multiple messages with plural count', () => {
    const msgs: ThreadMessage[] = [
      { authorName: 'Alice', isBot: false, text: 'question' },
      { authorName: 'Claude', isBot: true, text: 'answer' },
    ];
    const result = formatThreadContext(msgs);
    expect(result).toContain('[Thread context — 2 prior messages]');
    expect(result).toContain('[Alice]: question');
    expect(result).toContain('[Claude]: answer');
  });

  it('uses authorName directly (bot label handled upstream)', () => {
    const msgs: ThreadMessage[] = [{ authorName: 'Claude', isBot: true, text: 'hi' }];
    expect(formatThreadContext(msgs)).toContain('[Claude]: hi');
  });
});

describe('buildPrompt', () => {
  it('returns stripped text when no thread context', () => {
    expect(buildPrompt(`<@${BOT_ID}> hello`, BOT_ID, [])).toBe('hello');
  });

  it('prepends thread context before the user message', () => {
    const msgs: ThreadMessage[] = [{ authorName: 'Alice', isBot: false, text: 'prior' }];
    const result = buildPrompt('follow up', BOT_ID, msgs);
    expect(result.indexOf('Thread context')).toBeLessThan(result.indexOf('follow up'));
  });

  it('strips mention and prepends context together', () => {
    const msgs: ThreadMessage[] = [{ authorName: 'Alice', isBot: false, text: 'first' }];
    const result = buildPrompt(`<@${BOT_ID}> second`, BOT_ID, msgs);
    expect(result).toContain('[Alice]: first');
    expect(result).toContain('second');
    expect(result).not.toContain(`<@${BOT_ID}>`);
  });
});

import { describe, it, expect, afterEach } from 'bun:test';
import { utimesSync } from 'fs';
import { join } from 'path';
import {
  compareSlackTs,
  loadSlackHistoryState,
  saveSlackHistoryState,
  deleteSlackHistoryState,
  cleanupStaleSlackHistory,
} from '../slack-history.js';
import { DATA_DIR } from '../config.js';
import { selectContextEntries } from '../adapters/slack/coordinator.js';
import type { SlackThreadEntry } from '../adapters/slack/thread.js';

const SESSION = 'test-slack-history-session';

afterEach(() => deleteSlackHistoryState(SESSION));

describe('compareSlackTs', () => {
  it('orders by seconds', () => {
    expect(compareSlackTs('100.000001', '200.000001')).toBe(-1);
    expect(compareSlackTs('200.000001', '100.000001')).toBe(1);
  });

  it('orders by microsecond fraction within the same second', () => {
    expect(compareSlackTs('1710000000.000101', '1710000000.000102')).toBe(-1);
    expect(compareSlackTs('1710000000.000102', '1710000000.000101')).toBe(1);
    expect(compareSlackTs('1710000000.000101', '1710000000.000101')).toBe(0);
  });

  it('does not lose precision where parseFloat would', () => {
    // These two differ only in the 16th significant digit
    expect(compareSlackTs('1710000000.000001', '1710000000.000002')).toBe(-1);
  });
});

describe('watermark state store', () => {
  it('round-trips save/load and delete', () => {
    expect(loadSlackHistoryState(SESSION)).toBeNull();
    saveSlackHistoryState({
      sessionId: SESSION,
      channelId: 'C1',
      threadTs: '100.1',
      lastSeenSlackTs: '150.2',
    });
    expect(loadSlackHistoryState(SESSION)?.lastSeenSlackTs).toBe('150.2');
    deleteSlackHistoryState(SESSION);
    expect(loadSlackHistoryState(SESSION)).toBeNull();
  });

  it('cleanupStaleSlackHistory removes files past the age cutoff, keeps fresh ones', () => {
    saveSlackHistoryState({
      sessionId: SESSION,
      channelId: 'C1',
      threadTs: '100.1',
      lastSeenSlackTs: '150.2',
    });
    // Backdate the file 40 days
    const file = join(DATA_DIR, 'slack-history', `${SESSION}.json`);
    const old = new Date(Date.now() - 40 * 24 * 60 * 60 * 1000);
    utimesSync(file, old, old);
    expect(cleanupStaleSlackHistory(30)).toBeGreaterThanOrEqual(1);
    expect(loadSlackHistoryState(SESSION)).toBeNull();

    saveSlackHistoryState({
      sessionId: SESSION,
      channelId: 'C1',
      threadTs: '100.1',
      lastSeenSlackTs: '150.2',
    });
    cleanupStaleSlackHistory(30);
    expect(loadSlackHistoryState(SESSION)).not.toBeNull();
  });
});

describe('selectContextEntries', () => {
  const entry = (ts: string, over: Partial<SlackThreadEntry> = {}): SlackThreadEntry => ({
    ts,
    userId: 'U1',
    authorName: 'Alice',
    isSelfBot: false,
    isBot: false,
    text: `msg ${ts}`,
    ...over,
  });

  const CURRENT = '200.000400';

  const thread = [
    entry('100.000100'),
    entry('110.000200', { userId: 'UBOT', isSelfBot: true, isBot: true }),
    entry('120.000300'),
    entry(CURRENT),
    entry('210.000500'), // queued later — must never leak into this turn
  ];

  it('new session (no artifact): full prior thread INCLUDING own bot messages', () => {
    const selected = selectContextEntries(thread, { resuming: false, currentTs: CURRENT });
    expect(selected.map((e) => e.ts)).toEqual(['100.000100', '110.000200', '120.000300']);
  });

  it('resumed session with watermark: only unseen entries', () => {
    const selected = selectContextEntries(thread, {
      resuming: true,
      watermark: '110.000200',
      currentTs: CURRENT,
    });
    expect(selected.map((e) => e.ts)).toEqual(['120.000300']);
  });

  it('resumed session excludes own bot messages even when unseen', () => {
    const selected = selectContextEntries(thread, {
      resuming: true,
      watermark: '100.000100',
      currentTs: CURRENT,
    });
    expect(selected.map((e) => e.ts)).toEqual(['120.000300']);
  });

  it('resumed session without watermark: full prior thread once, minus own bot messages', () => {
    const selected = selectContextEntries(thread, { resuming: true, currentTs: CURRENT });
    expect(selected.map((e) => e.ts)).toEqual(['100.000100', '120.000300']);
  });

  it('third-party bot messages are included as normal history', () => {
    const withJira = [entry('100.000100', { isBot: true, userId: undefined, authorName: 'Jira' })];
    const selected = selectContextEntries(withJira, {
      resuming: true,
      watermark: '090.000100',
      currentTs: CURRENT,
    });
    expect(selected).toHaveLength(1);
  });

  it('excludes the current message and anything after it', () => {
    const selected = selectContextEntries(thread, { resuming: false, currentTs: CURRENT });
    expect(selected.find((e) => e.ts === CURRENT)).toBeUndefined();
    expect(selected.find((e) => e.ts === '210.000500')).toBeUndefined();
  });
});

import { mkdirSync, writeFileSync, readFileSync, unlinkSync, readdirSync, existsSync } from 'fs';
import { join } from 'path';

export interface QueuedMessage {
  channelId: string;
  userId: string;
  teamId?: string;
  text: string;
  ts: string;
  threadTs: string;
  queuedAt: string;
  filePaths?: string[];
  userName?: string;
  /** Which adapter enqueued this message (default: "slack") */
  adapter?: 'slack' | 'voice';
  /** Bot's own Slack user id — lets engine replies render a clickable @bot mention */
  botUserId?: string;
  /** Per-turn model override parsed from a `!model:<name>` message prefix */
  modelOverride?: string;
  /** Per-turn effort override parsed from a `!effort:<level>` message prefix */
  effortOverride?: EffortLevel;
}

import { DATA_DIR, type EffortLevel } from './config.js';

const QUEUE_DIR = join(DATA_DIR, 'queue');

export function ensureQueueDir(): void {
  mkdirSync(QUEUE_DIR, { recursive: true });
}

function messageFile(channelId: string, ts: string): string {
  // Replace dots in ts for safe filenames
  return join(QUEUE_DIR, `${channelId}_${ts.replace('.', '-')}.json`);
}

export function enqueue(msg: QueuedMessage): void {
  const file = messageFile(msg.channelId, msg.ts);
  writeFileSync(file, JSON.stringify(msg, null, 2), 'utf-8');
}

export function dequeue(channelId: string, ts: string): boolean {
  const file = messageFile(channelId, ts);
  try {
    unlinkSync(file);
    return true;
  } catch {
    return false;
  }
}

export function getPending(): QueuedMessage[] {
  try {
    const files = readdirSync(QUEUE_DIR).filter((f) => f.endsWith('.json'));
    return files
      .map((f) => {
        try {
          return JSON.parse(readFileSync(join(QUEUE_DIR, f), 'utf-8')) as QueuedMessage;
        } catch {
          return null;
        }
      })
      .filter((m): m is QueuedMessage => m !== null)
      .sort((a, b) => a.queuedAt.localeCompare(b.queuedAt));
  } catch {
    return [];
  }
}

export function updateQueuedMessage(
  channelId: string,
  ts: string,
  updates: { text: string } & Pick<QueuedMessage, 'modelOverride' | 'effortOverride'>,
): boolean {
  const file = messageFile(channelId, ts);
  if (!existsSync(file)) return false;
  try {
    const existing = JSON.parse(readFileSync(file, 'utf-8')) as QueuedMessage;
    existing.text = updates.text;
    // Per-turn overrides: undefined means the edit removed the token — delete the field
    const syncOverride = <K extends 'modelOverride' | 'effortOverride'>(
      key: K,
      value: QueuedMessage[K],
    ) => {
      if (value === undefined) {
        delete existing[key];
      } else {
        existing[key] = value;
      }
    };
    syncOverride('modelOverride', updates.modelOverride);
    syncOverride('effortOverride', updates.effortOverride);
    writeFileSync(file, JSON.stringify(existing, null, 2), 'utf-8');
    return true;
  } catch {
    return false;
  }
}

export function getPendingForChannel(channelId: string): QueuedMessage[] {
  return getPending().filter((m) => m.channelId === channelId);
}

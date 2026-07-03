import { describe, expect, it, mock } from 'bun:test';
import type { WebClient } from '@slack/web-api';
import { handleCredsCommand } from '../adapters/slack/creds-command.js';
import { setBotIdentity } from '../creds-hint.js';
import type { Config } from '../config.js';

function makeConfig(): Config {
  return {
    botOwners: ['U0OWNER'],
    users: { alice: { slack: 'U0ALICE' } },
    channels: { C0CHAN: { name: 'chan', folder: '/p', members: ['alice'] } },
    defaults: { model: 'opus', systemPrompt: 's', timeoutMs: 1000, responseMode: 'batch' },
  };
}

describe('handleCredsCommand', () => {
  it('points channel users at the bot DM for DM-only credential commands', async () => {
    setBotIdentity({ botUserId: 'U0BOT' });
    const postMessage = mock(async () => ({ ok: true }));
    const client = { chat: { postMessage } } as unknown as WebClient;

    const handled = await handleCredsCommand(
      '!creds list',
      'C0CHAN',
      '1710000000.000100',
      'U0ALICE',
      client,
      makeConfig(),
      'U0BOT',
    );

    expect(handled).toBe(true);
    expect(postMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        channel: 'C0CHAN',
        thread_ts: '1710000000.000100',
        text: ':lock: Credential commands work in *direct messages* only — send `!creds` in a *direct message* to <@U0BOT> instead.',
      }),
    );
    setBotIdentity({});
  });
});

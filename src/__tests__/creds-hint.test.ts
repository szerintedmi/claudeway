import { setBotIdentity, getBotIdentity, credsDmInstruction } from '../creds-hint.js';

afterEach(() => setBotIdentity({}));

describe('credsDmInstruction', () => {
  it('embeds the clickable bot mention and names the direct message explicitly', () => {
    setBotIdentity({ botUserId: 'U0BOT' });
    expect(credsDmInstruction('connect your own token')).toBe(
      'send `!creds` in a *direct message* to <@U0BOT> to connect your own token',
    );
  });

  it('falls back to plain text without a bot user id', () => {
    expect(credsDmInstruction('connect it')).toBe(
      'send `!creds` in a *direct message* to me to connect it',
    );
    expect(credsDmInstruction()).toBe('send `!creds` in a *direct message* to me');
  });

  it('getBotIdentity returns a copy of the stored identity', () => {
    setBotIdentity({ botUserId: 'U1' });
    const id = getBotIdentity();
    id.botUserId = 'mutated';
    expect(getBotIdentity().botUserId).toBe('U1');
  });
});

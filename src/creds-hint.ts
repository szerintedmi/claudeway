/**
 * Single source of truth for the "connect your credentials" instruction.
 *
 * Every surface that tells a user how to enroll (engine refusals, onboarding,
 * `!whoami`, channel-scoped `!creds` refusal, agent-facing prompt guidance)
 * builds its copy from here so the wording never drifts.
 *
 * The instruction's weak point in practice: people don't realize `!creds`
 * only works in a DIRECT MESSAGE and type it in the channel instead. So the
 * copy names the direct message explicitly and embeds a clickable `<@bot>`
 * mention (opens the bot's profile card, whose Message button lands in the
 * DM). An `app_redirect` deep link was tried and reverted — it bounces
 * through Slack web instead of the app.
 */

export interface BotIdentity {
  /** Bot user id (U…) — renders as a clickable @mention. */
  botUserId?: string;
}

let identity: BotIdentity = {};

/** Set once by the Slack adapter at startup (auth.test). */
export function setBotIdentity(id: BotIdentity): void {
  identity = { ...id };
}

export function getBotIdentity(): BotIdentity {
  return { ...identity };
}

/**
 * The canonical enrollment instruction, as a lowercase sentence fragment so
 * callers can splice it after an em dash or capitalize it themselves:
 *
 *   send `!creds` in a *direct message* to <@bot> to <purpose>
 */
export function credsDmInstruction(purpose?: string, id: BotIdentity = identity): string {
  const target = id.botUserId ? `<@${id.botUserId}>` : 'me';
  return `send \`!creds\` in a *direct message* to ${target}${purpose ? ` to ${purpose}` : ''}`;
}

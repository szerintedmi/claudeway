import type { WebClient } from '@slack/web-api';
import {
  isUserAllowedAnywhere,
  isBotOwner as isBotOwnerId,
  resolveCanonicalUserId,
  type Config,
} from '../../config.js';
import { getSecretStore } from '../../secrets.js';
import { issueLink, LINK_TTL_MS } from '../../creds-links.js';
import { audit } from '../../audit.js';
import { botDmTarget } from './onboarding.js';

/**
 * `!creds` — self-service credential enrollment over Slack DM.
 *
 * Non-owner DM capability is strictly limited to this command family; the
 * sender identity is msg.user from the Bolt-verified event payload, never
 * message text. Secrets are never pasted into Slack — the command only issues
 * a single-use, short-TTL magic link to the web form.
 *
 * Subcommands:
 *   !creds                    — get an enrollment link (DM only)
 *   !creds list               — list your enrolled credential names
 *   !creds revoke <name>|all  — delete your own credential(s)
 *   !creds list @user         — botOwner: list a user's credential names
 *   !creds revoke @user [name|all] — botOwner: offboard a user
 */

const USAGE = [
  'Usage:',
  '• `!creds` — get a credential enrollment link',
  '• `!creds list` — list your enrolled credentials',
  '• `!creds revoke <name>|all` — remove your credential(s)',
  '• `!creds list @user` / `!creds revoke @user [name|all]` — botOwner only',
].join('\n');

interface CredsContext {
  channelId: string;
  threadTs: string;
  userId: string;
  client: WebClient;
  config: Config;
  botUserId?: string;
}

async function reply(ctx: CredsContext, text: string): Promise<void> {
  await ctx.client.chat.postMessage({
    channel: ctx.channelId,
    thread_ts: ctx.threadTs,
    text,
  });
}

function parseMention(arg: string | undefined): string | null {
  const m = arg?.match(/^<@(U[A-Z0-9]+)(?:\|[^>]*)?>$/);
  return m ? m[1] : null;
}

/**
 * Handle a `!creds ...` message. Returns true when the text was a creds
 * command (even if denied), false when it should fall through.
 */
export async function handleCredsCommand(
  text: string,
  channelId: string,
  threadTs: string,
  userId: string,
  client: WebClient,
  config: Config,
  botUserId?: string,
): Promise<boolean> {
  const trimmed = text.trim();
  if (trimmed !== '!creds' && !trimmed.startsWith('!creds ')) return false;

  const ctx: CredsContext = { channelId, threadTs, userId, client, config, botUserId };
  const isBotOwner = isBotOwnerId(config, userId);

  // Sender must be the botOwner or allowed in at least one configured channel
  if (!isBotOwner && !isUserAllowedAnywhere(config, userId)) {
    await reply(ctx, ":no_entry: Sorry, you're not authorized to use credential commands.");
    return true;
  }

  // DM-only: links and credential names don't belong in shared channels
  if (!channelId.startsWith('D')) {
    await reply(
      ctx,
      `:lock: Credential commands work in DMs only — DM ${botDmTarget(ctx.botUserId)} \`!creds\`.`,
    );
    return true;
  }

  const store = getSecretStore();

  const args = trimmed.split(/\s+/).slice(1);
  const sub = args[0];

  if (sub === undefined) {
    // baseUrl is a startup requirement, but config hot-reloads per message
    if (!config.baseUrl) {
      await reply(
        ctx,
        ':warning: The server has no `baseUrl` configured — enrollment links cannot be issued. Ask the bot owner to fix the config.',
      );
      return true;
    }
    const canonical = resolveCanonicalUserId(config, userId);
    const token = issueLink(canonical);
    const url = `${config.baseUrl.replace(/\/+$/, '')}/creds?t=${token}`;
    const minutes = Math.round(LINK_TTL_MS / 60000);
    await reply(
      ctx,
      `:key: Set up your credentials here (single-use link, expires in ${minutes} min):\n${url}\n` +
        'Never paste tokens into Slack — only into this form.',
    );
    return true;
  }

  if (sub === 'list') {
    const mention = parseMention(args[1]);
    if (mention && !isBotOwner) {
      await reply(ctx, ':no_entry: Only the bot owner can list credentials for other users.');
      return true;
    }
    const target = resolveCanonicalUserId(config, mention ?? userId);
    const names = store.listNames(target);
    const who = mention ? `<@${mention}> (${target})` : 'You';
    await reply(
      ctx,
      names.length > 0
        ? `:key: ${who} ha${mention ? 's' : 've'} credentials for: ${names.map((n) => `\`${n}\``).join(', ')}`
        : `:key: ${who} ha${mention ? 's' : 've'} no stored credentials.`,
    );
    return true;
  }

  if (sub === 'revoke') {
    const mention = parseMention(args[1]);
    if (mention && !isBotOwner) {
      await reply(ctx, ':no_entry: Only the bot owner can revoke credentials for other users.');
      return true;
    }
    const target = resolveCanonicalUserId(config, mention ?? userId);
    const nameArg = mention ? args[2] : args[1];
    if (!nameArg) {
      await reply(
        ctx,
        `:warning: Specify what to revoke: \`!creds revoke ${mention ? `<@${mention}> ` : ''}<name>|all\``,
      );
      return true;
    }
    const name = nameArg === 'all' ? undefined : nameArg;
    const before = store.listNames(target);
    const removed = store.delete(target, name);
    if (removed) {
      audit({
        event: 'creds.deleted',
        userId: target,
        credNames: name ? [name] : before,
        detail: mention ? `revoked by botOwner ${userId}` : 'self-revoked',
      });
      await reply(
        ctx,
        `:wastebasket: Removed ${name ? `\`${name}\`` : `all credentials (${before.map((n) => `\`${n}\``).join(', ')})`} for ${mention ? `<@${mention}>` : 'you'}.`,
      );
    } else {
      await reply(
        ctx,
        `:warning: Nothing to remove${name ? ` — no \`${name}\` credential stored` : ''}.`,
      );
    }
    return true;
  }

  await reply(ctx, USAGE);
  return true;
}

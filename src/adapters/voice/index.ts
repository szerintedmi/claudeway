import { readFileSync } from 'fs';
import { join, resolve } from 'path';
import { loadConfig, resolveVoiceToken, interpolateEnvVars, type Config } from '../../config.js';
import { initSession, handleMessage, handleClose } from './handler.js';
import { parseClientMessage, serializeServerMessage } from './protocol.js';
import type { VoiceProvider, TtsOptions } from '../../core/voice.js';
import { DeepgramVoiceProvider } from '../../core/voice-deepgram.js';

export interface WsData {
  userId: string;
  defaultChannel: string;
  authenticated: boolean;
}

const TEST_UI_DIR = resolve(import.meta.dir, 'test-ui');

/**
 * Global auth rate limiter with progressive backoff.
 * First 3 attempts: no delay. After that, exponentially increasing cooldown:
 * 4th: 5s, 5th: 10s, 6th: 20s, 7th: 40s, ... capped at 5 minutes.
 * A successful auth resets the counter.
 */
const AUTH_FREE_ATTEMPTS = 3;
const AUTH_BASE_DELAY_MS = 5_000;
const AUTH_MAX_DELAY_MS = 5 * 60 * 1000;
let authFailureCount = 0;
let lastFailureTime = 0;

function recordAuthFailure(): void {
  authFailureCount++;
  lastFailureTime = Date.now();
}

function isRateLimited(): boolean {
  if (authFailureCount < AUTH_FREE_ATTEMPTS) return false;
  const backoffExponent = authFailureCount - AUTH_FREE_ATTEMPTS;
  const cooldownMs = Math.min(AUTH_BASE_DELAY_MS * (1 << backoffExponent), AUTH_MAX_DELAY_MS);
  return Date.now() - lastFailureTime < cooldownMs;
}

function clearAuthFailures(): void {
  authFailureCount = 0;
  lastFailureTime = 0;
}

/** Create VoiceProvider from config. Returns undefined if voice not configured. */
function createVoiceProvider(cfg: Config): VoiceProvider | undefined {
  if (!cfg.voice) return undefined;

  const apiKey = interpolateEnvVars(cfg.voice.deepgram.apiKey);
  const sttModel = cfg.voice.deepgram.sttModel ?? 'nova-3';
  return new DeepgramVoiceProvider(apiKey, sttModel);
}

/** Build TTS options from config. Returns undefined if voice not configured. */
function buildTtsOptions(cfg: Config): TtsOptions | undefined {
  if (!cfg.voice) return undefined;

  return {
    model: cfg.voice.deepgram.ttsModel ?? 'aura-2-thalia-en',
    encoding: 'linear16',
    sampleRate: cfg.voice.deepgram.ttsSampleRate ?? 24000,
  };
}

export function startVoiceAdapter(config?: Config): void {
  const cfg = config ?? loadConfig();
  const serverConfig = cfg.voiceServer;
  if (!serverConfig?.enabled) return;

  // Voice config required when voice adapter is enabled (Phase 2+)
  if (!cfg.voice) {
    throw new Error(
      '[voice] Cannot start: voice config is required when voiceServer is enabled. ' +
        'Add a "voice" section to config.yaml with provider and API key.',
    );
  }
  const voiceProvider = createVoiceProvider(cfg)!;
  const ttsOptions = buildTtsOptions(cfg);
  const port = serverConfig.port;

  Bun.serve<WsData>({
    port,
    hostname: '0.0.0.0',

    fetch(req, server) {
      const url = new URL(req.url);

      // WebSocket upgrade
      if (url.pathname === '/ws') {
        if (isRateLimited()) {
          return new Response('Too many failed auth attempts', { status: 429 });
        }

        // Try Authorization header first (Android/native clients)
        const authHeader = req.headers.get('authorization');
        const rawToken = authHeader?.startsWith('Bearer ') ? authHeader.slice(7) : null;

        let wsData: WsData;
        if (rawToken) {
          // Header auth — validate now
          const freshConfig = loadConfig();
          const tokenConfig = resolveVoiceToken(freshConfig, rawToken);
          if (!tokenConfig) {
            recordAuthFailure();
            return new Response('Unauthorized: invalid token', { status: 401 });
          }
          clearAuthFailures();
          wsData = {
            userId: tokenConfig.userId,
            defaultChannel: tokenConfig.defaultChannel,
            authenticated: true,
          };
        } else {
          // No header token — allow upgrade, require auth message as first message
          wsData = { userId: '', defaultChannel: '', authenticated: false };
        }

        const upgraded = server.upgrade(req, { data: wsData });
        if (!upgraded) {
          return new Response('WebSocket upgrade failed', { status: 500 });
        }
        return undefined;
      }

      // Favicon — inline SVG icon
      if (url.pathname === '/favicon.ico') {
        const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><rect width="32" height="32" rx="6" fill="#1a1a2e"/><circle cx="10" cy="16" r="5" stroke="#0a9396" stroke-width="2" fill="none"/><circle cx="22" cy="16" r="5" stroke="#0a9396" stroke-width="2" fill="none"/><path d="M15 16h2" stroke="#0a9396" stroke-width="2" stroke-linecap="round"/><path d="M5 16H3M29 16h-2" stroke="#0a9396" stroke-width="1.5" stroke-linecap="round"/></svg>`;
        return new Response(svg, {
          headers: { 'Content-Type': 'image/svg+xml', 'Cache-Control': 'public, max-age=86400' },
        });
      }

      // Test UI — only serve index.html (single-file UI, no arbitrary file serving)
      if (url.pathname === '/' || url.pathname === '/test-ui' || url.pathname === '/test-ui/') {
        try {
          const content = readFileSync(join(TEST_UI_DIR, 'index.html'), 'utf-8');
          return new Response(content, {
            headers: { 'Content-Type': 'text/html', 'Cache-Control': 'no-store' },
          });
        } catch {
          return new Response('Not Found', { status: 404 });
        }
      }

      return new Response('Not Found', { status: 404 });
    },

    websocket: {
      // Bun's default is 120s. Increase to tolerate Android process suspension
      // when the screen is locked — OkHttp pings stop during suspension, so
      // the server sees idle silence. 480s (8 min) is generous enough that
      // brief lock-screen periods won't trigger a disconnect.
      idleTimeout: 480,

      open(ws) {
        if (ws.data.authenticated) {
          initSession(ws, ws.data.userId, ws.data.defaultChannel);
          console.log(
            `[voice] Client connected: userId=${ws.data.userId} channel=${ws.data.defaultChannel}`,
          );
        } else {
          console.log('[voice] Client connected, awaiting auth message');
        }
      },

      message(ws, raw) {
        // Handle first-message auth for unauthenticated connections (browser clients)
        if (!ws.data.authenticated) {
          if (isRateLimited()) {
            ws.send(
              serializeServerMessage({
                type: 'error',
                requestId: null,
                message: 'Too many failed auth attempts',
              }),
            );
            ws.close(4002, 'Rate limited');
            return;
          }
          const data = typeof raw === 'string' ? raw : raw.toString('utf-8');
          try {
            const msg = parseClientMessage(data);
            if (msg.type !== 'auth') {
              ws.send(
                serializeServerMessage({
                  type: 'error',
                  requestId: null,
                  message: 'Authentication required: send {"type":"auth","token":"..."} first',
                }),
              );
              ws.close(4001, 'Authentication required');
              return;
            }
            const freshConfig = loadConfig();
            const tokenConfig = resolveVoiceToken(freshConfig, msg.token);
            if (!tokenConfig) {
              recordAuthFailure();
              ws.send(
                serializeServerMessage({
                  type: 'error',
                  requestId: null,
                  message: 'Invalid token',
                }),
              );
              ws.close(4001, 'Invalid token');
              return;
            }
            clearAuthFailures();
            ws.data.userId = tokenConfig.userId;
            ws.data.defaultChannel = tokenConfig.defaultChannel;
            ws.data.authenticated = true;
            initSession(ws, tokenConfig.userId, tokenConfig.defaultChannel);
            console.log(
              `[voice] Client authenticated: userId=${tokenConfig.userId} channel=${tokenConfig.defaultChannel}`,
            );
            ws.send(serializeServerMessage({ type: 'pong' }));
            return;
          } catch {
            ws.send(
              serializeServerMessage({
                type: 'error',
                requestId: null,
                message: 'Invalid auth message',
              }),
            );
            ws.close(4001, 'Invalid auth message');
            return;
          }
        }
        handleMessage(ws, raw, voiceProvider, ttsOptions);
      },

      close(ws) {
        console.log(`[voice] Client disconnected: userId=${ws.data.userId}`);
        handleClose(ws);
      },

      drain() {
        // Back-pressure relief — no action needed
      },
    },
  });

  console.log(`[voice] WebSocket server listening on port ${port}`);
  if (cfg.voice) {
    const ttsModel = cfg.voice.deepgram.ttsModel ?? 'aura-2-thalia-en';
    const ttsSampleRate = cfg.voice.deepgram.ttsSampleRate ?? 24000;
    console.log(
      `[voice] Voice provider: ${cfg.voice.provider} (STT: ${cfg.voice.deepgram.sttModel ?? 'nova-3'}, TTS: ${ttsModel}@${ttsSampleRate}Hz)`,
    );
  }
}

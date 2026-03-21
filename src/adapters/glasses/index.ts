import { readFileSync } from 'fs';
import { join, resolve } from 'path';
import { loadConfig, resolveGlassesToken, interpolateEnvVars, type Config } from '../../config.js';
import { initSession, handleMessage, handleClose } from './handler.js';
import type { VoiceProvider } from '../../core/voice.js';
import { DeepgramVoiceProvider } from '../../core/voice-deepgram.js';

export interface WsData {
  userId: string;
  defaultChannel: string;
}

const TEST_UI_DIR = resolve(import.meta.dir, 'test-ui');

/** Create VoiceProvider from config. Returns undefined if voice not configured. */
function createVoiceProvider(cfg: Config): VoiceProvider | undefined {
  if (!cfg.voice) return undefined;

  const apiKey = interpolateEnvVars(cfg.voice.deepgram.apiKey);
  const sttModel = cfg.voice.deepgram.sttModel ?? 'nova-3';
  return new DeepgramVoiceProvider(apiKey, sttModel);
}

export function startGlassesAdapter(config?: Config): void {
  const cfg = config ?? loadConfig();
  const serverConfig = cfg.glassesServer;
  if (!serverConfig?.enabled) return;

  // Voice config required when glasses adapter is enabled (Phase 2+)
  if (!cfg.voice) {
    throw new Error(
      '[glasses] Cannot start: voice config is required when glassesServer is enabled. ' +
        'Add a "voice" section to config.yaml with provider and API key.',
    );
  }
  const voiceProvider = createVoiceProvider(cfg)!;
  const port = serverConfig.port;

  Bun.serve<WsData>({
    port,

    fetch(req, server) {
      const url = new URL(req.url);

      // WebSocket upgrade
      if (url.pathname === '/ws') {
        // Extract auth token from query param or Authorization header
        const tokenFromQuery = url.searchParams.get('token');
        const authHeader = req.headers.get('authorization');
        const tokenFromHeader = authHeader?.startsWith('Bearer ') ? authHeader.slice(7) : null;
        const rawToken = tokenFromQuery ?? tokenFromHeader;

        if (!rawToken) {
          return new Response('Unauthorized: missing token', { status: 401 });
        }

        // Re-load config for hot-reload of tokens
        const freshConfig = loadConfig();
        const tokenConfig = resolveGlassesToken(freshConfig, rawToken);
        if (!tokenConfig) {
          return new Response('Unauthorized: invalid token', { status: 401 });
        }

        const upgraded = server.upgrade(req, {
          data: {
            userId: tokenConfig.userId,
            defaultChannel: tokenConfig.defaultChannel,
          } satisfies WsData,
        });

        if (!upgraded) {
          return new Response('WebSocket upgrade failed', { status: 500 });
        }
        return undefined;
      }

      // Favicon — inline SVG glasses icon
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
      open(ws) {
        initSession(ws, ws.data.userId, ws.data.defaultChannel);
        console.log(
          `[glasses] Client connected: userId=${ws.data.userId} channel=${ws.data.defaultChannel}`,
        );
      },

      message(ws, raw) {
        handleMessage(ws, raw, voiceProvider);
      },

      close(ws) {
        console.log(`[glasses] Client disconnected: userId=${ws.data.userId}`);
        handleClose(ws);
      },

      drain() {
        // Back-pressure relief — no action needed
      },
    },
  });

  console.log(`[glasses] WebSocket server listening on port ${port}`);
  if (cfg.voice) {
    console.log(
      `[glasses] Voice provider: ${cfg.voice.provider} (${cfg.voice.deepgram.sttModel ?? 'nova-3'})`,
    );
  }
}

import { readFileSync } from 'fs';
import { join, resolve } from 'path';
import { loadConfig, resolveGlassesToken, type Config } from '../../config.js';
import { initSession, handleMessage, handleClose } from './handler.js';

export interface WsData {
  userId: string;
  defaultChannel: string;
}

const TEST_UI_DIR = resolve(import.meta.dir, 'test-ui');

export function startGlassesAdapter(config?: Config): void {
  const cfg = config ?? loadConfig();
  const serverConfig = cfg.glassesServer;
  if (!serverConfig?.enabled) return;

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

      // Test UI — only serve index.html (single-file UI, no arbitrary file serving)
      if (url.pathname === '/' || url.pathname === '/test-ui' || url.pathname === '/test-ui/') {
        try {
          const content = readFileSync(join(TEST_UI_DIR, 'index.html'), 'utf-8');
          return new Response(content, {
            headers: { 'Content-Type': 'text/html' },
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
        handleMessage(ws, raw);
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
}

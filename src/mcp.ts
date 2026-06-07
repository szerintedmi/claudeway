import { readFileSync, writeFileSync, renameSync, existsSync, statSync } from 'fs';
import { resolve, dirname, join } from 'path';
import type { UserPermissions } from './config.js';

interface McpServerEntry {
  type?: string;
  env?: Record<string, string>;
  [key: string]: unknown;
}

interface McpConfig {
  mcpServers: Record<string, McpServerEntry>;
}

/**
 * Generate a read-only MCP config from an existing mcp.json.
 * Injects READ_ONLY_MODE: "true" into each stdio server's env.
 *
 * Only stdio servers spawn a local process that can read env vars, so the flag
 * is skipped for http/sse servers where `env` is inert — injecting it there
 * would just be confusing no-op noise.
 */
export function generateReadOnlyMcpConfig(sourcePath: string): string {
  const raw = readFileSync(sourcePath, 'utf-8');
  const config = JSON.parse(raw) as McpConfig;

  if (config.mcpServers) {
    for (const server of Object.values(config.mcpServers)) {
      // Default (no type) is stdio; http/sse have no subprocess to receive env.
      const isStdio = server.type === undefined || server.type === 'stdio';
      if (isStdio) {
        server.env = { ...server.env, READ_ONLY_MODE: 'true' };
      }
    }
  }

  const destPath = readOnlyMcpConfigPath(sourcePath);
  const tmpPath = destPath + '.tmp';
  writeFileSync(tmpPath, JSON.stringify(config, null, 2), 'utf-8');
  renameSync(tmpPath, destPath);
  return destPath;
}

/**
 * Returns the path for mcp-readonly.json alongside the given mcp.json path.
 */
export function readOnlyMcpConfigPath(mcpPath: string): string {
  return join(dirname(mcpPath), 'mcp-readonly.json');
}

/**
 * Get the appropriate MCP config path based on user permissions.
 * Returns null if no MCP config file exists.
 */
export function getMcpConfigPath(
  permissions: UserPermissions | undefined,
  cwd: string,
): string | null {
  const jiraWrite = permissions?.has('jiraWrite') ?? true;
  const fullPath = resolve(cwd, 'mcp.json');
  const readonlyPath = resolve(cwd, 'mcp-readonly.json');

  if (!jiraWrite) {
    // Non-jiraWrite user: only use the read-only config, or no MCP at all.
    // Never fall back to full mcp.json — that would grant write access.
    if (existsSync(readonlyPath) && statSync(readonlyPath).isFile()) {
      return readonlyPath;
    }
    return null;
  }
  if (existsSync(fullPath) && statSync(fullPath).isFile()) {
    return fullPath;
  }
  return null;
}

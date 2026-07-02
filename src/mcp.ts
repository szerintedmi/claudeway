import { readFileSync, writeFileSync, renameSync, existsSync, statSync } from 'fs';
import { createHash } from 'crypto';
import { resolve, dirname, join } from 'path';

interface McpServerEntry {
  type?: string;
  env?: Record<string, string>;
  [key: string]: unknown;
}

interface McpConfig {
  mcpServers: Record<string, McpServerEntry>;
}

/**
 * Generate an MCP config from an existing mcp.json with READ_ONLY_MODE: "true"
 * injected into the named servers' env. Used when a credential guarding MCP
 * write access resolved to the shared default or nothing — Atlassian API
 * tokens can't be scoped down, so the shared token is full-access at the
 * provider and read-only has to be enforced at the MCP tool layer instead.
 *
 * Only the servers named in `serverNames` are touched: READ_ONLY_MODE is a
 * per-server convention (mcp-atlassian honors it), not a generic MCP flag.
 */
export function generateReadOnlyMcpConfig(sourcePath: string, serverNames: string[]): string {
  const raw = readFileSync(sourcePath, 'utf-8');
  const config = JSON.parse(raw) as McpConfig;

  for (const name of serverNames) {
    const server = config.mcpServers?.[name];
    if (!server) {
      console.warn(`[mcp] read-only server "${name}" not found in ${sourcePath} — skipping`);
      continue;
    }
    // Default (no type) is stdio; http/sse have no subprocess to receive env.
    const isStdio = server.type === undefined || server.type === 'stdio';
    if (!isStdio) {
      console.warn(
        `[mcp] read-only server "${name}" has type "${server.type}" — READ_ONLY_MODE only reaches stdio servers, skipping`,
      );
      continue;
    }
    server.env = { ...server.env, READ_ONLY_MODE: 'true' };
  }

  const destPath = readOnlyMcpConfigPath(sourcePath, serverNames);
  const tmpPath = destPath + '.tmp';
  writeFileSync(tmpPath, JSON.stringify(config, null, 2), 'utf-8');
  renameSync(tmpPath, destPath);
  return destPath;
}

/**
 * Path for the generated read-only variant, alongside the source mcp.json.
 * The filename embeds a hash of the server set so concurrent spawns with
 * different read-only sets never clobber each other's config.
 */
export function readOnlyMcpConfigPath(mcpPath: string, serverNames: string[]): string {
  const hash = createHash('sha256')
    .update(JSON.stringify([...serverNames].sort()))
    .digest('hex')
    .slice(0, 8);
  return join(dirname(mcpPath), `mcp-readonly-${hash}.json`);
}

/**
 * Resolve the MCP config path for a spawn.
 *
 * `readOnlyServers` names the servers that must run in read-only mode for this
 * user (credentials with `mcpReadOnlyServers` that resolved to the shared
 * default or unset). Empty → plain mcp.json. Non-empty → a generated variant
 * with READ_ONLY_MODE injected, regenerated per spawn so config hot-reload and
 * mcp.json edits are picked up.
 */
export function getMcpConfigPath(readOnlyServers: string[], cwd: string): string | null {
  const fullPath = resolve(cwd, 'mcp.json');

  if (!existsSync(fullPath) || !statSync(fullPath).isFile()) {
    return null;
  }
  if (readOnlyServers.length === 0) {
    return fullPath;
  }
  return generateReadOnlyMcpConfig(fullPath, readOnlyServers);
}

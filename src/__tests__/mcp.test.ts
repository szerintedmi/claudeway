import { mkdtempSync, writeFileSync, readFileSync, rmSync, existsSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { generateReadOnlyMcpConfig, readOnlyMcpConfigPath, getMcpConfigPath } from '../mcp.js';

describe('generateReadOnlyMcpConfig', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'mcp-test-'));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('injects READ_ONLY_MODE into each server env', () => {
    const mcpPath = join(tmpDir, 'mcp.json');
    writeFileSync(
      mcpPath,
      JSON.stringify({
        mcpServers: {
          atlassian: {
            type: 'stdio',
            command: 'npx',
            args: ['mcp-atlassian'],
            env: { JIRA_URL: 'https://jira.example.com' },
          },
        },
      }),
    );

    generateReadOnlyMcpConfig(mcpPath);

    const readonlyPath = join(tmpDir, 'mcp-readonly.json');
    expect(existsSync(readonlyPath)).toBe(true);

    const config = JSON.parse(readFileSync(readonlyPath, 'utf-8'));
    expect(config.mcpServers.atlassian.env).toEqual({
      JIRA_URL: 'https://jira.example.com',
      READ_ONLY_MODE: 'true',
    });
  });

  it('creates env object when server has no env', () => {
    const mcpPath = join(tmpDir, 'mcp.json');
    writeFileSync(
      mcpPath,
      JSON.stringify({
        mcpServers: {
          simple: { type: 'stdio', command: 'echo' },
        },
      }),
    );

    generateReadOnlyMcpConfig(mcpPath);

    const readonlyPath = join(tmpDir, 'mcp-readonly.json');
    const config = JSON.parse(readFileSync(readonlyPath, 'utf-8'));
    expect(config.mcpServers.simple.env).toEqual({ READ_ONLY_MODE: 'true' });
  });

  it('handles multiple servers', () => {
    const mcpPath = join(tmpDir, 'mcp.json');
    writeFileSync(
      mcpPath,
      JSON.stringify({
        mcpServers: {
          server1: { type: 'stdio', command: 'a', env: { FOO: 'bar' } },
          server2: { type: 'stdio', command: 'b' },
        },
      }),
    );

    generateReadOnlyMcpConfig(mcpPath);

    const config = JSON.parse(readFileSync(join(tmpDir, 'mcp-readonly.json'), 'utf-8'));
    expect(config.mcpServers.server1.env.READ_ONLY_MODE).toBe('true');
    expect(config.mcpServers.server1.env.FOO).toBe('bar');
    expect(config.mcpServers.server2.env.READ_ONLY_MODE).toBe('true');
  });

  it('skips READ_ONLY_MODE for http/sse servers (no subprocess to read env)', () => {
    const mcpPath = join(tmpDir, 'mcp.json');
    writeFileSync(
      mcpPath,
      JSON.stringify({
        mcpServers: {
          stdioServer: { type: 'stdio', command: 'a' },
          httpServer: {
            type: 'http',
            url: 'https://mcp.example.com/mcp/',
            headers: { 'Api-Key': '${SOME_KEY}' },
          },
          sseServer: { type: 'sse', url: 'https://sse.example.com/' },
        },
      }),
    );

    generateReadOnlyMcpConfig(mcpPath);

    const config = JSON.parse(readFileSync(join(tmpDir, 'mcp-readonly.json'), 'utf-8'));
    expect(config.mcpServers.stdioServer.env).toEqual({ READ_ONLY_MODE: 'true' });
    // http/sse entries left untouched — no env injected
    expect(config.mcpServers.httpServer.env).toBeUndefined();
    expect(config.mcpServers.httpServer.headers).toEqual({ 'Api-Key': '${SOME_KEY}' });
    expect(config.mcpServers.sseServer.env).toBeUndefined();
  });

  it('preserves non-env fields', () => {
    const mcpPath = join(tmpDir, 'mcp.json');
    writeFileSync(
      mcpPath,
      JSON.stringify({
        mcpServers: {
          test: { type: 'stdio', command: 'npx', args: ['@test/plugin'] },
        },
      }),
    );

    generateReadOnlyMcpConfig(mcpPath);

    const config = JSON.parse(readFileSync(join(tmpDir, 'mcp-readonly.json'), 'utf-8'));
    expect(config.mcpServers.test.type).toBe('stdio');
    expect(config.mcpServers.test.command).toBe('npx');
    expect(config.mcpServers.test.args).toEqual(['@test/plugin']);
  });
});

describe('readOnlyMcpConfigPath', () => {
  it('returns mcp-readonly.json alongside the source', () => {
    expect(readOnlyMcpConfigPath('/path/to/mcp.json')).toBe('/path/to/mcp-readonly.json');
  });
});

describe('getMcpConfigPath', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'mcp-path-test-'));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('returns mcp.json when jiraWrite is granted', () => {
    writeFileSync(join(tmpDir, 'mcp.json'), '{}');
    writeFileSync(join(tmpDir, 'mcp-readonly.json'), '{}');
    expect(getMcpConfigPath(new Set(['git', 'jiraWrite']), tmpDir)).toBe(join(tmpDir, 'mcp.json'));
  });

  it('returns mcp-readonly.json when jiraWrite is not granted and file exists', () => {
    writeFileSync(join(tmpDir, 'mcp.json'), '{}');
    writeFileSync(join(tmpDir, 'mcp-readonly.json'), '{}');
    expect(getMcpConfigPath(new Set(), tmpDir)).toBe(join(tmpDir, 'mcp-readonly.json'));
  });

  it('returns null when jiraWrite is not granted and readonly does not exist', () => {
    writeFileSync(join(tmpDir, 'mcp.json'), '{}');
    expect(getMcpConfigPath(new Set(), tmpDir)).toBeNull();
  });

  it('returns null when no MCP config exists', () => {
    expect(getMcpConfigPath(new Set(['git', 'jiraWrite']), tmpDir)).toBeNull();
  });

  it('returns mcp.json for undefined permissions (full access default)', () => {
    writeFileSync(join(tmpDir, 'mcp.json'), '{}');
    expect(getMcpConfigPath(undefined, tmpDir)).toBe(join(tmpDir, 'mcp.json'));
  });
});

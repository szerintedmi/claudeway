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

  it('returns mcp.json when jiraWrite is true', () => {
    writeFileSync(join(tmpDir, 'mcp.json'), '{}');
    writeFileSync(join(tmpDir, 'mcp-readonly.json'), '{}');
    expect(getMcpConfigPath({ git: true, jiraWrite: true }, tmpDir)).toBe(join(tmpDir, 'mcp.json'));
  });

  it('returns mcp-readonly.json when jiraWrite is false and file exists', () => {
    writeFileSync(join(tmpDir, 'mcp.json'), '{}');
    writeFileSync(join(tmpDir, 'mcp-readonly.json'), '{}');
    expect(getMcpConfigPath({ git: false, jiraWrite: false }, tmpDir)).toBe(
      join(tmpDir, 'mcp-readonly.json'),
    );
  });

  it('returns null when jiraWrite is false and readonly does not exist', () => {
    writeFileSync(join(tmpDir, 'mcp.json'), '{}');
    expect(getMcpConfigPath({ git: false, jiraWrite: false }, tmpDir)).toBeNull();
  });

  it('returns null when no MCP config exists', () => {
    expect(getMcpConfigPath({ git: true, jiraWrite: true }, tmpDir)).toBeNull();
  });

  it('returns mcp.json for undefined permissions (full access default)', () => {
    writeFileSync(join(tmpDir, 'mcp.json'), '{}');
    expect(getMcpConfigPath(undefined, tmpDir)).toBe(join(tmpDir, 'mcp.json'));
  });
});

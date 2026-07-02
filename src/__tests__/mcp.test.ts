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

  it('injects READ_ONLY_MODE only into the named servers', () => {
    const mcpPath = join(tmpDir, 'mcp.json');
    writeFileSync(
      mcpPath,
      JSON.stringify({
        mcpServers: {
          'mcp-atlassian': {
            type: 'stdio',
            command: 'uvx',
            args: ['mcp-atlassian'],
            env: { JIRA_URL: 'https://jira.example.com' },
          },
          other: { type: 'stdio', command: 'npx', env: { FOO: 'bar' } },
        },
      }),
    );

    const destPath = generateReadOnlyMcpConfig(mcpPath, ['mcp-atlassian']);

    expect(existsSync(destPath)).toBe(true);
    const config = JSON.parse(readFileSync(destPath, 'utf-8'));
    expect(config.mcpServers['mcp-atlassian'].env).toEqual({
      JIRA_URL: 'https://jira.example.com',
      READ_ONLY_MODE: 'true',
    });
    // Unlisted servers are left untouched
    expect(config.mcpServers.other.env).toEqual({ FOO: 'bar' });
  });

  it('creates env object when the named server has no env', () => {
    const mcpPath = join(tmpDir, 'mcp.json');
    writeFileSync(
      mcpPath,
      JSON.stringify({
        mcpServers: {
          simple: { type: 'stdio', command: 'echo' },
        },
      }),
    );

    const destPath = generateReadOnlyMcpConfig(mcpPath, ['simple']);

    const config = JSON.parse(readFileSync(destPath, 'utf-8'));
    expect(config.mcpServers.simple.env).toEqual({ READ_ONLY_MODE: 'true' });
  });

  it('treats servers without a type as stdio', () => {
    const mcpPath = join(tmpDir, 'mcp.json');
    writeFileSync(mcpPath, JSON.stringify({ mcpServers: { untyped: { command: 'echo' } } }));

    const destPath = generateReadOnlyMcpConfig(mcpPath, ['untyped']);

    const config = JSON.parse(readFileSync(destPath, 'utf-8'));
    expect(config.mcpServers.untyped.env).toEqual({ READ_ONLY_MODE: 'true' });
  });

  it('skips named http/sse servers (no subprocess to read env)', () => {
    const mcpPath = join(tmpDir, 'mcp.json');
    writeFileSync(
      mcpPath,
      JSON.stringify({
        mcpServers: {
          httpServer: {
            type: 'http',
            url: 'https://mcp.example.com/mcp/',
            headers: { 'Api-Key': '${SOME_KEY}' },
          },
        },
      }),
    );

    const destPath = generateReadOnlyMcpConfig(mcpPath, ['httpServer']);

    const config = JSON.parse(readFileSync(destPath, 'utf-8'));
    expect(config.mcpServers.httpServer.env).toBeUndefined();
    expect(config.mcpServers.httpServer.headers).toEqual({ 'Api-Key': '${SOME_KEY}' });
  });

  it('skips names not present in the config without failing', () => {
    const mcpPath = join(tmpDir, 'mcp.json');
    writeFileSync(mcpPath, JSON.stringify({ mcpServers: { real: { command: 'a' } } }));

    const destPath = generateReadOnlyMcpConfig(mcpPath, ['missing', 'real']);

    const config = JSON.parse(readFileSync(destPath, 'utf-8'));
    expect(config.mcpServers.real.env).toEqual({ READ_ONLY_MODE: 'true' });
    expect(config.mcpServers.missing).toBeUndefined();
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

    const destPath = generateReadOnlyMcpConfig(mcpPath, ['test']);

    const config = JSON.parse(readFileSync(destPath, 'utf-8'));
    expect(config.mcpServers.test.type).toBe('stdio');
    expect(config.mcpServers.test.command).toBe('npx');
    expect(config.mcpServers.test.args).toEqual(['@test/plugin']);
  });
});

describe('readOnlyMcpConfigPath', () => {
  it('returns a hashed mcp-readonly path alongside the source', () => {
    const p = readOnlyMcpConfigPath('/path/to/mcp.json', ['mcp-atlassian']);
    expect(p).toMatch(/^\/path\/to\/mcp-readonly-[0-9a-f]{8}\.json$/);
  });

  it('is stable across server-name ordering', () => {
    expect(readOnlyMcpConfigPath('/x/mcp.json', ['a', 'b'])).toBe(
      readOnlyMcpConfigPath('/x/mcp.json', ['b', 'a']),
    );
  });

  it('differs for different server sets', () => {
    expect(readOnlyMcpConfigPath('/x/mcp.json', ['a'])).not.toBe(
      readOnlyMcpConfigPath('/x/mcp.json', ['b']),
    );
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

  it('returns mcp.json when no servers need read-only mode', () => {
    writeFileSync(join(tmpDir, 'mcp.json'), '{}');
    expect(getMcpConfigPath([], tmpDir)).toBe(join(tmpDir, 'mcp.json'));
  });

  it('generates and returns a read-only config when servers are listed', () => {
    writeFileSync(
      join(tmpDir, 'mcp.json'),
      JSON.stringify({ mcpServers: { 'mcp-atlassian': { command: 'uvx' } } }),
    );

    const path = getMcpConfigPath(['mcp-atlassian'], tmpDir);

    expect(path).toBe(readOnlyMcpConfigPath(join(tmpDir, 'mcp.json'), ['mcp-atlassian']));
    const config = JSON.parse(readFileSync(path!, 'utf-8'));
    expect(config.mcpServers['mcp-atlassian'].env.READ_ONLY_MODE).toBe('true');
  });

  it('regenerates the read-only config from the current mcp.json', () => {
    const mcpPath = join(tmpDir, 'mcp.json');
    writeFileSync(mcpPath, JSON.stringify({ mcpServers: { s: { command: 'a' } } }));
    getMcpConfigPath(['s'], tmpDir);

    // mcp.json edited between spawns — the generated variant must follow
    writeFileSync(
      mcpPath,
      JSON.stringify({ mcpServers: { s: { command: 'a', env: { NEW: 'yes' } } } }),
    );
    const path = getMcpConfigPath(['s'], tmpDir);

    const config = JSON.parse(readFileSync(path!, 'utf-8'));
    expect(config.mcpServers.s.env).toEqual({ NEW: 'yes', READ_ONLY_MODE: 'true' });
  });

  it('returns null when no MCP config exists', () => {
    expect(getMcpConfigPath([], tmpDir)).toBeNull();
    expect(getMcpConfigPath(['mcp-atlassian'], tmpDir)).toBeNull();
  });
});

import {
  deriveSessionId,
  sessionArtifactPaths,
  buildClaudeArgs,
  type ClaudeOptions,
} from '../claude.js';
import type { Config, UserPermissions } from '../config.js';

describe('deriveSessionId', () => {
  it('returns a UUID-format string', () => {
    const id = deriveSessionId('C001', '/projects/foo');
    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
  });

  it('is deterministic — same inputs produce the same ID', () => {
    const a = deriveSessionId('C001', '/projects/foo');
    const b = deriveSessionId('C001', '/projects/foo');
    expect(a).toBe(b);
  });

  it('produces different IDs for different channelIds', () => {
    expect(deriveSessionId('C001', '/projects/foo')).not.toBe(
      deriveSessionId('C002', '/projects/foo'),
    );
  });

  it('produces different IDs for different folders', () => {
    expect(deriveSessionId('C001', '/projects/foo')).not.toBe(
      deriveSessionId('C001', '/projects/bar'),
    );
  });

  it('is stable — known input produces known output (regression guard)', () => {
    // If this breaks, the namespace constant or hash logic changed
    const id = deriveSessionId('C0AHAGEQY8Y', '/Users/tamas/dev/ktamas77/claudeway');
    expect(id).toBe('808dcec8-994d-5b57-8aa6-c6beeaf1fd39');
  });

  it('without threadTs matches legacy behavior (no threadTs = same as before)', () => {
    const withUndefined = deriveSessionId('C001', '/projects/foo', undefined);
    const withoutArg = deriveSessionId('C001', '/projects/foo');
    expect(withUndefined).toBe(withoutArg);
  });

  it('produces different IDs for different threadTs values', () => {
    const a = deriveSessionId('C001', '/projects/foo', '1700000000.000100');
    const b = deriveSessionId('C001', '/projects/foo', '1700000000.000200');
    expect(a).not.toBe(b);
  });

  it('with threadTs differs from without threadTs', () => {
    const withThread = deriveSessionId('C001', '/projects/foo', '1700000000.000100');
    const withoutThread = deriveSessionId('C001', '/projects/foo');
    expect(withThread).not.toBe(withoutThread);
  });

  it('same threadTs is deterministic', () => {
    const a = deriveSessionId('C001', '/projects/foo', '1700000000.000100');
    const b = deriveSessionId('C001', '/projects/foo', '1700000000.000100');
    expect(a).toBe(b);
  });
});

describe('buildClaudeArgs — leading-dash prompt safety', () => {
  const options: ClaudeOptions = {
    message: '--- Slack context ---\n[122.456 <@U2> Ann]: earlier\n\n[123.456 <@U1> Peter]: hi',
    cwd: '/tmp',
    model: 'test-model',
    systemPrompt: 'sp',
    timeoutMs: 1000,
    channelId: 'C0TEST',
    config: {} as Config,
    userPermissions: {} as UserPermissions,
    userId: 'U1',
  };

  it('terminates option parsing with -- before the positional message', () => {
    const { args } = buildClaudeArgs(options, 'json');
    expect(args[args.length - 1]).toBe(options.message);
    expect(args[args.length - 2]).toBe('--');
  });

  it('keeps the message as the single arg after the separator', () => {
    const { args } = buildClaudeArgs(options, 'stream-json');
    expect(args.indexOf('--')).toBe(args.length - 2);
  });
});

describe('sessionArtifactPaths — path encoding', () => {
  const HOME = '/Users/testuser';

  beforeEach(() => {
    process.env.HOME = HOME;
  });

  it('encodes / as - in the folder path (keeping the leading dash)', () => {
    const paths = sessionArtifactPaths('abc-123', '/Users/foo/bar');
    expect(paths.jsonl).toContain('-Users-foo-bar');
  });

  it('constructs correct .jsonl path', () => {
    const paths = sessionArtifactPaths('my-session', '/projects/test');
    expect(paths.jsonl).toBe(`${HOME}/.claude/projects/-projects-test/my-session.jsonl`);
  });

  it('constructs correct session directory path', () => {
    const paths = sessionArtifactPaths('my-session', '/projects/test');
    expect(paths.dir).toBe(`${HOME}/.claude/projects/-projects-test/my-session`);
  });

  it('constructs correct todo file path', () => {
    const paths = sessionArtifactPaths('my-session', '/projects/test');
    expect(paths.todo).toBe(`${HOME}/.claude/todos/my-session-agent-my-session.json`);
  });

  it('uses HOME env var', () => {
    process.env.HOME = '/custom/home';
    const paths = sessionArtifactPaths('s', '/p');
    expect(paths.jsonl).toMatch(/^\/custom\/home/);
  });
});

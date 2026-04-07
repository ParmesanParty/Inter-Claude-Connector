import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { detectMode, buildHooksTemplate, type HostMode } from '../src/setup-config.ts';
import type { ICCConfig } from '../src/types.ts';

function baseConfig(serverOverrides: Partial<ICCConfig['server']> = {}): ICCConfig {
  return {
    identity: 'test-host',
    instance: null,
    server: {
      port: 3179,
      host: '127.0.0.1',
      localToken: 'tok',
      peerTokens: {},
      tls: { enabled: false, certPath: null, keyPath: null, caPath: null },
      enrollPort: 4179,
      ...serverOverrides,
    },
    remotes: {},
    web: { host: '127.0.0.1', port: 3180 },
    tls: { ca: null },
    transport: { httpTimeout: 5000, healthCheckInterval: 30000 },
    security: {
      readfileEnabled: false,
      execEnabled: false,
      allowedPaths: [],
      allowedCommands: [],
      allowedSubcommands: {},
      maxExecTimeout: 30000,
    },
    claude: {
      outputFormat: 'text',
      noSessionPersistence: false,
      permissionMode: 'default',
      maxBudgetUsd: null,
      systemPromptAppend: null,
    } as ICCConfig['claude'],
  };
}

describe('setup-config: detectMode', () => {
  it('returns "docker" when localhostHttpPort is set', () => {
    const config = baseConfig({ localhostHttpPort: 3178 });
    const mode: HostMode = detectMode(config);
    assert.equal(mode, 'docker');
  });

  it('returns "bare-metal" when localhostHttpPort is not set', () => {
    assert.equal(detectMode(baseConfig()), 'bare-metal');
  });

  it('returns "bare-metal" when localhostHttpPort is explicitly null', () => {
    assert.equal(detectMode(baseConfig({ localhostHttpPort: null })), 'bare-metal');
  });
});

describe('setup-config: buildHooksTemplate (Docker mode)', () => {
  function dockerConfig() {
    return baseConfig({ localhostHttpPort: 3178, localToken: 'docker-tok' });
  }

  it('emits curl commands targeting localhost:3178 with Bearer auth', () => {
    const tpl = buildHooksTemplate(dockerConfig());
    const startupCmd = tpl.config.SessionStart.find((e: any) => e.matcher === 'startup')!.hooks[0]!.command;
    assert.match(startupCmd, /curl/);
    assert.match(startupCmd, /Authorization: Bearer docker-tok/);
    assert.match(startupCmd, /http:\/\/localhost:3178\/api\/hook\/startup/);
  });

  it('SessionStart startup/resume/clear include Plan C health pre-check guard', () => {
    const tpl = buildHooksTemplate(dockerConfig());
    for (const matcher of ['startup', 'resume', 'clear']) {
      const cmd: string = tpl.config.SessionStart.find((e: any) => e.matcher === matcher)!.hooks[0]!.command;
      assert.ok(cmd.includes('/api/health'), `${matcher} must include /api/health pre-check`);
      assert.ok(
        cmd.includes('ICC: server not reachable. Run /mcp to reconnect, then /watch to activate.'),
        `${matcher} must include exact unreachable hint`
      );
      assert.ok(cmd.includes('exit 0'), `${matcher} must exit 0 on health failure`);
    }
  });

  it('compact matcher uses heartbeat (NOT health-guard) and reads session token', () => {
    const tpl = buildHooksTemplate(dockerConfig());
    const compactCmd: string = tpl.config.SessionStart.find((e: any) => e.matcher === 'compact')!.hooks[0]!.command;
    assert.match(compactCmd, /\/api\/hook\/heartbeat/);
    assert.match(compactCmd, /\/tmp\/icc-session-\$PPID\.token/);
    assert.ok(!compactCmd.includes('/api/health'), 'compact must NOT have a health guard (mid-session)');
  });

  it('PreToolUse Bash + mcp-icc-message stream stdin via cat | curl', () => {
    const tpl = buildHooksTemplate(dockerConfig());
    const bashCmd: string = tpl.config.PreToolUse.find((e: any) => e.matcher === 'Bash')!.hooks[0]!.command;
    const iccCmd: string = tpl.config.PreToolUse.find((e: any) => e.matcher === 'mcp__icc__send_message|mcp__icc__respond_to_message')!.hooks[0]!.command;
    assert.match(bashCmd, /cat \| curl/);
    assert.match(bashCmd, /\/api\/hook\/pre-bash/);
    assert.match(iccCmd, /cat \| curl/);
    assert.match(iccCmd, /\/api\/hook\/pre-icc-message/);
  });

  it('SessionEnd reads token file and rms it on exit', () => {
    const tpl = buildHooksTemplate(dockerConfig());
    const endCmd: string = tpl.config.SessionEnd[0]!.hooks[0]!.command;
    assert.match(endCmd, /\/api\/hook\/session-end/);
    assert.match(endCmd, /rm -f \/tmp\/icc-session-\$PPID\.token/);
  });
});

describe('setup-config: buildHooksTemplate (bare-metal mode)', () => {
  function bareConfig() {
    return baseConfig({ localToken: null });
  }

  it('emits "icc hook" commands without curl or Bearer', () => {
    const tpl = buildHooksTemplate(bareConfig());
    const startupCmd: string = tpl.config.SessionStart.find((e: any) => e.matcher === 'startup')!.hooks[0]!.command;
    assert.match(startupCmd, /^icc hook startup/);
    assert.ok(!startupCmd.includes('curl'), 'must not use curl');
    assert.ok(!startupCmd.includes('Bearer'), 'must not include Bearer header');
  });

  it('startup hook has 10s timeout', () => {
    const tpl = buildHooksTemplate(bareConfig());
    const startupHook = tpl.config.SessionStart.find((e: any) => e.matcher === 'startup')!.hooks[0]!;
    assert.equal(startupHook.timeout, 10);
  });

  it('compact matcher uses "icc hook check"', () => {
    const tpl = buildHooksTemplate(bareConfig());
    const compactCmd: string = tpl.config.SessionStart.find((e: any) => e.matcher === 'compact')!.hooks[0]!.command;
    assert.match(compactCmd, /^icc hook check/);
  });

  it('PreToolUse Bash uses "icc hook pre-bash" with 3s timeout', () => {
    const tpl = buildHooksTemplate(bareConfig());
    const bashEntry = tpl.config.PreToolUse.find((e: any) => e.matcher === 'Bash')!.hooks[0]!;
    assert.match(bashEntry.command, /^icc hook pre-bash/);
    assert.equal(bashEntry.timeout, 3);
  });
});

describe('setup-config: buildHooksTemplate (parity)', () => {
  it('both modes cover the same 4 hook categories', () => {
    const docker = buildHooksTemplate(baseConfig({ localhostHttpPort: 3178 }));
    const bare = buildHooksTemplate(baseConfig());
    const expected = ['SessionStart', 'UserPromptSubmit', 'PreToolUse', 'SessionEnd'].sort();
    assert.deepEqual(Object.keys(docker.config).sort(), expected);
    assert.deepEqual(Object.keys(bare.config).sort(), expected);
  });

  it('both modes have the same set of SessionStart matchers', () => {
    const docker = buildHooksTemplate(baseConfig({ localhostHttpPort: 3178 }));
    const bare = buildHooksTemplate(baseConfig());
    const dockerMatchers = docker.config.SessionStart.map((e: any) => e.matcher).sort();
    const bareMatchers = bare.config.SessionStart.map((e: any) => e.matcher).sort();
    assert.deepEqual(dockerMatchers, ['clear', 'compact', 'resume', 'startup']);
    assert.deepEqual(bareMatchers, ['clear', 'compact', 'resume', 'startup']);
  });
});

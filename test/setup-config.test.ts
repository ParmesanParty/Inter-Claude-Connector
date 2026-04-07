import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { detectMode, buildHooksTemplate, buildSkillsTemplate, canonicalJson, hashPayload, type HostMode } from '../src/setup-config.ts';
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

describe('setup-config: buildSkillsTemplate (Docker mode)', () => {
  function dockerConfig() {
    return baseConfig({ localhostHttpPort: 3178, localToken: 'docker-tok' });
  }

  it('emits watch + snooze + wake skills (no sync yet — that comes in B11/B13)', () => {
    const tpl = buildSkillsTemplate(dockerConfig());
    assert.ok(tpl.watch, 'watch skill required');
    assert.ok(tpl.snooze, 'snooze skill required');
    assert.ok(tpl.wake, 'wake skill required');
    assert.equal((tpl as any).sync, undefined, 'sync skill not added until B11/B13');
  });

  it('watch skill points at correct target path', () => {
    const tpl = buildSkillsTemplate(dockerConfig());
    assert.equal(tpl.watch.target, '~/.claude/skills/watch/SKILL.md');
  });

  it('watch skill content references curl + Bearer + localhost:3178', () => {
    const tpl = buildSkillsTemplate(dockerConfig());
    const content = tpl.watch.content;
    assert.match(content, /curl/);
    assert.match(content, /Authorization: Bearer docker-tok/);
    assert.match(content, /http:\/\/localhost:3178\/api\/hook\/watch/);
    assert.match(content, /http:\/\/localhost:3178\/api\/watch\?instance=/);
  });

  it('watch skill includes Plan C stale_token recovery branch in step 7', () => {
    const tpl = buildSkillsTemplate(dockerConfig());
    const content = tpl.watch.content;
    assert.ok(content.includes('stale_token'), 'must include stale_token recovery');
    assert.ok(content.includes('rm -f /tmp/icc-session-$PPID.token'), 'must delete stale token file');
    assert.ok(content.includes('re-run this skill from step 3'), 'must instruct re-register');
  });

  it('watch skill curl on watcher launch does NOT use -f (so 410 body reaches skill)', () => {
    const tpl = buildSkillsTemplate(dockerConfig());
    const content = tpl.watch.content;
    const watchLine = content.split('\n').find((l: string) => l.includes('/api/watch?instance='));
    assert.ok(watchLine, 'watch curl line must exist');
    assert.ok(!watchLine!.includes('-sf '), `watch line must use -s, not -sf: ${watchLine}`);
  });

  it('wake skill curl on watcher launch ALSO does NOT use -f (same reason)', () => {
    const tpl = buildSkillsTemplate(dockerConfig());
    const content = tpl.wake.content;
    const watchLine = content.split('\n').find((l: string) => l.includes('/api/watch?instance='));
    assert.ok(watchLine, 'wake curl line must exist');
    assert.ok(!watchLine!.includes('-sf '), `wake line must use -s, not -sf: ${watchLine}`);
  });

  it('snooze skill content references /api/hook/snooze', () => {
    const tpl = buildSkillsTemplate(dockerConfig());
    assert.match(tpl.snooze.content, /\/api\/hook\/snooze/);
    assert.match(tpl.snooze.content, /rm -f \/tmp\/icc-session-\$PPID\.token/);
  });

  it('all three skills have valid frontmatter (name + description + disable-model-invocation + user-invocable)', () => {
    const tpl = buildSkillsTemplate(dockerConfig());
    for (const name of ['watch', 'snooze', 'wake'] as const) {
      const content = tpl[name].content;
      assert.match(content, /^---\n/, `${name} must start with frontmatter`);
      assert.match(content, /^name: \S+/m, `${name} must have name field`);
      assert.match(content, /^description: /m, `${name} must have description field`);
      assert.match(content, /^disable-model-invocation: true/m, `${name} disable-model-invocation`);
      assert.match(content, /^user-invocable: true/m, `${name} user-invocable`);
    }
  });
});

describe('setup-config: buildSkillsTemplate (bare-metal mode)', () => {
  function bareConfig() {
    return baseConfig({ localToken: null });
  }

  it('emits watch + snooze + wake skills', () => {
    const tpl = buildSkillsTemplate(bareConfig());
    assert.ok(tpl.watch && tpl.snooze && tpl.wake);
  });

  it('watch skill uses "icc hook watch" not curl', () => {
    const tpl = buildSkillsTemplate(bareConfig());
    const content = tpl.watch.content;
    assert.match(content, /icc hook watch/);
    assert.ok(!content.includes('curl'), 'must not use curl');
    assert.ok(!content.includes('Bearer'), 'must not include Bearer header');
    assert.ok(!content.includes('/tmp/icc-session-$PPID.token'), 'bare-metal does not use the docker session token file');
  });

  it('snooze skill uses "icc hook snooze-watcher"', () => {
    const tpl = buildSkillsTemplate(bareConfig());
    assert.match(tpl.snooze.content, /icc hook snooze-watcher/);
  });

  it('wake skill uses "icc hook wake-watcher"', () => {
    const tpl = buildSkillsTemplate(bareConfig());
    assert.match(tpl.wake.content, /icc hook wake-watcher/);
  });
});

describe('setup-config: canonicalJson', () => {
  it('serializes primitives like JSON.stringify', () => {
    assert.equal(canonicalJson(null), 'null');
    assert.equal(canonicalJson(42), '42');
    assert.equal(canonicalJson('hi'), '"hi"');
    assert.equal(canonicalJson(true), 'true');
  });

  it('sorts object keys recursively', () => {
    assert.equal(canonicalJson({ b: 1, a: 2 }), '{"a":2,"b":1}');
    assert.equal(canonicalJson({ z: { y: 1, x: 2 }, a: 3 }), '{"a":3,"z":{"x":2,"y":1}}');
  });

  it('preserves array order', () => {
    assert.equal(canonicalJson([3, 1, 2]), '[3,1,2]');
  });

  it('produces identical output for equal-but-differently-ordered objects', () => {
    const a = { foo: 1, bar: { x: 1, y: 2 }, baz: [1, 2, 3] };
    const b = { baz: [1, 2, 3], bar: { y: 2, x: 1 }, foo: 1 };
    assert.equal(canonicalJson(a), canonicalJson(b));
  });
});

describe('setup-config: hashPayload', () => {
  it('returns 12-char hex', () => {
    const h = hashPayload({ x: 1 });
    assert.match(h, /^[0-9a-f]{12}$/);
  });

  it('is deterministic', () => {
    assert.equal(hashPayload({ a: 1 }), hashPayload({ a: 1 }));
  });

  it('equal-but-differently-ordered objects produce identical hashes', () => {
    assert.equal(
      hashPayload({ foo: 1, bar: 2 }),
      hashPayload({ bar: 2, foo: 1 })
    );
  });

  it('different content produces different hashes', () => {
    assert.notEqual(hashPayload({ x: 1 }), hashPayload({ x: 2 }));
  });
});

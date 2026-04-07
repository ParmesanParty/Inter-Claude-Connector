import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { detectMode, buildHooksTemplate, buildSkillsTemplate, canonicalJson, hashPayload, buildSetupPayload, type HostMode } from '../src/setup-config.ts';
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

  it('emits watch + snooze + wake + sync skills', () => {
    const tpl = buildSkillsTemplate(dockerConfig());
    assert.ok(tpl.watch, 'watch skill required');
    assert.ok(tpl.snooze, 'snooze skill required');
    assert.ok(tpl.wake, 'wake skill required');
    assert.ok(tpl.sync, 'sync skill required');
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

describe('setup-config: buildSetupPayload', () => {
  it('returns a payload with all expected top-level keys', () => {
    const payload = buildSetupPayload(baseConfig({ localhostHttpPort: 3178, localToken: 'tok' }));
    assert.ok(payload.version);
    assert.equal(payload.hostMode, 'docker');
    assert.ok(payload.instructions);
    assert.ok(payload.mcp);
    assert.ok(payload.hooks);
    assert.ok(payload.claudeMd);
    assert.ok(payload.skills);
    assert.ok(payload.restartCategories);
    assert.ok(payload.postSetup);
  });

  it('version field is 12-char hex', () => {
    const payload = buildSetupPayload(baseConfig({ localhostHttpPort: 3178 }));
    assert.match(payload.version, /^[0-9a-f]{12}$/);
  });

  it('same config yields same version', () => {
    const a = buildSetupPayload(baseConfig({ localhostHttpPort: 3178, localToken: 'same' }));
    const b = buildSetupPayload(baseConfig({ localhostHttpPort: 3178, localToken: 'same' }));
    assert.equal(a.version, b.version);
  });

  it('Docker and bare-metal configs yield DIFFERENT versions', () => {
    const docker = buildSetupPayload(baseConfig({ localhostHttpPort: 3178, localToken: 'tok' }));
    const bare = buildSetupPayload(baseConfig({ localToken: 'tok' }));
    assert.notEqual(docker.version, bare.version);
  });

  it('Docker mcp entry uses http transport with localhost url', () => {
    const payload = buildSetupPayload(baseConfig({ localhostHttpPort: 3178, localToken: 'docker-tok' }));
    assert.equal(payload.mcp.target, '~/.claude.json');
    assert.equal(payload.mcp.mergeKey, 'mcpServers.icc');
    assert.equal(payload.mcp.config.type, 'http');
    assert.match(payload.mcp.config.url as string, /^http:\/\/localhost:3178\/mcp\?token=docker-tok$/);
  });

  it('bare-metal mcp entry uses stdio transport via icc CLI', () => {
    const payload = buildSetupPayload(baseConfig({ localToken: 'bare-tok' }));
    assert.equal(payload.mcp.config.type, 'stdio');
    assert.equal(payload.mcp.config.command, 'icc');
    assert.deepEqual(payload.mcp.config.args, ['mcp']);
  });

  it('restartCategories has 4 entries with correct actions', () => {
    const payload = buildSetupPayload(baseConfig({ localhostHttpPort: 3178 }));
    assert.equal(payload.restartCategories.mcp.action, 'in-session');
    assert.equal(payload.restartCategories.mcp.command, '/mcp');
    assert.equal(payload.restartCategories.hooks.action, 'next-session');
    assert.equal(payload.restartCategories.skills.action, 'immediate');
    assert.equal(payload.restartCategories.claudeMd.action, 'next-session');
  });

  it('claudeMd content is host-agnostic (no $hostname, no IP, no token)', () => {
    const payload = buildSetupPayload(baseConfig({ localhostHttpPort: 3178, localToken: 'should-not-leak' }));
    assert.ok(!payload.claudeMd.content.includes('should-not-leak'), 'must not leak token into CLAUDE.md');
    assert.ok(!payload.claudeMd.content.includes('localhost:3178'), 'must not leak port into CLAUDE.md');
  });

  it('changing localToken changes the version (per-host hash)', () => {
    const a = buildSetupPayload(baseConfig({ localhostHttpPort: 3178, localToken: 'a' }));
    const b = buildSetupPayload(baseConfig({ localhostHttpPort: 3178, localToken: 'b' }));
    assert.notEqual(a.version, b.version);
  });
});

describe('setup-config: buildHooksTemplate Docker drift detection', () => {
  function dockerConfig() {
    return baseConfig({ localhostHttpPort: 3178, localToken: 'docker-tok' });
  }

  it('Docker startup command references applied-config-manifest path', () => {
    const tpl = buildHooksTemplate(dockerConfig());
    const startupCmd: string = tpl.config.SessionStart.find((e: any) => e.matcher === 'startup')!.hooks[0]!.command;
    assert.match(startupCmd, /applied-config-manifest/);
  });

  it('Docker startup command uses jq to read the manifest version', () => {
    const tpl = buildHooksTemplate(dockerConfig());
    const startupCmd: string = tpl.config.SessionStart.find((e: any) => e.matcher === 'startup')!.hooks[0]!.command;
    assert.match(startupCmd, /jq/);
  });

  it('Docker startup command interpolates identity at template time (not glob)', () => {
    const cfg = baseConfig({ localhostHttpPort: 3178, localToken: 't' });
    cfg.identity = 'rpi1-test';
    const tpl = buildHooksTemplate(cfg);
    const startupCmd: string = tpl.config.SessionStart.find((e: any) => e.matcher === 'startup')!.hooks[0]!.command;
    assert.match(startupCmd, /applied-config-manifest\.rpi1-test\.json/);
    assert.ok(!startupCmd.includes('manifest.*.json'), 'must not use a glob for the identity');
  });

  it('Docker startup command surfaces drift via jq parse of response', () => {
    const tpl = buildHooksTemplate(dockerConfig());
    const startupCmd: string = tpl.config.SessionStart.find((e: any) => e.matcher === 'startup')!.hooks[0]!.command;
    assert.match(startupCmd, /Config drifted/);
    assert.match(startupCmd, /\.drifted/);
  });

  it('Docker startup command emits "not yet synced" when manifest is missing', () => {
    const tpl = buildHooksTemplate(dockerConfig());
    const startupCmd: string = tpl.config.SessionStart.find((e: any) => e.matcher === 'startup')!.hooks[0]!.command;
    assert.match(startupCmd, /not yet synced/);
  });

  it('Docker resume and clear matchers get the same shape as startup', () => {
    const tpl = buildHooksTemplate(dockerConfig());
    const startupCmd: string = tpl.config.SessionStart.find((e: any) => e.matcher === 'startup')!.hooks[0]!.command;
    const resumeCmd: string = tpl.config.SessionStart.find((e: any) => e.matcher === 'resume')!.hooks[0]!.command;
    const clearCmd: string = tpl.config.SessionStart.find((e: any) => e.matcher === 'clear')!.hooks[0]!.command;
    assert.equal(resumeCmd, startupCmd);
    assert.equal(clearCmd, startupCmd);
  });

  it('Docker startup command STILL includes the Plan C health pre-check guard', () => {
    const tpl = buildHooksTemplate(dockerConfig());
    const startupCmd: string = tpl.config.SessionStart.find((e: any) => e.matcher === 'startup')!.hooks[0]!.command;
    assert.ok(startupCmd.includes('/api/health'), 'must retain health guard');
    assert.ok(
      startupCmd.includes('ICC: server not reachable. Run /mcp to reconnect, then /watch to activate.'),
      'must retain exact UNREACHABLE_HINT wording'
    );
    assert.ok(startupCmd.includes('exit 0'), 'must retain exit 0 on health failure');
  });

  it('compact matcher is unchanged — no drift detection, no health guard', () => {
    const tpl = buildHooksTemplate(dockerConfig());
    const compactCmd: string = tpl.config.SessionStart.find((e: any) => e.matcher === 'compact')!.hooks[0]!.command;
    assert.ok(!compactCmd.includes('applied-config-manifest'), 'compact must not read manifest');
    assert.ok(!compactCmd.includes('/api/health'), 'compact must not have health guard');
    assert.match(compactCmd, /\/api\/hook\/heartbeat/);
  });
});

describe('setup-config: buildSkillsTemplate sync skill', () => {
  it('Docker sync skill exists and has correct target path', () => {
    const tpl = buildSkillsTemplate(baseConfig({ localhostHttpPort: 3178, localToken: 'tok' }));
    assert.ok((tpl as any).sync, 'sync skill must exist in Docker mode');
    assert.equal((tpl as any).sync.target, '~/.claude/skills/sync/SKILL.md');
  });

  it('Docker sync skill has frontmatter', () => {
    const tpl = buildSkillsTemplate(baseConfig({ localhostHttpPort: 3178, localToken: 'tok' }));
    const content = (tpl as any).sync.content;
    assert.match(content, /^---\n/);
    assert.match(content, /^name: sync/m);
    assert.match(content, /^description: /m);
    assert.match(content, /^disable-model-invocation: true/m);
    assert.match(content, /^user-invocable: true/m);
  });

  it('Docker sync skill references /setup/claude-code endpoint', () => {
    const tpl = buildSkillsTemplate(baseConfig({ localhostHttpPort: 3178, localToken: 'tok' }));
    const content = (tpl as any).sync.content;
    assert.match(content, /\/setup\/claude-code/);
  });

  it('Docker sync skill uses jq for manipulation', () => {
    const tpl = buildSkillsTemplate(baseConfig({ localhostHttpPort: 3178, localToken: 'tok' }));
    const content = (tpl as any).sync.content;
    assert.match(content, /\bjq\b/);
  });

  it('Docker sync skill references the manifest path', () => {
    const tpl = buildSkillsTemplate(baseConfig({ localhostHttpPort: 3178, localToken: 'tok' }));
    const content = (tpl as any).sync.content;
    assert.match(content, /applied-config-manifest/);
  });

  it('Docker sync skill references restartCategories', () => {
    const tpl = buildSkillsTemplate(baseConfig({ localhostHttpPort: 3178, localToken: 'tok' }));
    const content = (tpl as any).sync.content;
    assert.match(content, /restartCategories/);
  });

  it('Docker sync skill mentions all managed file targets', () => {
    const tpl = buildSkillsTemplate(baseConfig({ localhostHttpPort: 3178, localToken: 'tok' }));
    const content = (tpl as any).sync.content;
    assert.ok(content.includes('~/.claude.json'), 'must mention ~/.claude.json');
    assert.ok(content.includes('~/.claude/settings.json'), 'must mention ~/.claude/settings.json');
    assert.ok(content.includes('~/.claude/CLAUDE.md'), 'must mention ~/.claude/CLAUDE.md');
    assert.ok(content.includes('~/.claude/skills/'), 'must mention skill file dir');
  });

  it('Docker sync skill authenticates with Bearer token', () => {
    const tpl = buildSkillsTemplate(baseConfig({ localhostHttpPort: 3178, localToken: 'docker-tok' }));
    const content = (tpl as any).sync.content;
    assert.match(content, /Authorization: Bearer docker-tok/);
  });

  it('Docker sync skill references hand-edit apply/skip/abort prompts', () => {
    const tpl = buildSkillsTemplate(baseConfig({ localhostHttpPort: 3178, localToken: 'tok' }));
    const content = (tpl as any).sync.content;
    assert.match(content, /apply/);
    assert.match(content, /skip/);
    assert.match(content, /abort/);
  });

  it('bare-metal sync skill exists and invokes "icc hook sync"', () => {
    const tpl = buildSkillsTemplate(baseConfig());
    assert.ok((tpl as any).sync, 'sync skill must exist in bare-metal mode');
    assert.match((tpl as any).sync.content, /icc hook sync/);
    assert.ok(!(tpl as any).sync.content.includes('curl'), 'bare-metal must not use curl');
  });

  it('bare-metal sync skill has frontmatter', () => {
    const tpl = buildSkillsTemplate(baseConfig());
    const content = (tpl as any).sync.content;
    assert.match(content, /^---\n/);
    assert.match(content, /^name: sync/m);
  });
});

describe('setup-config: buildSetupPayload identity field (B15 fix)', () => {
  it('payload.identity equals config.identity', () => {
    const cfg = baseConfig({ localhostHttpPort: 3178, localToken: 'tok' });
    cfg.identity = 'rpi1-test';
    const payload = buildSetupPayload(cfg);
    assert.equal(payload.identity, 'rpi1-test');
  });

  it('changing identity changes the version (per-host hash)', () => {
    const a = buildSetupPayload({ ...baseConfig({ localhostHttpPort: 3178 }), identity: 'host-a' });
    const b = buildSetupPayload({ ...baseConfig({ localhostHttpPort: 3178 }), identity: 'host-b' });
    assert.notEqual(a.version, b.version);
  });
});

describe('setup-config: Docker sync skill identity sourcing (B15 fix)', () => {
  function dockerConfig() { return baseConfig({ localhostHttpPort: 3178, localToken: 'tok' }); }

  it('reads IDENTITY from /tmp/icc-setup-fetch.json (NOT ~/.icc/config.json)', () => {
    const tpl = buildSkillsTemplate(dockerConfig());
    const content = (tpl as any).sync.content;
    assert.match(content, /jq -r \.identity \/tmp\/icc-setup-fetch\.json/);
    assert.ok(
      !content.includes('jq -r .identity ~/.icc/config.json'),
      'must NOT read identity from host ~/.icc/config.json (does not exist on Docker hosts)'
    );
  });

  it('mkdir -p ~/.icc before manifest write', () => {
    const tpl = buildSkillsTemplate(dockerConfig());
    const content = (tpl as any).sync.content;
    assert.match(content, /mkdir -p "?\$HOME\/\.icc"?/);
  });

  it('CLAUDE.md migration handles canonical H1 ICC headings', () => {
    const tpl = buildSkillsTemplate(dockerConfig());
    const content = (tpl as any).sync.content;
    // The shell block must include the canonical-H1 detection regex inside its
    // grep -qE clause, mirroring migrateClaudeMd's ICC_CANONICAL_HEADINGS list.
    assert.ok(
      content.includes('^# ICC (Inbox|Activation|Config Drift)'),
      'shell block must reference the canonical H1 ICC heading set'
    );
  });

  it('CLAUDE.md migration handles fuzzy ICC headings with stderr warning', () => {
    const tpl = buildSkillsTemplate(dockerConfig());
    const content = (tpl as any).sync.content;
    assert.ok(
      content.includes('Possible ICC content detected outside marker region'),
      'must include the fuzzy-warning stderr message'
    );
  });
});

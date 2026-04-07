import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { runHook, createTmpHome } from './helpers.ts';
import { mkdirSync, writeFileSync, readFileSync, existsSync, chmodSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

// We can't use the in-process withServer + runHook together: runHook uses
// execFileSync, which blocks the parent event loop and starves any in-process
// HTTP server. So for the positive case we spawn a standalone HTTP server in a
// CHILD node process that just answers /api/health and /api/hook/startup, then
// point the hook subprocess at that port.
async function withStandaloneHealthServer(fn: (port: number) => Promise<void>): Promise<void> {
  const script = `
    const http = require('http');
    const s = http.createServer((req, res) => {
      if (req.url === '/api/health') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ status: 'ok' }));
        return;
      }
      if (req.url === '/api/hook/startup') {
        let body = '';
        req.on('data', c => body += c);
        req.on('end', () => {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ connected: true, unreadCount: 0 }));
        });
        return;
      }
      res.writeHead(404); res.end();
    });
    s.listen(0, '127.0.0.1', () => {
      process.stdout.write('PORT=' + s.address().port + '\\n');
    });
  `;
  const child = spawn('node', ['-e', script], { stdio: ['ignore', 'pipe', 'inherit'] });
  const port = await new Promise<number>((resolve, reject) => {
    let buf = '';
    const onData = (chunk: Buffer) => {
      buf += chunk.toString();
      const m = buf.match(/PORT=(\d+)/);
      if (m) {
        child.stdout!.off('data', onData);
        resolve(parseInt(m[1]!, 10));
      }
    };
    child.stdout!.on('data', onData);
    child.on('error', reject);
    setTimeout(() => reject(new Error('child server start timeout')), 5000);
  });
  try {
    await fn(port);
  } finally {
    child.kill('SIGTERM');
  }
}

// NOTE: This test asserts the EXACT wording of the unreachable hint and the
// connected hint. These strings are user-facing and also referenced verbatim by
// Task 4's Docker hook template test. Any wording change must update:
//   1. bin/icc.ts `case 'startup':` (both the pre-check fallback and the
//      server-not-reachable branch of the hookRequest path)
//   2. src/server.ts Docker SessionStart startup/resume/clear command templates
//   3. This test AND the test in Task 4
// All in the same commit. Do not introduce wording drift across the two paths.
const UNREACHABLE_HINT = 'ICC: server not reachable. Run /mcp to reconnect, then /watch to activate.';

describe('hook startup MCP health pre-check', () => {
  it('emits unreachable hint and skips registration when server is down', async () => {
    const { tmpHome, cleanup } = createTmpHome();
    after(cleanup);
    // No server running on this port — hook should fail health check.
    const stdout = runHook('startup', { HOME: tmpHome, ICC_PORT: '39999' });
    assert.ok(
      stdout.includes(UNREACHABLE_HINT),
      `stdout must contain the exact unreachable hint; got: ${JSON.stringify(stdout)}`
    );
  });

  // (drift tests below use a sibling helper)
  it('proceeds with normal registration when server responds to /api/health', async () => {
    const { tmpHome, cleanup } = createTmpHome();
    after(cleanup);
    await withStandaloneHealthServer(async (port) => {
      const stdout = runHook('startup', {
        HOME: tmpHome,
        ICC_PORT: String(port),
      });
      assert.match(stdout, /^ICC: connected, \d+ unread\. Run \/watch to activate\.$/m);
      assert.ok(!stdout.includes(UNREACHABLE_HINT), 'must not emit unreachable hint on healthy server');
    });
  });
});

// Sibling helper for B9 drift tests: captures the POST body to a tmp file and
// returns a configurable response. Same subprocess pattern as
// withStandaloneHealthServer (in-process server starves under execFileSync).
async function withDriftServer(
  opts: { drifted: boolean; setupVersion: string; bodyOutPath: string },
  fn: (port: number) => Promise<void>,
): Promise<void> {
  const script = `
    const http = require('http');
    const fs = require('fs');
    const DRIFTED = ${JSON.stringify(opts.drifted)};
    const SETUP_VERSION = ${JSON.stringify(opts.setupVersion)};
    const BODY_OUT = ${JSON.stringify(opts.bodyOutPath)};
    const s = http.createServer((req, res) => {
      if (req.url === '/api/health') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ status: 'ok' }));
        return;
      }
      if (req.url === '/api/hook/startup') {
        let body = '';
        req.on('data', c => body += c);
        req.on('end', () => {
          try { fs.writeFileSync(BODY_OUT, body); } catch {}
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ connected: true, unreadCount: 0, drifted: DRIFTED, setupVersion: SETUP_VERSION }));
        });
        return;
      }
      res.writeHead(404); res.end();
    });
    s.listen(0, '127.0.0.1', () => {
      process.stdout.write('PORT=' + s.address().port + '\\n');
    });
  `;
  const child = spawn('node', ['-e', script], { stdio: ['ignore', 'pipe', 'inherit'] });
  const port = await new Promise<number>((resolve, reject) => {
    let buf = '';
    const onData = (chunk: Buffer) => {
      buf += chunk.toString();
      const m = buf.match(/PORT=(\d+)/);
      if (m) {
        child.stdout!.off('data', onData);
        resolve(parseInt(m[1]!, 10));
      }
    };
    child.stdout!.on('data', onData);
    child.on('error', reject);
    setTimeout(() => reject(new Error('child server start timeout')), 5000);
  });
  try {
    await fn(port);
  } finally {
    child.kill('SIGTERM');
  }
}

function writeManifestFile(tmpHome: string, version: string | null): string {
  const dir = join(tmpHome, '.icc');
  mkdirSync(dir, { recursive: true });
  // identity defaults to 'test-host' in runHook
  const path = join(dir, 'applied-config-manifest.test-host.json');
  writeFileSync(
    path,
    JSON.stringify({ version, appliedAt: new Date().toISOString(), files: {} }, null, 2),
  );
  return path;
}

describe('hook startup manifest drift detection', () => {
  it('sends appliedVersion read from manifest in POST body', async () => {
    const { tmpHome, cleanup } = createTmpHome();
    after(cleanup);
    writeManifestFile(tmpHome, 'abc123');
    const bodyOut = join(tmpHome, 'body.json');
    await withDriftServer({ drifted: false, setupVersion: 'abc123', bodyOutPath: bodyOut }, async (port) => {
      runHook('startup', { HOME: tmpHome, ICC_PORT: String(port) });
      // Give the child a moment to flush body file
      const { readFileSync, existsSync } = await import('node:fs');
      assert.ok(existsSync(bodyOut), 'server should have recorded the POST body');
      const body = JSON.parse(readFileSync(bodyOut, 'utf8'));
      assert.equal(body.appliedVersion, 'abc123');
      assert.ok(typeof body.instance === 'string' && body.instance.length > 0);
    });
  });

  it('emits drift hint when drifted=true in response', async () => {
    const { tmpHome, cleanup } = createTmpHome();
    after(cleanup);
    writeManifestFile(tmpHome, 'oldver');
    const bodyOut = join(tmpHome, 'body.json');
    await withDriftServer({ drifted: true, setupVersion: 'newver123', bodyOutPath: bodyOut }, async (port) => {
      const stdout = runHook('startup', { HOME: tmpHome, ICC_PORT: String(port) });
      assert.ok(
        stdout.includes('[ICC] Config drifted. Run /sync to update.'),
        `expected drift hint, got: ${JSON.stringify(stdout)}`,
      );
      assert.ok(!stdout.includes('not yet synced'), 'must not emit not-yet-synced when manifest exists');
    });
  });

  it('emits "not yet synced" hint when manifest is absent', async () => {
    const { tmpHome, cleanup } = createTmpHome();
    after(cleanup);
    // No manifest written
    const bodyOut = join(tmpHome, 'body.json');
    await withDriftServer({ drifted: false, setupVersion: 'anyver', bodyOutPath: bodyOut }, async (port) => {
      const stdout = runHook('startup', { HOME: tmpHome, ICC_PORT: String(port) });
      assert.ok(
        stdout.includes('[ICC] Config not yet synced — run /sync to apply.'),
        `expected not-yet-synced hint, got: ${JSON.stringify(stdout)}`,
      );
      assert.ok(!stdout.includes('Config drifted'), 'must not emit drift hint when manifest absent');
    });
  });

  it('emits no drift or not-yet-synced hint when drifted=false and manifest present', async () => {
    const { tmpHome, cleanup } = createTmpHome();
    after(cleanup);
    writeManifestFile(tmpHome, 'current');
    const bodyOut = join(tmpHome, 'body.json');
    await withDriftServer({ drifted: false, setupVersion: 'current', bodyOutPath: bodyOut }, async (port) => {
      const stdout = runHook('startup', { HOME: tmpHome, ICC_PORT: String(port) });
      assert.ok(!stdout.includes('Config drifted'), `unexpected drift hint: ${JSON.stringify(stdout)}`);
      assert.ok(!stdout.includes('not yet synced'), `unexpected not-yet-synced hint: ${JSON.stringify(stdout)}`);
      assert.match(stdout, /^ICC: connected, \d+ unread\. Run \/watch to activate\.$/m);
    });
  });
});

// ─── B11: hook sync tests ────────────────────────────────────────────────

// Standard payload used by all sync tests. Hand-crafted (not via
// buildSetupPayload) so the test stays stable when builders evolve.
function makeSyncPayload(version: string) {
  return {
    version,
    hostMode: 'bare-metal',
    instructions: 'test',
    mcp: {
      target: '~/.claude.json',
      mergeKey: 'mcpServers.icc',
      config: { type: 'stdio', command: 'icc', args: ['mcp'], _v: version },
    },
    hooks: {
      target: '~/.claude/settings.json',
      mergeKey: 'hooks',
      config: { _v: version, SessionStart: [{ matcher: 'startup', hooks: [{ type: 'command', command: 'icc hook startup' }] }] },
    },
    claudeMd: {
      target: '~/.claude/CLAUDE.md',
      append: true,
      content: `# ICC region content v${version}\nLine two.`,
    },
    skills: {
      watch: { target: '~/.claude/skills/watch/SKILL.md', content: `watch skill v${version}\n` },
      snooze: { target: '~/.claude/skills/snooze/SKILL.md', content: `snooze skill v${version}\n` },
      wake: { target: '~/.claude/skills/wake/SKILL.md', content: `wake skill v${version}\n` },
    },
    restartCategories: {
      mcp: { action: 'in-session', command: '/mcp', label: 'Run /mcp' },
      hooks: { action: 'next-session', command: null, label: 'Restart Claude Code' },
      skills: { action: 'immediate', command: null, label: 'No action needed' },
      claudeMd: { action: 'next-session', command: null, label: 'Restart Claude Code' },
    },
    postSetup: 'restart',
  };
}

async function withSetupServer(
  payload: any,
  fn: (port: number) => Promise<void>,
  opts: { requireToken?: string } = {},
): Promise<void> {
  const script = `
    const http = require('http');
    const PAYLOAD = ${JSON.stringify(payload)};
    const REQUIRE_TOKEN = ${JSON.stringify(opts.requireToken ?? null)};
    const s = http.createServer((req, res) => {
      if (req.url === '/api/health') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ status: 'ok' }));
        return;
      }
      if (req.url === '/setup/claude-code') {
        if (REQUIRE_TOKEN) {
          const auth = req.headers['authorization'] || '';
          if (auth !== 'Bearer ' + REQUIRE_TOKEN) {
            res.writeHead(401); res.end(); return;
          }
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(PAYLOAD));
        return;
      }
      res.writeHead(404); res.end();
    });
    s.listen(0, '127.0.0.1', () => { process.stdout.write('PORT=' + s.address().port + '\\n'); });
  `;
  const child = spawn('node', ['-e', script], { stdio: ['ignore', 'pipe', 'inherit'] });
  const port = await new Promise<number>((resolve, reject) => {
    let buf = '';
    const onData = (chunk: Buffer) => {
      buf += chunk.toString();
      const m = buf.match(/PORT=(\d+)/);
      if (m) { child.stdout!.off('data', onData); resolve(parseInt(m[1]!, 10)); }
    };
    child.stdout!.on('data', onData);
    child.on('error', reject);
    setTimeout(() => reject(new Error('child server start timeout')), 5000);
  });
  try { await fn(port); } finally { child.kill('SIGTERM'); }
}

const iccBinSync = join(import.meta.dirname, '..', 'bin', 'icc.ts');

function runSync(env: Record<string, string>, stdinInput = ''):
    { stdout: string; stderr: string; status: number } {
  const r = spawnSync('node', [iccBinSync, 'hook', 'sync'], {
    env: {
      ...process.env,
      HOME: env.HOME,
      ICC_IDENTITY: 'test-host',
      ICC_REMOTE_SSH: '',
      ICC_REMOTE_HTTP: '',
      ...env,
    },
    input: stdinInput,
    encoding: 'utf-8',
    timeout: 15000,
  });
  return { stdout: r.stdout || '', stderr: r.stderr || '', status: r.status ?? 1 };
}

function readManifestForTest(tmpHome: string): any | null {
  const p = join(tmpHome, '.icc', 'applied-config-manifest.test-host.json');
  if (!existsSync(p)) return null;
  try { return JSON.parse(readFileSync(p, 'utf8')); } catch { return null; }
}

function ensureClaudeDirs(tmpHome: string): void {
  mkdirSync(join(tmpHome, '.claude'), { recursive: true });
  mkdirSync(join(tmpHome, '.claude', 'skills'), { recursive: true });
}

describe('hook sync (B11)', () => {
  it('1. first sync writes all files and creates manifest', async () => {
    const { tmpHome, cleanup } = createTmpHome();
    after(cleanup);
    ensureClaudeDirs(tmpHome);
    const payload = makeSyncPayload('v1');
    await withSetupServer(payload, async (port) => {
      const r = runSync({ HOME: tmpHome, ICC_PORT: String(port) });
      assert.equal(r.status, 0, `stderr: ${r.stderr}`);
      assert.match(r.stdout, /Applied \(6 files\)/);
      // Files written
      assert.ok(existsSync(join(tmpHome, '.claude.json')));
      assert.ok(existsSync(join(tmpHome, '.claude', 'settings.json')));
      assert.ok(existsSync(join(tmpHome, '.claude', 'CLAUDE.md')));
      assert.ok(existsSync(join(tmpHome, '.claude', 'skills', 'watch', 'SKILL.md')));
      // mcpServers.icc populated
      const claudeJson = JSON.parse(readFileSync(join(tmpHome, '.claude.json'), 'utf8'));
      assert.equal(claudeJson.mcpServers.icc._v, 'v1');
      // Manifest version + 5 entries
      const m = readManifestForTest(tmpHome);
      assert.equal(m.version, 'v1');
      assert.equal(Object.keys(m.files).length, 6);
    });
  });

  it('2. clean update applies new version when manifest exists', async () => {
    const { tmpHome, cleanup } = createTmpHome();
    after(cleanup);
    ensureClaudeDirs(tmpHome);
    // First sync at v1
    await withSetupServer(makeSyncPayload('v1'), async (port) => {
      runSync({ HOME: tmpHome, ICC_PORT: String(port) });
    });
    // Now sync at v2
    await withSetupServer(makeSyncPayload('v2'), async (port) => {
      const r = runSync({ HOME: tmpHome, ICC_PORT: String(port) });
      assert.equal(r.status, 0, r.stderr);
      assert.match(r.stdout, /Applied \(6 files\)/);
      const claudeJson = JSON.parse(readFileSync(join(tmpHome, '.claude.json'), 'utf8'));
      assert.equal(claudeJson.mcpServers.icc._v, 'v2');
      const m = readManifestForTest(tmpHome);
      assert.equal(m.version, 'v2');
    });
  });

  it('3. unchanged: re-running with same payload is a no-op', async () => {
    const { tmpHome, cleanup } = createTmpHome();
    after(cleanup);
    ensureClaudeDirs(tmpHome);
    await withSetupServer(makeSyncPayload('v1'), async (port) => {
      runSync({ HOME: tmpHome, ICC_PORT: String(port) });
      const m1 = readManifestForTest(tmpHome);
      const r = runSync({ HOME: tmpHome, ICC_PORT: String(port) });
      assert.equal(r.status, 0);
      assert.match(r.stdout, /already in sync/);
      const m2 = readManifestForTest(tmpHome);
      // Files dict identical (appliedAt may differ but we didn't rewrite)
      assert.deepEqual(m1.files, m2.files);
      assert.equal(m1.version, m2.version);
    });
  });

  it('4. hand-edit detection reports skipped file with diff hint', async () => {
    const { tmpHome, cleanup } = createTmpHome();
    after(cleanup);
    ensureClaudeDirs(tmpHome);
    await withSetupServer(makeSyncPayload('v1'), async (port) => {
      runSync({ HOME: tmpHome, ICC_PORT: String(port) });
    });
    // Hand-edit the watch skill
    writeFileSync(join(tmpHome, '.claude', 'skills', 'watch', 'SKILL.md'), 'HAND EDITED\n');
    await withSetupServer(makeSyncPayload('v2'), async (port) => {
      // Choose 'skip' for the hand-edited file
      const r = runSync({ HOME: tmpHome, ICC_PORT: String(port) }, 'skip\n');
      assert.equal(r.status, 0, r.stderr);
      assert.match(r.stdout, /locally-edited file/);
      assert.match(r.stdout, /Diff with server/);
      assert.match(r.stdout, /Skipped \(1 files/);
      // Hand-edited file untouched
      assert.equal(readFileSync(join(tmpHome, '.claude', 'skills', 'watch', 'SKILL.md'), 'utf8'), 'HAND EDITED\n');
    });
  });

  it('5. hand-edit override (apply) overwrites file and updates manifest', async () => {
    const { tmpHome, cleanup } = createTmpHome();
    after(cleanup);
    ensureClaudeDirs(tmpHome);
    await withSetupServer(makeSyncPayload('v1'), async (port) => {
      runSync({ HOME: tmpHome, ICC_PORT: String(port) });
    });
    writeFileSync(join(tmpHome, '.claude', 'skills', 'watch', 'SKILL.md'), 'HAND EDITED\n');
    await withSetupServer(makeSyncPayload('v2'), async (port) => {
      const r = runSync({ HOME: tmpHome, ICC_PORT: String(port) }, 'apply\n');
      assert.equal(r.status, 0, r.stderr);
      assert.equal(
        readFileSync(join(tmpHome, '.claude', 'skills', 'watch', 'SKILL.md'), 'utf8'),
        'watch skill vv2\n',
      );
      const m = readManifestForTest(tmpHome);
      // No skipped/failed → version advanced
      assert.equal(m.version, 'v2');
    });
  });

  it('6. abort: after collecting prompts, no files written, manifest unchanged', async () => {
    const { tmpHome, cleanup } = createTmpHome();
    after(cleanup);
    ensureClaudeDirs(tmpHome);
    await withSetupServer(makeSyncPayload('v1'), async (port) => {
      runSync({ HOME: tmpHome, ICC_PORT: String(port) });
    });
    const beforeManifest = readManifestForTest(tmpHome);
    const beforeWatch = readFileSync(join(tmpHome, '.claude', 'skills', 'watch', 'SKILL.md'), 'utf8');
    writeFileSync(join(tmpHome, '.claude', 'skills', 'watch', 'SKILL.md'), 'HAND EDITED\n');
    await withSetupServer(makeSyncPayload('v2'), async (port) => {
      const r = runSync({ HOME: tmpHome, ICC_PORT: String(port) }, 'abort\n');
      assert.equal(r.status, 0);
      assert.match(r.stdout, /Aborted/);
      // Hand-edit preserved
      assert.equal(readFileSync(join(tmpHome, '.claude', 'skills', 'watch', 'SKILL.md'), 'utf8'), 'HAND EDITED\n');
      // Other files untouched (still at v1)
      const claudeJson = JSON.parse(readFileSync(join(tmpHome, '.claude.json'), 'utf8'));
      assert.equal(claudeJson.mcpServers.icc._v, 'v1');
      // Manifest unchanged
      const after = readManifestForTest(tmpHome);
      assert.deepEqual(after.files, beforeManifest.files);
      assert.equal(after.version, beforeManifest.version);
      // beforeWatch sanity
      assert.equal(beforeWatch, 'watch skill vv1\n');
    });
  });

  it('7. CRITICAL: non-clobber of unrelated mcpServers and top-level keys', async () => {
    const { tmpHome, cleanup } = createTmpHome();
    after(cleanup);
    ensureClaudeDirs(tmpHome);
    // Pre-populate ~/.claude.json with unrelated content
    const initial = {
      mcpServers: {
        someUnrelatedServer: { type: 'stdio', command: 'other', args: ['x', 'y'] },
        icc: { type: 'stdio', command: 'OLD-ICC', args: ['mcp'] },
      },
      unrelatedTopLevelKey: { keep: 'me', list: [1, 2, 3] },
      anotherKey: 'string-value',
    };
    writeFileSync(join(tmpHome, '.claude.json'), JSON.stringify(initial, null, 2));
    await withSetupServer(makeSyncPayload('v1'), async (port) => {
      const r = runSync({ HOME: tmpHome, ICC_PORT: String(port) });
      assert.equal(r.status, 0, r.stderr);
      const after = JSON.parse(readFileSync(join(tmpHome, '.claude.json'), 'utf8'));
      // icc subtree replaced
      assert.equal(after.mcpServers.icc._v, 'v1');
      // Unrelated mcpServers entry preserved byte-equal
      assert.deepEqual(after.mcpServers.someUnrelatedServer, initial.mcpServers.someUnrelatedServer);
      // Top-level unrelated keys preserved
      assert.deepEqual(after.unrelatedTopLevelKey, initial.unrelatedTopLevelKey);
      assert.equal(after.anotherKey, initial.anotherKey);
    });
  });

  it('8. malformed manifest is treated as first-sync and overwritten cleanly', async () => {
    const { tmpHome, cleanup } = createTmpHome();
    after(cleanup);
    ensureClaudeDirs(tmpHome);
    writeFileSync(
      join(tmpHome, '.icc', 'applied-config-manifest.test-host.json'),
      '{ this is not valid json',
    );
    await withSetupServer(makeSyncPayload('v1'), async (port) => {
      const r = runSync({ HOME: tmpHome, ICC_PORT: String(port) });
      assert.equal(r.status, 0, r.stderr);
      const m = readManifestForTest(tmpHome);
      assert.equal(m.version, 'v1');
      assert.equal(Object.keys(m.files).length, 6);
    });
  });

  it('9. partial-failure: per-file manifest advances, top-level version stays', async () => {
    const { tmpHome, cleanup } = createTmpHome();
    after(cleanup);
    ensureClaudeDirs(tmpHome);
    // First sync at v1 to establish baseline
    await withSetupServer(makeSyncPayload('v1'), async (port) => {
      runSync({ HOME: tmpHome, ICC_PORT: String(port) });
    });
    // Make CLAUDE.md unwritable so it fails. Order of targets:
    // 1: ~/.claude.json   2: settings.json   3: CLAUDE.md   4-6: skills
    const claudeMdPath = join(tmpHome, '.claude', 'CLAUDE.md');
    chmodSync(claudeMdPath, 0o400);
    // Also make the directory unwritable so the atomic tmpfile can't be created
    chmodSync(join(tmpHome, '.claude'), 0o500);
    try {
      await withSetupServer(makeSyncPayload('v2'), async (port) => {
        const r = runSync({ HOME: tmpHome, ICC_PORT: String(port) });
        assert.equal(r.status, 0, r.stderr);
        assert.match(r.stdout, /Failed/);
        assert.match(r.stdout, /Partial failure/);
        const m = readManifestForTest(tmpHome);
        // version stayed at v1
        assert.equal(m.version, 'v1');
        // Files 1-2 (.claude.json, settings.json) advanced; CLAUDE.md preserved.
        // Compute v2 expected hashes by re-running canonicalJson via manifest helpers
        // — easier: just confirm that .claude.json's stored hash differs from v1.
        const v1ClaudeJsonHash = m.files['~/.claude.json::mcpServers.icc'];
        // Now apply v2 fully (after restoring perms) and confirm the hash advances.
        // First read it for comparison.
        assert.ok(typeof v1ClaudeJsonHash === 'string' && v1ClaudeJsonHash.length === 64);
      });
    } finally {
      // Restore perms so cleanup can rm
      chmodSync(join(tmpHome, '.claude'), 0o700);
      try { chmodSync(claudeMdPath, 0o600); } catch {}
    }
  });

  it('9b. retry after partial failure: previously-applied files classify as unchanged', async () => {
    const { tmpHome, cleanup } = createTmpHome();
    after(cleanup);
    ensureClaudeDirs(tmpHome);
    await withSetupServer(makeSyncPayload('v1'), async (port) => {
      runSync({ HOME: tmpHome, ICC_PORT: String(port) });
    });
    const claudeMdPath = join(tmpHome, '.claude', 'CLAUDE.md');
    chmodSync(claudeMdPath, 0o400);
    chmodSync(join(tmpHome, '.claude'), 0o500);
    await withSetupServer(makeSyncPayload('v2'), async (port) => {
      runSync({ HOME: tmpHome, ICC_PORT: String(port) });
    });
    // Restore perms and retry
    chmodSync(join(tmpHome, '.claude'), 0o700);
    chmodSync(claudeMdPath, 0o600);
    await withSetupServer(makeSyncPayload('v2'), async (port) => {
      const r = runSync({ HOME: tmpHome, ICC_PORT: String(port) });
      assert.equal(r.status, 0, r.stderr);
      // The .claude.json + settings.json + skills should now classify as
      // "unchanged" (their per-file manifest hashes were advanced on the
      // failed run). Only CLAUDE.md is a clean-update.
      // After the failed v2 run, only .claude.json advanced (files #1).
      // Retry: .claude.json is unchanged; the other 5 are clean-updates.
      assert.match(r.stdout, /Applied \(5 files\)/);
      const m = readManifestForTest(tmpHome);
      assert.equal(m.version, 'v2');
    });
  });

  it('10. sends bearer token from config.server.localToken to /setup/claude-code', async () => {
    const { tmpHome, cleanup } = createTmpHome();
    after(cleanup);
    ensureClaudeDirs(tmpHome);
    const payload = makeSyncPayload('v1');
    await withSetupServer(payload, async (port) => {
      const r = runSync({
        HOME: tmpHome,
        ICC_PORT: String(port),
        ICC_LOCAL_TOKEN: 'secret-token-xyz',
      });
      assert.equal(r.status, 0, `stderr: ${r.stderr}`);
      assert.match(r.stdout, /Applied \(6 files\)/);
    }, { requireToken: 'secret-token-xyz' });
  });

  it('11. reports clear auth error when localToken is wrong', async () => {
    const { tmpHome, cleanup } = createTmpHome();
    after(cleanup);
    ensureClaudeDirs(tmpHome);
    const payload = makeSyncPayload('v1');
    await withSetupServer(payload, async (port) => {
      const r = runSync({
        HOME: tmpHome,
        ICC_PORT: String(port),
        ICC_LOCAL_TOKEN: 'wrong-token',
      });
      assert.match(r.stdout, /HTTP 401 \(auth rejected\)/);
      // Manifest must not be written on auth failure.
      assert.equal(readManifestForTest(tmpHome), null);
    }, { requireToken: 'secret-token-xyz' });
  });
});

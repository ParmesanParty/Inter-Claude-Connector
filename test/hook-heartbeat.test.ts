import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, existsSync, mkdirSync, readdirSync, writeFileSync, rmSync } from 'node:fs';
import { join, basename } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync, spawn } from 'node:child_process';
import { sanitize } from '../src/instances.ts';

const iccBin = join(import.meta.dirname, '..', 'bin', 'icc.ts');
// Derive instance name the same way the hook does: sanitize(basename(cwd))
const instanceName = sanitize(basename(process.cwd()));

// Run `icc hook <subcmd>` in a temp ICC_HOME with given env overrides
function runHook(subcmd: string, env: Record<string, string> = {}, extraArgs: string[] = []): string {
  const result = execFileSync('node', [iccBin, 'hook', subcmd, ...extraArgs], {
    env: {
      ...process.env,
      HOME: env.HOME || process.env.HOME,
      ICC_IDENTITY: 'test-host',
      ICC_AUTH_TOKEN: 'test-token',
      ICC_REMOTE_SSH: '',
      ICC_REMOTE_HTTP: '',
      ...env,
    },
    timeout: 10000,
    encoding: 'utf-8',
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  return result;
}

describe('Heartbeat: watch writes heartbeat file', () => {
  let tmpHome: string;

  beforeEach(() => {
    tmpHome = mkdtempSync(join(tmpdir(), 'icc-hb-test-'));
    mkdirSync(join(tmpHome, '.icc'), { recursive: true });
  });

  afterEach(() => {
    try { rmSync(tmpHome, { recursive: true, force: true }); } catch {}
  });

  it('watch creates heartbeat and PID files, deletes heartbeat on exit but keeps PID', () => {
    // Run watch with a very short timeout so it exits quickly
    const stdout = runHook('watch', { HOME: tmpHome }, ['--timeout', '1', '--interval', '1']);
    assert.ok(stdout.includes('[ICC] Watcher cycled'), 'should output watcher cycled');

    // After exit, heartbeat should be deleted but PID file kept
    // (PID file persists so isWatcherAlive() blocks duplicate launches
    // until the process fully exits; new watcher overwrites it on start)
    const iccDir = join(tmpHome, '.icc');
    const files = readdirSync(iccDir);
    const heartbeatFiles = files.filter(f => f.includes('.heartbeat'));
    const pidFiles = files.filter(f => f.includes('.pid'));
    assert.equal(heartbeatFiles.length, 0, 'heartbeat should be deleted after watch exits');
    assert.equal(pidFiles.length, 1, 'PID file should persist after normal exit');
  });

  it('watch starts even when a provisional heartbeat exists (startup race)', () => {
    // Simulate what startup does: write a fresh provisional heartbeat
    const iccDir = join(tmpHome, '.icc');
    const hbPath = join(iccDir, `watcher.${instanceName}.heartbeat`);
    writeFileSync(hbPath, new Date().toISOString());

    // watch should NOT be blocked by the provisional heartbeat
    const stdout = runHook('watch', { HOME: tmpHome }, ['--timeout', '1', '--interval', '1']);
    assert.ok(stdout.includes('[ICC] Watcher cycled'), 'watch should start despite provisional heartbeat');
    assert.ok(!stdout.includes('already active'), 'should NOT report already active');
  });
});

describe('Heartbeat: check detects missing watcher', () => {
  let tmpHome: string;

  beforeEach(() => {
    tmpHome = mkdtempSync(join(tmpdir(), 'icc-hb-test-'));
    mkdirSync(join(tmpHome, '.icc'), { recursive: true });
  });

  afterEach(() => {
    try { rmSync(tmpHome, { recursive: true, force: true }); } catch {}
  });

  it('check outputs watcher-not-running when no heartbeat exists', () => {
    const stdout = runHook('check', { HOME: tmpHome });
    assert.ok(stdout.includes('[ICC] Watcher not running'), 'should report watcher not running');
  });

  it('check is silent when heartbeat is fresh', () => {
    const iccDir = join(tmpHome, '.icc');
    const hbPath = join(iccDir, `watcher.${instanceName}.heartbeat`);
    writeFileSync(hbPath, new Date().toISOString());

    const stdout = runHook('check', { HOME: tmpHome });
    assert.ok(!stdout.includes('[ICC] Watcher not running'), 'should NOT report watcher not running');
  });

  it('check detects stale heartbeat (>30s old)', () => {
    const iccDir = join(tmpHome, '.icc');
    const hbPath = join(iccDir, `watcher.${instanceName}.heartbeat`);
    const staleTime = new Date(Date.now() - 60000).toISOString();
    writeFileSync(hbPath, staleTime);

    const stdout = runHook('check', { HOME: tmpHome });
    assert.ok(stdout.includes('[ICC] Watcher not running'), 'should detect stale heartbeat');
    assert.ok(!existsSync(hbPath), 'should delete stale heartbeat file');
  });
});

describe('Heartbeat: startup cleans up stale heartbeat', () => {
  let tmpHome: string;

  beforeEach(() => {
    tmpHome = mkdtempSync(join(tmpdir(), 'icc-hb-test-'));
    mkdirSync(join(tmpHome, '.icc'), { recursive: true });
  });

  afterEach(() => {
    try { rmSync(tmpHome, { recursive: true, force: true }); } catch {}
  });

  it('startup writes a provisional heartbeat file', () => {
    const iccDir = join(tmpHome, '.icc');
    const hbPath = join(iccDir, `watcher.${instanceName}.heartbeat`);

    // startup will fail to register (no server) but that's non-fatal
    const stdout = runHook('startup', { HOME: tmpHome });
    assert.ok(existsSync(hbPath), 'heartbeat should exist after startup');
    assert.ok(stdout.includes('[ICC] Start mail watcher'));
  });
});

describe('Heartbeat: PID monitoring', () => {
  let tmpHome: string;

  beforeEach(() => {
    tmpHome = mkdtempSync(join(tmpdir(), 'icc-hb-test-'));
    mkdirSync(join(tmpHome, '.icc'), { recursive: true });
  });

  afterEach(() => {
    try { rmSync(tmpHome, { recursive: true, force: true }); } catch {}
  });

  it('watch exits when monitored PID does not exist', () => {
    const stdout = runHook('watch', { HOME: tmpHome }, ['--pid', '999999', '--interval', '1']);
    // Dead PID → silent exit (no "Watcher cycled" since it exits before timeout)
    assert.ok(!stdout.includes('[ICC] Watcher cycled'), 'should exit before timeout');
    // Heartbeat deleted, PID file persists (same as normal exit)
    const files = readdirSync(join(tmpHome, '.icc'));
    const heartbeatFiles = files.filter(f => f.includes('.heartbeat'));
    const pidFiles = files.filter(f => f.includes('.pid'));
    assert.equal(heartbeatFiles.length, 0, 'heartbeat should be cleaned up on PID death exit');
    assert.equal(pidFiles.length, 1, 'PID file should persist after PID death exit');
  });
});

describe('Heartbeat: SIGTERM cleanup', () => {
  let tmpHome: string;

  beforeEach(() => {
    tmpHome = mkdtempSync(join(tmpdir(), 'icc-hb-test-'));
    mkdirSync(join(tmpHome, '.icc'), { recursive: true });
  });

  afterEach(() => {
    try { rmSync(tmpHome, { recursive: true, force: true }); } catch {}
  });

  it('watch cleans up PID and heartbeat files on SIGTERM', async () => {
    const child = spawn('node', [iccBin, 'hook', 'watch', '--pid', String(process.pid), '--interval', '1'], {
      env: { ...process.env, HOME: tmpHome, ICC_IDENTITY: 'test-host', ICC_AUTH_TOKEN: 'test-token', ICC_REMOTE_SSH: '', ICC_REMOTE_HTTP: '' },
      stdio: 'pipe',
    });

    // Wait for watcher to start and write heartbeat
    await new Promise(resolve => setTimeout(resolve, 1500));
    const hbPath = join(tmpHome, '.icc', `watcher.${instanceName}.heartbeat`);
    assert.ok(existsSync(hbPath), 'heartbeat should exist while watcher runs');

    child.kill('SIGTERM');
    await new Promise(resolve => child.on('close', resolve));

    const files = readdirSync(join(tmpHome, '.icc'));
    const watcherFiles = files.filter(f => f.startsWith('watcher.'));
    assert.equal(watcherFiles.length, 0, 'SIGTERM should trigger cleanup');
  });
});

describe('Hook: session-end', () => {
  let tmpHome: string;

  beforeEach(() => {
    tmpHome = mkdtempSync(join(tmpdir(), 'icc-hb-test-'));
    mkdirSync(join(tmpHome, '.icc'), { recursive: true });
  });

  afterEach(() => {
    try { rmSync(tmpHome, { recursive: true, force: true }); } catch {}
  });

  it('session-end cleans up watcher files', () => {
    const iccDir = join(tmpHome, '.icc');
    // Create fake watcher files (non-existent PID)
    writeFileSync(join(iccDir, `watcher.${instanceName}.pid`), '999999');
    writeFileSync(join(iccDir, `watcher.${instanceName}.heartbeat`), new Date().toISOString());

    runHook('session-end', { HOME: tmpHome });

    const files = readdirSync(iccDir);
    const watcherFiles = files.filter(f => f.startsWith('watcher.'));
    assert.equal(watcherFiles.length, 0, 'session-end should clean up all watcher files');
  });
});

describe('Hook: subagent-context', () => {
  let tmpHome: string;

  beforeEach(() => {
    tmpHome = mkdtempSync(join(tmpdir(), 'icc-hb-test-'));
    mkdirSync(join(tmpHome, '.icc'), { recursive: true });
  });

  afterEach(() => {
    try { rmSync(tmpHome, { recursive: true, force: true }); } catch {}
  });

  it('outputs JSON with additionalContext for SubagentStart', () => {
    const stdout = runHook('subagent-context', { HOME: tmpHome });
    const parsed = JSON.parse(stdout);
    assert.equal(parsed.hookSpecificOutput.hookEventName, 'SubagentStart');
    assert.ok(parsed.hookSpecificOutput.additionalContext.includes('Do NOT launch'));
  });
});

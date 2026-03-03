import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, existsSync, mkdirSync, readdirSync, writeFileSync, rmSync } from 'node:fs';
import { join, basename } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { sanitize } from '../src/instances.ts';

const iccBin = join(import.meta.dirname, '..', 'bin', 'icc.ts');
const instanceName = sanitize(basename(process.cwd()));

function runHook(subcmd: string, env: Record<string, string> = {}, extraArgs: string[] = []): string {
  return execFileSync('node', [iccBin, 'hook', subcmd, ...extraArgs], {
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
}

describe('Session instance: startup writes session file', () => {
  let tmpHome: string;

  beforeEach(() => {
    tmpHome = mkdtempSync(join(tmpdir(), 'icc-session-test-'));
    mkdirSync(join(tmpHome, '.icc'), { recursive: true });
  });

  afterEach(() => {
    try { rmSync(tmpHome, { recursive: true, force: true }); } catch {}
  });

  it('startup creates a session.<pid>.instance file', () => {
    runHook('startup', { HOME: tmpHome });

    const iccDir = join(tmpHome, '.icc');
    const sessionFiles = readdirSync(iccDir).filter(
      f => f.startsWith('session.') && f.endsWith('.instance')
    );
    assert.equal(sessionFiles.length, 1, 'should create exactly one session file');

    const content = readFileSync(join(iccDir, sessionFiles[0]!), 'utf-8').trim();
    assert.equal(content, instanceName, 'session file should contain the instance name');
  });
});

describe('Session instance: check uses session file', () => {
  let tmpHome: string;

  beforeEach(() => {
    tmpHome = mkdtempSync(join(tmpdir(), 'icc-session-test-'));
    mkdirSync(join(tmpHome, '.icc'), { recursive: true });
  });

  afterEach(() => {
    try { rmSync(tmpHome, { recursive: true, force: true }); } catch {}
  });

  it('check reads instance name from session file when present', () => {
    // Run startup first to create the session file
    runHook('startup', { HOME: tmpHome });

    // Write a heartbeat under the session instance name so check is silent
    const iccDir = join(tmpHome, '.icc');
    writeFileSync(join(iccDir, `watcher.${instanceName}.heartbeat`), new Date().toISOString());

    // Check should NOT report "Watcher not running" because the heartbeat
    // matches the session instance name
    const stdout = runHook('check', { HOME: tmpHome });
    assert.ok(!stdout.includes('[ICC] Watcher not running'),
      'check should use session instance name and find the heartbeat');
  });
});

describe('Session instance: session-end cleans up session file', () => {
  let tmpHome: string;

  beforeEach(() => {
    tmpHome = mkdtempSync(join(tmpdir(), 'icc-session-test-'));
    mkdirSync(join(tmpHome, '.icc'), { recursive: true });
  });

  afterEach(() => {
    try { rmSync(tmpHome, { recursive: true, force: true }); } catch {}
  });

  it('session-end deletes the session file', () => {
    // Create session file via startup
    runHook('startup', { HOME: tmpHome });
    const iccDir = join(tmpHome, '.icc');
    let sessionFiles = readdirSync(iccDir).filter(
      f => f.startsWith('session.') && f.endsWith('.instance')
    );
    assert.equal(sessionFiles.length, 1, 'session file should exist after startup');

    // Run session-end to clean up
    runHook('session-end', { HOME: tmpHome });
    sessionFiles = readdirSync(iccDir).filter(
      f => f.startsWith('session.') && f.endsWith('.instance')
    );
    assert.equal(sessionFiles.length, 0, 'session file should be deleted after session-end');
  });
});

describe('Session instance: startup cleans stale session files', () => {
  let tmpHome: string;

  beforeEach(() => {
    tmpHome = mkdtempSync(join(tmpdir(), 'icc-session-test-'));
    mkdirSync(join(tmpHome, '.icc'), { recursive: true });
  });

  afterEach(() => {
    try { rmSync(tmpHome, { recursive: true, force: true }); } catch {}
  });

  it('removes session files for dead PIDs', () => {
    const iccDir = join(tmpHome, '.icc');
    // Create a fake session file with a non-existent PID
    writeFileSync(join(iccDir, 'session.999999.instance'), 'stale-instance');

    runHook('startup', { HOME: tmpHome });

    assert.ok(!existsSync(join(iccDir, 'session.999999.instance')),
      'stale session file should be cleaned up');
  });

  it('preserves session files for live PIDs', () => {
    const iccDir = join(tmpHome, '.icc');
    // Create a session file with the current process PID (which is alive)
    writeFileSync(join(iccDir, `session.${process.pid}.instance`), 'live-instance');

    runHook('startup', { HOME: tmpHome });

    assert.ok(existsSync(join(iccDir, `session.${process.pid}.instance`)),
      'session file for live PID should be preserved');
  });
});

describe('Session instance: fallback when no session file exists', () => {
  let tmpHome: string;

  beforeEach(() => {
    tmpHome = mkdtempSync(join(tmpdir(), 'icc-session-test-'));
    mkdirSync(join(tmpHome, '.icc'), { recursive: true });
  });

  afterEach(() => {
    try { rmSync(tmpHome, { recursive: true, force: true }); } catch {}
  });

  it('check falls back to cwd-derived name when no session file exists', () => {
    // Don't run startup — no session file will exist
    // check should still work, falling back to resolveInstance(cwd)
    const stdout = runHook('check', { HOME: tmpHome });
    // With no heartbeat and no watcher, should report not running
    assert.ok(stdout.includes('[ICC] Watcher not running'),
      'should fall back to cwd-derived instance name and detect missing watcher');
  });
});

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync, readdirSync, writeFileSync } from 'node:fs';
import { join, basename } from 'node:path';
import { sanitize } from '../src/instances.ts';
import { runHook, createTmpHome } from './helpers.ts';

const instanceName = sanitize(basename(process.cwd()));

describe('Session instance: startup writes session file', () => {
  let tmp: ReturnType<typeof createTmpHome>;
  beforeEach(() => { tmp = createTmpHome(); });
  afterEach(() => { tmp.cleanup(); });

  it('startup creates a session.<pid>.instance file', () => {
    runHook('startup', { HOME: tmp.tmpHome });

    const iccDir = join(tmp.tmpHome, '.icc');
    const sessionFiles = readdirSync(iccDir).filter(
      f => f.startsWith('session.') && f.endsWith('.instance')
    );
    assert.equal(sessionFiles.length, 1, 'should create exactly one session file');

    const content = readFileSync(join(iccDir, sessionFiles[0]!), 'utf-8').trim();
    assert.equal(content, instanceName, 'session file should contain the instance name');
  });
});

describe('Session instance: check uses session file', () => {
  let tmp: ReturnType<typeof createTmpHome>;
  beforeEach(() => { tmp = createTmpHome(); });
  afterEach(() => { tmp.cleanup(); });

  it('check reads instance name from session file when present', () => {
    runHook('startup', { HOME: tmp.tmpHome });

    const iccDir = join(tmp.tmpHome, '.icc');
    writeFileSync(join(iccDir, `watcher.${instanceName}.heartbeat`), new Date().toISOString());

    const stdout = runHook('check', { HOME: tmp.tmpHome });
    assert.ok(!stdout.includes('[ICC] Watcher not running'),
      'check should use session instance name and find the heartbeat');
  });
});

describe('Session instance: session-end cleans up session file', () => {
  let tmp: ReturnType<typeof createTmpHome>;
  beforeEach(() => { tmp = createTmpHome(); });
  afterEach(() => { tmp.cleanup(); });

  it('session-end deletes the session file', () => {
    runHook('startup', { HOME: tmp.tmpHome });
    const iccDir = join(tmp.tmpHome, '.icc');
    let sessionFiles = readdirSync(iccDir).filter(
      f => f.startsWith('session.') && f.endsWith('.instance')
    );
    assert.equal(sessionFiles.length, 1, 'session file should exist after startup');

    runHook('session-end', { HOME: tmp.tmpHome });
    sessionFiles = readdirSync(iccDir).filter(
      f => f.startsWith('session.') && f.endsWith('.instance')
    );
    assert.equal(sessionFiles.length, 0, 'session file should be deleted after session-end');
  });
});

describe('Session instance: startup cleans stale session files', () => {
  let tmp: ReturnType<typeof createTmpHome>;
  beforeEach(() => { tmp = createTmpHome(); });
  afterEach(() => { tmp.cleanup(); });

  it('removes session files for dead PIDs', () => {
    const iccDir = join(tmp.tmpHome, '.icc');
    writeFileSync(join(iccDir, 'session.999999.instance'), 'stale-instance');

    runHook('startup', { HOME: tmp.tmpHome });

    assert.ok(!existsSync(join(iccDir, 'session.999999.instance')),
      'stale session file should be cleaned up');
  });

  it('preserves session files for live PIDs', () => {
    const iccDir = join(tmp.tmpHome, '.icc');
    writeFileSync(join(iccDir, `session.${process.pid}.instance`), 'live-instance');

    runHook('startup', { HOME: tmp.tmpHome });

    assert.ok(existsSync(join(iccDir, `session.${process.pid}.instance`)),
      'session file for live PID should be preserved');
  });
});

describe('Session instance: fallback when no session file exists', () => {
  let tmp: ReturnType<typeof createTmpHome>;
  beforeEach(() => { tmp = createTmpHome(); });
  afterEach(() => { tmp.cleanup(); });

  it('check falls back to cwd-derived name when no session file exists', () => {
    const stdout = runHook('check', { HOME: tmp.tmpHome });
    assert.ok(stdout.includes('[ICC] Watcher not running'),
      'should fall back to cwd-derived instance name and detect missing watcher');
  });
});

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readdirSync, writeFileSync } from 'node:fs';
import { join, basename } from 'node:path';
import { spawn } from 'node:child_process';
import { sanitize } from '../src/instances.ts';
import { runHook, createTmpHome } from './helpers.ts';

const iccBin = join(import.meta.dirname, '..', 'bin', 'icc.ts');
const instanceName = sanitize(basename(process.cwd()));

describe('Heartbeat: watch writes heartbeat file', () => {
  let tmp: ReturnType<typeof createTmpHome>;
  beforeEach(() => { tmp = createTmpHome(); });
  afterEach(() => { tmp.cleanup(); });

  it('watch creates heartbeat and PID files, deletes both on exit', () => {
    const stdout = runHook('watch', { HOME: tmp.tmpHome }, ['--timeout', '1', '--interval', '1']);
    assert.ok(stdout.includes('[ICC] Watcher cycled'), 'should output watcher cycled');

    const files = readdirSync(join(tmp.tmpHome, '.icc'));
    const watcherFiles = files.filter(f => f.startsWith('watcher.'));
    assert.equal(watcherFiles.length, 0, 'heartbeat and PID files should be deleted after watch exits');
  });

  it('watch starts even when a provisional heartbeat exists (startup race)', () => {
    const hbPath = join(tmp.tmpHome, '.icc', `watcher.${instanceName}.heartbeat`);
    writeFileSync(hbPath, new Date().toISOString());

    const stdout = runHook('watch', { HOME: tmp.tmpHome }, ['--timeout', '1', '--interval', '1']);
    assert.ok(stdout.includes('[ICC] Watcher cycled'), 'watch should start despite provisional heartbeat');
    assert.ok(!stdout.includes('already active'), 'should NOT report already active');
  });
});

describe('Heartbeat: check detects missing watcher', () => {
  let tmp: ReturnType<typeof createTmpHome>;
  beforeEach(() => { tmp = createTmpHome(); });
  afterEach(() => { tmp.cleanup(); });

  it('check outputs watcher-not-running when no heartbeat exists', () => {
    const stdout = runHook('check', { HOME: tmp.tmpHome });
    assert.ok(stdout.includes('[ICC] Watcher not running'), 'should report watcher not running');
  });

  it('check is silent when heartbeat is fresh', () => {
    const hbPath = join(tmp.tmpHome, '.icc', `watcher.${instanceName}.heartbeat`);
    writeFileSync(hbPath, new Date().toISOString());

    const stdout = runHook('check', { HOME: tmp.tmpHome });
    assert.ok(!stdout.includes('[ICC] Watcher not running'), 'should NOT report watcher not running');
  });

  it('check detects stale heartbeat (>30s old)', () => {
    const hbPath = join(tmp.tmpHome, '.icc', `watcher.${instanceName}.heartbeat`);
    const staleTime = new Date(Date.now() - 60000).toISOString();
    writeFileSync(hbPath, staleTime);

    const stdout = runHook('check', { HOME: tmp.tmpHome });
    assert.ok(stdout.includes('[ICC] Watcher not running'), 'should detect stale heartbeat');
    assert.ok(!existsSync(hbPath), 'should delete stale heartbeat file');
  });
});

describe('Heartbeat: startup cleans up stale heartbeat', () => {
  let tmp: ReturnType<typeof createTmpHome>;
  beforeEach(() => { tmp = createTmpHome(); });
  afterEach(() => { tmp.cleanup(); });

  it('startup writes a provisional heartbeat file', () => {
    const hbPath = join(tmp.tmpHome, '.icc', `watcher.${instanceName}.heartbeat`);
    const stdout = runHook('startup', { HOME: tmp.tmpHome });
    assert.ok(existsSync(hbPath), 'heartbeat should exist after startup');
    assert.ok(stdout.includes('[ICC] Start mail watcher'));
  });
});

describe('Heartbeat: PID monitoring', () => {
  let tmp: ReturnType<typeof createTmpHome>;
  beforeEach(() => { tmp = createTmpHome(); });
  afterEach(() => { tmp.cleanup(); });

  it('watch exits when monitored PID does not exist', () => {
    const stdout = runHook('watch', { HOME: tmp.tmpHome }, ['--pid', '999999', '--interval', '1']);
    assert.ok(!stdout.includes('[ICC] Watcher cycled'), 'should exit before timeout');
    const files = readdirSync(join(tmp.tmpHome, '.icc'));
    const watcherFiles = files.filter(f => f.startsWith('watcher.'));
    assert.equal(watcherFiles.length, 0, 'should clean up files on PID death exit');
  });
});

describe('Heartbeat: SIGTERM cleanup', () => {
  let tmp: ReturnType<typeof createTmpHome>;
  beforeEach(() => { tmp = createTmpHome(); });
  afterEach(() => { tmp.cleanup(); });

  it('watch cleans up PID and heartbeat files on SIGTERM', async () => {
    const child = spawn('node', [iccBin, 'hook', 'watch', '--pid', String(process.pid), '--interval', '1'], {
      env: { ...process.env, HOME: tmp.tmpHome, ICC_IDENTITY: 'test-host', ICC_REMOTE_SSH: '', ICC_REMOTE_HTTP: '' },
      stdio: 'pipe',
    });

    await new Promise(resolve => setTimeout(resolve, 1500));
    const hbPath = join(tmp.tmpHome, '.icc', `watcher.${instanceName}.heartbeat`);
    assert.ok(existsSync(hbPath), 'heartbeat should exist while watcher runs');

    child.kill('SIGTERM');
    await new Promise(resolve => child.on('close', resolve));

    const files = readdirSync(join(tmp.tmpHome, '.icc'));
    const watcherFiles = files.filter(f => f.startsWith('watcher.'));
    assert.equal(watcherFiles.length, 0, 'SIGTERM should trigger cleanup');
  });
});

describe('Hook: session-end', () => {
  let tmp: ReturnType<typeof createTmpHome>;
  beforeEach(() => { tmp = createTmpHome(); });
  afterEach(() => { tmp.cleanup(); });

  it('session-end cleans up watcher files', () => {
    const iccDir = join(tmp.tmpHome, '.icc');
    writeFileSync(join(iccDir, `watcher.${instanceName}.pid`), '999999');
    writeFileSync(join(iccDir, `watcher.${instanceName}.heartbeat`), new Date().toISOString());

    runHook('session-end', { HOME: tmp.tmpHome });

    const files = readdirSync(iccDir);
    const watcherFiles = files.filter(f => f.startsWith('watcher.'));
    assert.equal(watcherFiles.length, 0, 'session-end should clean up all watcher files');
  });
});

describe('Snooze: snooze-watcher and wake-watcher', () => {
  let tmp: ReturnType<typeof createTmpHome>;
  beforeEach(() => { tmp = createTmpHome(); });
  afterEach(() => { tmp.cleanup(); });

  it('snooze-watcher creates snooze file', () => {
    const stdout = runHook('snooze-watcher', { HOME: tmp.tmpHome });
    assert.ok(stdout.includes('[ICC] Watcher snoozed'), 'should confirm snooze');
    const snoozePath = join(tmp.tmpHome, '.icc', `watcher.${instanceName}.snoozed`);
    assert.ok(existsSync(snoozePath), 'snooze file should exist');
  });

  it('wake-watcher removes snooze file and triggers launch', () => {
    writeFileSync(join(tmp.tmpHome, '.icc', `watcher.${instanceName}.snoozed`), new Date().toISOString());

    const stdout = runHook('wake-watcher', { HOME: tmp.tmpHome });
    assert.ok(stdout.includes('[ICC] Start mail watcher'), 'should trigger launch');
    const snoozePath = join(tmp.tmpHome, '.icc', `watcher.${instanceName}.snoozed`);
    assert.ok(!existsSync(snoozePath), 'snooze file should be deleted');
  });
});

describe('Snooze: startup respects snooze state', () => {
  let tmp: ReturnType<typeof createTmpHome>;
  beforeEach(() => { tmp = createTmpHome(); });
  afterEach(() => { tmp.cleanup(); });

  it('startup suppresses launch when snoozed (re-fire)', () => {
    runHook('startup', { HOME: tmp.tmpHome });
    writeFileSync(join(tmp.tmpHome, '.icc', `watcher.${instanceName}.snoozed`), new Date().toISOString());
    const stdout = runHook('startup', { HOME: tmp.tmpHome });
    assert.ok(stdout.includes('[ICC] Watcher snoozed'), 'should report snoozed');
    assert.ok(!stdout.includes('[ICC] Start mail watcher'), 'should NOT trigger launch');
  });

  it('startup clears stale snooze on fresh session (no session file)', () => {
    writeFileSync(join(tmp.tmpHome, '.icc', `watcher.${instanceName}.snoozed`), new Date().toISOString());
    const stdout = runHook('startup', { HOME: tmp.tmpHome });
    assert.ok(stdout.includes('[ICC] Start mail watcher'), 'should trigger launch after clearing stale snooze');
    assert.ok(!stdout.includes('[ICC] Watcher snoozed'), 'should NOT report snoozed');
    const snoozePath = join(tmp.tmpHome, '.icc', `watcher.${instanceName}.snoozed`);
    assert.ok(!existsSync(snoozePath), 'stale snooze file should be deleted');
  });
});

describe('Snooze: check respects snooze state', () => {
  let tmp: ReturnType<typeof createTmpHome>;
  beforeEach(() => { tmp = createTmpHome(); });
  afterEach(() => { tmp.cleanup(); });

  it('check suppresses watcher-not-running when snoozed', () => {
    writeFileSync(join(tmp.tmpHome, '.icc', `watcher.${instanceName}.snoozed`), new Date().toISOString());
    const stdout = runHook('check', { HOME: tmp.tmpHome });
    assert.ok(!stdout.includes('[ICC] Watcher not running'), 'should NOT report watcher not running when snoozed');
  });
});

describe('Snooze: session-end cleans up snooze file', () => {
  let tmp: ReturnType<typeof createTmpHome>;
  beforeEach(() => { tmp = createTmpHome(); });
  afterEach(() => { tmp.cleanup(); });

  it('session-end removes snooze file', () => {
    writeFileSync(join(tmp.tmpHome, '.icc', `watcher.${instanceName}.snoozed`), new Date().toISOString());
    runHook('session-end', { HOME: tmp.tmpHome });
    const snoozePath = join(tmp.tmpHome, '.icc', `watcher.${instanceName}.snoozed`);
    assert.ok(!existsSync(snoozePath), 'snooze file should be deleted on session-end');
  });
});

describe('Instance-specific blocking', () => {
  let tmp: ReturnType<typeof createTmpHome>;
  beforeEach(() => { tmp = createTmpHome(); });
  afterEach(() => { tmp.cleanup(); });

  it('other instance watcher does not block this instance', () => {
    writeFileSync(join(tmp.tmpHome, '.icc', 'watcher.other-project.pid'), '1');
    writeFileSync(join(tmp.tmpHome, '.icc', 'watcher.other-project.heartbeat'), new Date().toISOString());

    const stdout = runHook('watch', { HOME: tmp.tmpHome }, ['--timeout', '1', '--interval', '1']);
    assert.ok(stdout.includes('[ICC] Watcher cycled'), 'should run watcher despite other instance having one');
    assert.ok(!stdout.includes('already active'), 'should NOT report already active');
  });
});

describe('Hook: subagent-context', () => {
  let tmp: ReturnType<typeof createTmpHome>;
  beforeEach(() => { tmp = createTmpHome(); });
  afterEach(() => { tmp.cleanup(); });

  it('outputs JSON with additionalContext for SubagentStart', () => {
    const stdout = runHook('subagent-context', { HOME: tmp.tmpHome });
    const parsed = JSON.parse(stdout);
    assert.equal(parsed.hookSpecificOutput.hookEventName, 'SubagentStart');
    assert.ok(parsed.hookSpecificOutput.additionalContext.includes('Do NOT launch'));
  });
});

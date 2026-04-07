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

  it('watch creates heartbeat and PID files, deletes both on exit', async () => {
    const child = spawn('node', [iccBin, 'hook', 'watch', '--pid', String(process.pid), '--interval', '1'], {
      env: { ...process.env, HOME: tmp.tmpHome, ICC_IDENTITY: 'test-host', ICC_REMOTE_SSH: '', ICC_REMOTE_HTTP: '' },
      stdio: 'pipe',
    });

    await new Promise(resolve => setTimeout(resolve, 1500));
    const files = readdirSync(join(tmp.tmpHome, '.icc'));
    const watcherFiles = files.filter(f => f.startsWith('watcher.'));
    assert.ok(watcherFiles.length > 0, 'heartbeat and PID files should exist while watcher runs');

    child.kill('SIGTERM');
    await new Promise(resolve => child.on('close', resolve));

    const after = readdirSync(join(tmp.tmpHome, '.icc'));
    const afterWatcher = after.filter(f => f.startsWith('watcher.'));
    assert.equal(afterWatcher.length, 0, 'heartbeat and PID files should be deleted after watch exits');
  });

  it('watch starts even when a provisional heartbeat exists (startup race)', async () => {
    const hbPath = join(tmp.tmpHome, '.icc', `watcher.${instanceName}.heartbeat`);
    writeFileSync(hbPath, new Date().toISOString());

    const child = spawn('node', [iccBin, 'hook', 'watch', '--pid', String(process.pid), '--interval', '1'], {
      env: { ...process.env, HOME: tmp.tmpHome, ICC_IDENTITY: 'test-host', ICC_REMOTE_SSH: '', ICC_REMOTE_HTTP: '' },
      stdio: 'pipe',
    });

    const chunks: Buffer[] = [];
    child.stdout.on('data', (c) => chunks.push(c));

    await new Promise(resolve => setTimeout(resolve, 1500));

    const files = readdirSync(join(tmp.tmpHome, '.icc'));
    const pidFile = files.find(f => f === `watcher.${instanceName}.pid`);
    assert.ok(pidFile, 'watch should start despite provisional heartbeat');

    child.kill('SIGTERM');
    await new Promise(resolve => child.on('close', resolve));

    const stdout = Buffer.concat(chunks).toString();
    assert.ok(!stdout.includes('already active'), 'should NOT report already active');
  });
});

describe('Heartbeat: check sends heartbeat (no local liveness check)', () => {
  let tmp: ReturnType<typeof createTmpHome>;
  beforeEach(() => { tmp = createTmpHome(); });
  afterEach(() => { tmp.cleanup(); });

  it('check does not report watcher-not-running (heartbeat-based now)', () => {
    const stdout = runHook('check', { HOME: tmp.tmpHome });
    // Check hook no longer reports local watcher liveness — sends heartbeat to server instead
    assert.ok(!stdout.includes('[ICC] Watcher not running'), 'should NOT report watcher not running');
  });

  it('check is silent when no signal files exist', () => {
    const stdout = runHook('check', { HOME: tmp.tmpHome });
    assert.ok(!stdout.includes('[ICC]'), 'should be silent with no signals');
  });
});

describe('Heartbeat: startup is status-only', () => {
  let tmp: ReturnType<typeof createTmpHome>;
  beforeEach(() => { tmp = createTmpHome(); });
  afterEach(() => { tmp.cleanup(); });

  it('startup does not write provisional heartbeat', () => {
    const hbPath = join(tmp.tmpHome, '.icc', `watcher.${instanceName}.heartbeat`);
    runHook('startup', { HOME: tmp.tmpHome });
    // Startup no longer writes provisional heartbeat — watcher handles its own
    assert.ok(!existsSync(hbPath), 'heartbeat should NOT exist after startup');
  });

  it('startup outputs activation prompt', () => {
    const stdout = runHook('startup', { HOME: tmp.tmpHome });
    assert.ok(stdout.includes('Run /watch to activate'), 'should show activation prompt');
    assert.ok(!stdout.includes('[ICC] Start mail watcher'), 'should NOT trigger launch');
  });
});

describe('Heartbeat: PID monitoring', () => {
  let tmp: ReturnType<typeof createTmpHome>;
  beforeEach(() => { tmp = createTmpHome(); });
  afterEach(() => { tmp.cleanup(); });

  it('watch exits when monitored PID does not exist', () => {
    runHook('watch', { HOME: tmp.tmpHome }, ['--pid', '999999', '--interval', '1']);
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

  it('startup does not mention snooze (status-only)', () => {
    runHook('startup', { HOME: tmp.tmpHome });
    writeFileSync(join(tmp.tmpHome, '.icc', `watcher.${instanceName}.snoozed`), new Date().toISOString());
    const stdout = runHook('startup', { HOME: tmp.tmpHome });
    // Startup is now status-only — no snooze/launch messaging
    assert.ok(!stdout.includes('[ICC] Start mail watcher'), 'should NOT trigger launch');
    assert.ok(stdout.includes('Run /watch to activate'), 'should show activation prompt');
  });

  it('startup clears stale snooze on fresh session (no session file)', () => {
    writeFileSync(join(tmp.tmpHome, '.icc', `watcher.${instanceName}.snoozed`), new Date().toISOString());
    const stdout = runHook('startup', { HOME: tmp.tmpHome });
    // Startup is status-only — just verify snooze file was cleared
    assert.ok(stdout.includes('Run /watch to activate'), 'should show activation prompt');
    const snoozePath = join(tmp.tmpHome, '.icc', `watcher.${instanceName}.snoozed`);
    assert.ok(!existsSync(snoozePath), 'stale snooze file should be deleted');
  });
});

describe('Snooze: check respects snooze state', () => {
  let tmp: ReturnType<typeof createTmpHome>;
  beforeEach(() => { tmp = createTmpHome(); });
  afterEach(() => { tmp.cleanup(); });

  it('check does not report watcher status (heartbeat-based)', () => {
    writeFileSync(join(tmp.tmpHome, '.icc', `watcher.${instanceName}.snoozed`), new Date().toISOString());
    const stdout = runHook('check', { HOME: tmp.tmpHome });
    // Check hook no longer reports watcher liveness — it sends heartbeats instead
    assert.ok(!stdout.includes('[ICC] Watcher not running'), 'should NOT report watcher not running');
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

  it('other instance watcher does not block this instance', async () => {
    writeFileSync(join(tmp.tmpHome, '.icc', 'watcher.other-project.pid'), '1');
    writeFileSync(join(tmp.tmpHome, '.icc', 'watcher.other-project.heartbeat'), new Date().toISOString());

    const child = spawn('node', [iccBin, 'hook', 'watch', '--pid', String(process.pid), '--interval', '1'], {
      env: { ...process.env, HOME: tmp.tmpHome, ICC_IDENTITY: 'test-host', ICC_REMOTE_SSH: '', ICC_REMOTE_HTTP: '' },
      stdio: 'pipe',
    });

    const chunks: Buffer[] = [];
    child.stdout.on('data', (c) => chunks.push(c));

    await new Promise(resolve => setTimeout(resolve, 1500));

    const files = readdirSync(join(tmp.tmpHome, '.icc'));
    const thisPid = files.find(f => f === `watcher.${instanceName}.pid`);
    assert.ok(thisPid, 'this instance watcher should be running');

    child.kill('SIGTERM');
    await new Promise(resolve => child.on('close', resolve));

    const stdout = Buffer.concat(chunks).toString();
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

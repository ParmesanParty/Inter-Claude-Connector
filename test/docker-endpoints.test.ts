import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { reset } from '../src/registry.ts';
import { createTestEnv, isolateConfig, withServer, httpJSON } from './helpers.ts';

createTestEnv('icc-docker-test');

// ── Session lifecycle endpoints ──────────────────────────────────────

describe('POST /api/hook/startup', () => {
  beforeEach(() => { isolateConfig(); reset(); });

  it('returns connection status and unread count', async () => {
    await withServer({}, async (port) => {
      const res = await httpJSON(port, 'POST', '/api/hook/startup', { instance: 'myapp' });
      assert.equal(res.status, 200);
      assert.equal(res.data.connected, true);
      assert.equal(typeof res.data.unreadCount, 'number');
    });
  });

  it('rejects missing instance', async () => {
    await withServer({}, async (port) => {
      const res = await httpJSON(port, 'POST', '/api/hook/startup', {});
      assert.equal(res.status, 400);
    });
  });
});

describe('POST /api/hook/watch', () => {
  beforeEach(() => { isolateConfig(); reset(); });

  it('registers instance and returns session token', async () => {
    await withServer({}, async (port) => {
      const res = await httpJSON(port, 'POST', '/api/hook/watch', {
        instance: 'myapp', pid: process.pid,
      });
      assert.equal(res.status, 200);
      assert.equal(res.data.status, 'active');
      assert.ok(res.data.sessionToken);
    });
  });

  it('defers when instance already active', async () => {
    await withServer({}, async (port) => {
      // First registration
      await httpJSON(port, 'POST', '/api/hook/watch', { instance: 'myapp', pid: process.pid });
      // Second registration attempt
      const res = await httpJSON(port, 'POST', '/api/hook/watch', { instance: 'myapp', pid: process.pid });
      assert.equal(res.data.status, 'deferred');
      assert.equal(res.data.currentState, 'ACTIVE');
    });
  });

  it('allows force takeover', async () => {
    await withServer({}, async (port) => {
      await httpJSON(port, 'POST', '/api/hook/watch', { instance: 'myapp', pid: process.pid });
      const res = await httpJSON(port, 'POST', '/api/hook/watch', {
        instance: 'myapp', pid: process.pid, force: true,
      });
      assert.equal(res.data.status, 'active');
      assert.ok(res.data.sessionToken);
    });
  });

  it('allows alternate name', async () => {
    await withServer({}, async (port) => {
      await httpJSON(port, 'POST', '/api/hook/watch', { instance: 'myapp', pid: process.pid });
      const res = await httpJSON(port, 'POST', '/api/hook/watch', {
        instance: 'myapp', name: 'myapp-2', pid: process.pid,
      });
      assert.equal(res.data.status, 'active');
    });
  });
});

describe('POST /api/hook/heartbeat', () => {
  beforeEach(() => { isolateConfig(); reset(); });

  it('updates lastSeen for valid session token', async () => {
    await withServer({}, async (port) => {
      const reg = await httpJSON(port, 'POST', '/api/hook/watch', { instance: 'myapp' });
      const res = await httpJSON(port, 'POST', '/api/hook/heartbeat', {
        sessionToken: reg.data.sessionToken,
      });
      assert.equal(res.status, 200);
      assert.equal(res.data.ok, true);
    });
  });

  it('returns false for unknown token', async () => {
    await withServer({}, async (port) => {
      const res = await httpJSON(port, 'POST', '/api/hook/heartbeat', {
        sessionToken: 'nonexistent',
      });
      assert.equal(res.data.ok, false);
    });
  });
});

describe('POST /api/hook/snooze', () => {
  beforeEach(() => { isolateConfig(); reset(); });

  it('deregisters instance', async () => {
    await withServer({}, async (port) => {
      const reg = await httpJSON(port, 'POST', '/api/hook/watch', { instance: 'myapp' });
      const res = await httpJSON(port, 'POST', '/api/hook/snooze', {
        sessionToken: reg.data.sessionToken,
      });
      assert.equal(res.data.ok, true);

      // Should now be unregistered — new registration should succeed
      const reg2 = await httpJSON(port, 'POST', '/api/hook/watch', { instance: 'myapp' });
      assert.equal(reg2.data.status, 'active');
    });
  });
});

describe('POST /api/hook/session-end', () => {
  beforeEach(() => { isolateConfig(); reset(); });

  it('cleans up registration', async () => {
    await withServer({}, async (port) => {
      const reg = await httpJSON(port, 'POST', '/api/hook/watch', { instance: 'myapp' });
      const res = await httpJSON(port, 'POST', '/api/hook/session-end', {
        sessionToken: reg.data.sessionToken,
      });
      assert.equal(res.data.ok, true);
    });
  });
});

// ── Hook endpoints (pre-bash, pre-icc-message) ──────────────────────

describe('POST /api/hook/pre-bash', () => {
  beforeEach(() => {
    isolateConfig({ remotes: { rpi0: { httpUrl: 'https://rpi0:3179' } } });
    reset();
  });

  it('warns about SSH to ICC peer', async () => {
    await withServer({ remotes: { rpi0: { httpUrl: 'https://rpi0:3179' } } }, async (port) => {
      const res = await httpJSON(port, 'POST', '/api/hook/pre-bash', {
        tool_input: { command: 'ssh rpi0 ls /tmp' },
      });
      assert.equal(res.status, 200);
      assert.ok(res.data.hookSpecificOutput?.additionalContext?.includes('rpi0'));
    });
  });

  it('returns empty for non-SSH commands', async () => {
    await withServer({}, async (port) => {
      const res = await httpJSON(port, 'POST', '/api/hook/pre-bash', {
        tool_input: { command: 'ls -la' },
      });
      assert.equal(res.status, 200);
      assert.deepEqual(res.data, {});
    });
  });
});

describe('POST /api/hook/pre-icc-message', () => {
  beforeEach(() => { isolateConfig(); reset(); });

  it('reminds about missing TOPIC and status', async () => {
    await withServer({}, async (port) => {
      const res = await httpJSON(port, 'POST', '/api/hook/pre-icc-message', {
        tool_input: { body: 'Hello there' },
      });
      assert.equal(res.status, 200);
      assert.ok(res.data.hookSpecificOutput?.additionalContext?.includes('[TOPIC:'));
    });
  });

  it('returns empty when conventions are met', async () => {
    await withServer({}, async (port) => {
      const res = await httpJSON(port, 'POST', '/api/hook/pre-icc-message', {
        tool_input: { body: '[TOPIC: test] Hello', status: 'FYI_ONLY' },
      });
      assert.equal(res.status, 200);
      assert.deepEqual(res.data, {});
    });
  });
});

// ── Watch long-poll endpoint ─────────────────────────────────────────

describe('GET /api/watch', () => {
  beforeEach(() => { isolateConfig(); reset(); });

  it('returns immediately if unread messages exist', async () => {
    await withServer({}, async (port) => {
      // Push a message to inbox
      await httpJSON(port, 'POST', '/api/inbox', {
        from: 'test/sender', body: 'Hello',
      });

      const res = await httpJSON(port, 'GET', '/api/watch?instance=myapp&token=x');
      assert.equal(res.status, 200);
      assert.equal(res.data.event, 'mail');
    });
  });

  it('rejects missing instance param', async () => {
    await withServer({}, async (port) => {
      const res = await httpJSON(port, 'GET', '/api/watch');
      assert.equal(res.status, 400);
    });
  });

  it('wakes on new inbox message', async () => {
    await withServer({}, async (port) => {
      // Mark all messages read first
      await httpJSON(port, 'POST', '/api/inbox/mark-read', { all: true });

      // Start a watch with a short timeout
      const watchPromise = httpJSON(port, 'GET', '/api/watch?instance=myapp');

      // Push a message after a short delay
      await new Promise(r => setTimeout(r, 50));
      await httpJSON(port, 'POST', '/api/inbox', { from: 'test/sender', body: 'Wake up!' });

      const res = await watchPromise;
      assert.equal(res.status, 200);
      assert.equal(res.data.event, 'mail');
    });
  });
});

import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { register, list, reset, deregister } from '../src/registry.ts';
import { reset as resetInstances, resolve as resolveInstance } from '../src/instances.ts';
import { createToolHandlers } from '../src/mcp.ts';
import type { ICCClient } from '../src/client.ts';
import { createTestEnv, isolateConfig, withServer, httpJSON } from './helpers.ts';

createTestEnv('icc-registry-test');

// --- Registry module unit tests ---

describe('Registry: register', () => {
  beforeEach(() => { isolateConfig(); reset(); });

  it('creates a new entry', () => {
    const entry = register({ instance: 'icc', pid: process.pid, address: 'test-host/icc' });
    assert.equal(entry.instance, 'icc');
    assert.equal(entry.pid, process.pid);
    assert.equal(entry.address, 'test-host/icc');
    assert.ok(entry.registeredAt);
    assert.ok(entry.lastSeen);
  });

  it('updates existing entry on re-register', () => {
    const first = register({ instance: 'icc', pid: process.pid, address: 'test-host/icc' });
    const origTime = first.registeredAt;
    const updated = register({ instance: 'icc', pid: process.pid + 1, address: 'test-host/icc' });
    assert.equal(updated.registeredAt, origTime);
    assert.equal(updated.pid, process.pid + 1);
    assert.ok(updated.lastSeen >= origTime);
  });

  it('throws on missing fields', () => {
    assert.throws(() => register({ instance: 'icc', pid: null as unknown as number, address: 'x' }), /Missing required/);
    assert.throws(() => register({ instance: '', pid: 123, address: 'x' }), /Missing required/);
    assert.throws(() => register({ instance: 'icc', pid: 123, address: '' }), /Missing required/);
  });
});

describe('Registry: list', () => {
  beforeEach(() => { isolateConfig(); reset(); });

  it('returns live instances', () => {
    register({ instance: 'icc', pid: process.pid, address: 'test-host/icc' });
    const result = list();
    assert.equal(result.length, 1);
    assert.equal(result[0]!.instance, 'icc');
  });

  it('prunes dead PIDs', () => {
    register({ instance: 'dead', pid: 999999999, address: 'test-host/dead' });
    register({ instance: 'alive', pid: process.pid, address: 'test-host/alive' });
    const result = list();
    assert.equal(result.length, 1);
    assert.equal(result[0]!.instance, 'alive');
  });
});

describe('Registry: reset', () => {
  beforeEach(() => { isolateConfig(); reset(); });

  it('clears all entries', () => {
    register({ instance: 'icc', pid: process.pid, address: 'test-host/icc' });
    reset();
    assert.equal(list().length, 0);
  });
});

describe('Registry: deregister', () => {
  beforeEach(() => { isolateConfig(); reset(); });

  it('removes an existing instance and returns true', () => {
    register({ instance: 'icc', pid: process.pid, address: 'test-host/icc' });
    const removed = deregister('icc', { pid: process.pid });
    assert.equal(removed, true);
    assert.equal(list().length, 0);
  });

  it('returns false for a nonexistent instance', () => {
    const removed = deregister('nonexistent');
    assert.equal(removed, false);
  });

  it('does not affect other instances', () => {
    register({ instance: 'icc', pid: process.pid, address: 'test-host/icc' });
    register({ instance: 'other', pid: process.pid, address: 'test-host/other' });
    deregister('icc', { pid: process.pid });
    const remaining = list();
    assert.equal(remaining.length, 1);
    assert.equal(remaining[0]!.instance, 'other');
  });

  it('refuses deregister when caller PID does not match', () => {
    register({ instance: 'icc', pid: process.pid, address: 'test-host/icc' });
    const removed = deregister('icc', { pid: 999999 });
    assert.equal(removed, false);
    assert.equal(list().length, 1);
  });

  it('allows deregister without PID when registered process is dead', () => {
    register({ instance: 'icc', pid: 999999999, address: 'test-host/icc' });
    const removed = deregister('icc');
    assert.equal(removed, true);
    assert.equal(list().length, 0);
  });

  it('allows deregister without PID when registered process is not Claude', () => {
    register({ instance: 'icc', pid: process.pid, address: 'test-host/icc' });
    const removed = deregister('icc');
    assert.equal(removed, true);
    assert.equal(list().length, 0);
  });
});

// --- Server integration tests ---

describe('Server: GET /api/registry', () => {
  beforeEach(() => { reset(); });

  it('lists registered instances with auth', async () => {
    await withServer({}, async (port) => {
      await httpJSON(port, 'POST', '/api/registry', { instance: 'icc', pid: process.pid });
      const res = await httpJSON(port, 'GET', '/api/registry');
      assert.equal(res.status, 200);
      assert.equal(res.data.host, 'test-host');
      assert.equal(res.data.instances.length, 1);
      assert.equal(res.data.instances[0].instance, 'icc');
      assert.equal(res.data.instances[0].address, 'test-host/icc');
    });
  });

  it('returns empty list when no instances registered', async () => {
    await withServer({}, async (port) => {
      const res = await httpJSON(port, 'GET', '/api/registry');
      assert.equal(res.status, 200);
      assert.equal(res.data.instances.length, 0);
    });
  });

  it('requires auth', async () => {
    await withServer({ localToken: 'test-auth-token' }, async (port) => {
      const res = await httpJSON(port, 'GET', '/api/registry');
      assert.equal(res.status, 401);
    });
  });
});

describe('Server: POST /api/registry', () => {
  beforeEach(() => { reset(); });

  it('registers an instance', async () => {
    await withServer({}, async (port) => {
      const res = await httpJSON(port, 'POST', '/api/registry', { instance: 'icc', pid: process.pid });
      assert.equal(res.status, 200);
      assert.ok(res.data.ok);
      assert.equal(res.data.entry.instance, 'icc');
      assert.equal(res.data.entry.address, 'test-host/icc');
    });
  });

  it('rejects missing fields', async () => {
    await withServer({}, async (port) => {
      const res1 = await httpJSON(port, 'POST', '/api/registry', { instance: 'icc' });
      assert.equal(res1.status, 400);
      const res2 = await httpJSON(port, 'POST', '/api/registry', { pid: 123 });
      assert.equal(res2.status, 400);
    });
  });

  it('requires auth', async () => {
    await withServer({ localToken: 'test-auth-token' }, async (port) => {
      const res = await httpJSON(port, 'POST', '/api/registry', { instance: 'icc', pid: process.pid }, 'wrong-token');
      assert.equal(res.status, 401);
    });
  });
});

// --- MCP tool: listInstances ---

describe('MCP tool: listInstances', () => {
  beforeEach(() => { isolateConfig(); reset(); });

  it('combines local and peer instances', async () => {
    const mockLocal = async (method: string, path: string) => {
      if (method === 'GET' && path === '/api/registry') {
        return { instances: [{ address: 'test-host/icc', instance: 'icc', pid: 100, registeredAt: '2026-01-01T00:00:00Z' }], host: 'test-host' };
      }
    };
    const mockPeer = async () => { throw new Error('should not be called'); };
    const handlers = createToolHandlers({} as ICCClient, mockPeer, mockLocal);
    const result = await handlers.listInstances();
    const text = result.content[0]!.text;
    assert.ok(text.includes('1 instance(s)'));
    assert.ok(text.includes('test-host/icc'));
    assert.ok(text.includes('[test-host]'));
  });

  it('handles local failure gracefully and surfaces error', async () => {
    const mockLocal = async () => { throw new Error('connection refused'); };
    const mockPeer = async () => { throw new Error('should not be called'); };
    const handlers = createToolHandlers({} as ICCClient, mockPeer, mockLocal);
    const result = await handlers.listInstances();
    const text = result.content[0]!.text;
    assert.ok(text.includes('No instances registered'));
    assert.ok(text.includes('local: connection refused'));
  });

  it('handles both failing gracefully and surfaces errors', async () => {
    const mockLocal = async () => { throw new Error('refused'); };
    const mockPeer = async () => { throw new Error('should not be called'); };
    const handlers = createToolHandlers({} as ICCClient, mockPeer, mockLocal);
    const result = await handlers.listInstances();
    const text = result.content[0]!.text;
    assert.ok(text.includes('No instances registered'));
    assert.ok(text.includes('local: refused'));
  });
});

// --- Server integration: DELETE /api/registry/:instance ---

describe('Server: DELETE /api/registry/:instance', () => {
  beforeEach(() => { reset(); });

  it('deregisters an existing instance with matching PID', async () => {
    await withServer({}, async (port) => {
      await httpJSON(port, 'POST', '/api/registry', { instance: 'icc', pid: process.pid });
      const before = await httpJSON(port, 'GET', '/api/registry');
      assert.equal(before.data.instances.length, 1);
      const res = await httpJSON(port, 'DELETE', `/api/registry/icc?pid=${process.pid}`);
      assert.equal(res.status, 200);
      assert.ok(res.data.ok);
      assert.equal(res.data.removed, true);
      const after = await httpJSON(port, 'GET', '/api/registry');
      assert.equal(after.data.instances.length, 0);
    });
  });

  it('refuses deregister with non-matching PID', async () => {
    await withServer({}, async (port) => {
      await httpJSON(port, 'POST', '/api/registry', { instance: 'icc', pid: process.pid });
      const res = await httpJSON(port, 'DELETE', '/api/registry/icc?pid=999999');
      assert.equal(res.status, 200);
      assert.equal(res.data.removed, false);
      const after = await httpJSON(port, 'GET', '/api/registry');
      assert.equal(after.data.instances.length, 1);
    });
  });

  it('returns removed: false for nonexistent instance', async () => {
    await withServer({}, async (port) => {
      const res = await httpJSON(port, 'DELETE', '/api/registry/nonexistent');
      assert.equal(res.status, 200);
      assert.ok(res.data.ok);
      assert.equal(res.data.removed, false);
    });
  });

  it('requires auth', async () => {
    await withServer({ localToken: 'test-auth-token' }, async (port) => {
      const res = await httpJSON(port, 'DELETE', '/api/registry/icc', null, 'wrong-token');
      assert.equal(res.status, 401);
    });
  });
});

// --- Server integration: GET /api/instances ---

describe('Server: GET /api/instances', () => {
  let instanceDir: string;
  beforeEach(() => {
    reset();
    instanceDir = mkdtempSync(join(tmpdir(), 'icc-instances-test-'));
    resetInstances(instanceDir);
  });

  it('returns persistent instance index with auth', async () => {
    resolveInstance('/home/user/code/my-project');
    resolveInstance('/home/user/code/other-project');
    await withServer({}, async (port) => {
      const res = await httpJSON(port, 'GET', '/api/instances');
      assert.equal(res.status, 200);
      assert.equal(res.data.host, 'test-host');
      assert.equal(res.data.instances.length, 2);
      assert.ok(res.data.instances.some((i: any) => i.name === 'my-project'));
      assert.ok(res.data.instances.some((i: any) => i.name === 'other-project'));
      assert.ok(res.data.instances[0].path);
    });
  });

  it('requires auth', async () => {
    await withServer({ localToken: 'test-auth-token' }, async (port) => {
      const res = await httpJSON(port, 'GET', '/api/instances', null, 'wrong-token');
      assert.equal(res.status, 401);
    });
  });

  it('returns empty list when no instances indexed', async () => {
    await withServer({}, async (port) => {
      const res = await httpJSON(port, 'GET', '/api/instances');
      assert.equal(res.status, 200);
      assert.equal(res.data.instances.length, 0);
    });
  });
});

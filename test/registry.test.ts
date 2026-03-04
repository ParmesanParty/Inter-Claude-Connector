import { describe, it, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { request } from 'node:http';
import { clearConfigCache, loadConfig } from '../src/config.ts';
import { reset as resetLog } from '../src/log.ts';
import { reset as resetInbox, init as initInbox } from '../src/inbox.ts';
import { register, list, prune, reset, deregister } from '../src/registry.ts';
import { reset as resetInstances, resolve as resolveInstance } from '../src/instances.ts';
import { createICCServer } from '../src/server.ts';
import { createToolHandlers } from '../src/mcp.ts';
import type { ICCClient } from '../src/client.ts';

interface HttpResponse {
  status: number | undefined;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  data: any;
}

process.env.ICC_IDENTITY = 'test-host';
process.env.ICC_AUTH_TOKEN = 'test-token-123';

// Redirect log + inbox to temp dirs
const testLogDir = mkdtempSync(join(tmpdir(), 'icc-registry-test-log-'));
resetLog(testLogDir);

function freshState(): void {
  const dir = mkdtempSync(join(tmpdir(), 'icc-registry-test-inbox-'));
  resetInbox(dir);
  initInbox();
  reset();
  clearConfigCache();
  const config = loadConfig();
  config.remotes = {};
  config.server.tls = { enabled: false, certPath: null, keyPath: null, caPath: null };
  config.server.localToken = null;
  config.server.peerTokens = {};
}

function httpRequest(port: number, method: string, path: string, body: Record<string, unknown> | null = null, token: string | null = 'test-token-123'): Promise<HttpResponse> {
  return new Promise((resolve, reject) => {
    const payload = body ? JSON.stringify(body) : null;
    const req = request(`http://127.0.0.1:${port}${path}`, {
      method,
      headers: {
        ...(payload && { 'Content-Type': 'application/json' }),
        ...(token && { 'Authorization': `Bearer ${token}` }),
      },
    }, (res) => {
      let data = '';
      res.on('data', (chunk: Buffer) => { data += chunk; });
      res.on('end', () => {
        resolve({
          status: res.statusCode,
          data: data ? JSON.parse(data) as Record<string, unknown> : null,
        });
      });
    });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

// --- Registry module unit tests ---

describe('Registry: register', () => {
  beforeEach(freshState);

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
    assert.equal(updated.registeredAt, origTime); // registeredAt preserved
    assert.equal(updated.pid, process.pid + 1); // pid updated
    assert.ok(updated.lastSeen >= origTime); // lastSeen at least as recent
  });

  it('throws on missing fields', () => {
    assert.throws(() => register({ instance: 'icc', pid: null as unknown as number, address: 'x' }), /Missing required/);
    assert.throws(() => register({ instance: '', pid: 123, address: 'x' }), /Missing required/);
    assert.throws(() => register({ instance: 'icc', pid: 123, address: '' }), /Missing required/);
  });
});

describe('Registry: list', () => {
  beforeEach(freshState);

  it('returns live instances', () => {
    register({ instance: 'icc', pid: process.pid, address: 'test-host/icc' });
    const result = list();
    assert.equal(result.length, 1);
    assert.equal(result[0]!.instance, 'icc');
  });

  it('prunes dead PIDs', () => {
    // Use a PID that almost certainly does not exist
    register({ instance: 'dead', pid: 999999999, address: 'test-host/dead' });
    register({ instance: 'alive', pid: process.pid, address: 'test-host/alive' });
    const result = list();
    assert.equal(result.length, 1);
    assert.equal(result[0]!.instance, 'alive');
  });
});

describe('Registry: reset', () => {
  beforeEach(freshState);

  it('clears all entries', () => {
    register({ instance: 'icc', pid: process.pid, address: 'test-host/icc' });
    reset();
    assert.equal(list().length, 0);
  });
});

describe('Registry: deregister', () => {
  beforeEach(freshState);

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
    // process.pid is the test runner (node), not claude/icc-mcp
    register({ instance: 'icc', pid: process.pid, address: 'test-host/icc' });
    const removed = deregister('icc');
    assert.equal(removed, true);
    assert.equal(list().length, 0);
  });
});

// --- Server integration tests ---

describe('Server: GET /api/registry', () => {
  beforeEach(freshState);

  it('lists registered instances with auth', async () => {
    const s = createICCServer({ host: '127.0.0.1', port: 0 });
    const { port } = await s.start();
    try {
      // Register via POST first
      await httpRequest(port, 'POST', '/api/registry', {
        instance: 'icc', pid: process.pid,
      });
      // GET with auth token
      const res = await httpRequest(port, 'GET', '/api/registry');
      assert.equal(res.status, 200);
      assert.equal(res.data.host, 'test-host');
      assert.equal(res.data.instances.length, 1);
      assert.equal(res.data.instances[0].instance, 'icc');
      assert.equal(res.data.instances[0].address, 'test-host/icc');
    } finally {
      await s.stop();
    }
  });

  it('returns empty list when no instances registered', async () => {
    const s = createICCServer({ host: '127.0.0.1', port: 0 });
    const { port } = await s.start();
    try {
      const res = await httpRequest(port, 'GET', '/api/registry');
      assert.equal(res.status, 200);
      assert.equal(res.data.instances.length, 0);
    } finally {
      await s.stop();
    }
  });

  it('requires auth', async () => {
    clearConfigCache();
    const config = loadConfig();
    config.remotes = {};
    config.server.tls = { enabled: false, certPath: null, keyPath: null, caPath: null };
    config.server.localToken = 'test-auth-token';
    config.server.peerTokens = {};
    const s = createICCServer({ host: '127.0.0.1', port: 0 });
    const { port } = await s.start();
    try {
      const res = await httpRequest(port, 'GET', '/api/registry', null, null);
      assert.equal(res.status, 401);
    } finally {
      await s.stop();
    }
  });
});

describe('Server: POST /api/registry', () => {
  beforeEach(freshState);

  it('registers an instance', async () => {
    const s = createICCServer({ host: '127.0.0.1', port: 0 });
    const { port } = await s.start();
    try {
      const res = await httpRequest(port, 'POST', '/api/registry', {
        instance: 'icc', pid: process.pid,
      });
      assert.equal(res.status, 200);
      assert.ok(res.data.ok);
      assert.equal(res.data.entry.instance, 'icc');
      assert.equal(res.data.entry.address, 'test-host/icc');
    } finally {
      await s.stop();
    }
  });

  it('rejects missing fields', async () => {
    const s = createICCServer({ host: '127.0.0.1', port: 0 });
    const { port } = await s.start();
    try {
      const res1 = await httpRequest(port, 'POST', '/api/registry', { instance: 'icc' });
      assert.equal(res1.status, 400);
      const res2 = await httpRequest(port, 'POST', '/api/registry', { pid: 123 });
      assert.equal(res2.status, 400);
    } finally {
      await s.stop();
    }
  });

  it('requires auth', async () => {
    clearConfigCache();
    const config = loadConfig();
    config.remotes = {};
    config.server.tls = { enabled: false, certPath: null, keyPath: null, caPath: null };
    config.server.localToken = 'test-auth-token';
    config.server.peerTokens = {};
    const s = createICCServer({ host: '127.0.0.1', port: 0 });
    const { port } = await s.start();
    try {
      const res = await httpRequest(port, 'POST', '/api/registry', {
        instance: 'icc', pid: process.pid,
      }, 'wrong-token');
      assert.equal(res.status, 401);
    } finally {
      await s.stop();
    }
  });
});

// --- MCP tool: listInstances ---

describe('MCP tool: listInstances', () => {
  beforeEach(freshState);

  it('combines local and peer instances', async () => {
    const mockLocal = async (method: string, path: string) => {
      if (method === 'GET' && path === '/api/registry') {
        return { instances: [{ address: 'test-host/icc', instance: 'icc', pid: 100, registeredAt: '2026-01-01T00:00:00Z' }], host: 'test-host' };
      }
    };
    // peerAPI won't be called since there are no configured peers (empty remotes)
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
  beforeEach(freshState);

  it('deregisters an existing instance with matching PID', async () => {
    const s = createICCServer({ host: '127.0.0.1', port: 0 });
    const { port } = await s.start();
    try {
      // Register first
      await httpRequest(port, 'POST', '/api/registry', {
        instance: 'icc', pid: process.pid,
      });
      // Verify it's there
      const before = await httpRequest(port, 'GET', '/api/registry');
      assert.equal(before.data.instances.length, 1);
      // Deregister with matching PID
      const res = await httpRequest(port, 'DELETE', `/api/registry/icc?pid=${process.pid}`);
      assert.equal(res.status, 200);
      assert.ok(res.data.ok);
      assert.equal(res.data.removed, true);
      // Verify it's gone
      const after = await httpRequest(port, 'GET', '/api/registry');
      assert.equal(after.data.instances.length, 0);
    } finally {
      await s.stop();
    }
  });

  it('refuses deregister with non-matching PID', async () => {
    const s = createICCServer({ host: '127.0.0.1', port: 0 });
    const { port } = await s.start();
    try {
      await httpRequest(port, 'POST', '/api/registry', {
        instance: 'icc', pid: process.pid,
      });
      // Try to deregister with wrong PID
      const res = await httpRequest(port, 'DELETE', '/api/registry/icc?pid=999999');
      assert.equal(res.status, 200);
      assert.equal(res.data.removed, false);
      // Verify it's still there
      const after = await httpRequest(port, 'GET', '/api/registry');
      assert.equal(after.data.instances.length, 1);
    } finally {
      await s.stop();
    }
  });

  it('returns removed: false for nonexistent instance', async () => {
    const s = createICCServer({ host: '127.0.0.1', port: 0 });
    const { port } = await s.start();
    try {
      const res = await httpRequest(port, 'DELETE', '/api/registry/nonexistent');
      assert.equal(res.status, 200);
      assert.ok(res.data.ok);
      assert.equal(res.data.removed, false);
    } finally {
      await s.stop();
    }
  });

  it('requires auth', async () => {
    clearConfigCache();
    const config = loadConfig();
    config.remotes = {};
    config.server.tls = { enabled: false, certPath: null, keyPath: null, caPath: null };
    config.server.localToken = 'test-auth-token';
    config.server.peerTokens = {};
    const s = createICCServer({ host: '127.0.0.1', port: 0 });
    const { port } = await s.start();
    try {
      const res = await httpRequest(port, 'DELETE', '/api/registry/icc', null, 'wrong-token');
      assert.equal(res.status, 401);
    } finally {
      await s.stop();
    }
  });
});

// --- Server integration: GET /api/instances ---

describe('Server: GET /api/instances', () => {
  let instanceDir: string;
  beforeEach(() => {
    freshState();
    instanceDir = mkdtempSync(join(tmpdir(), 'icc-instances-test-'));
    resetInstances(instanceDir);
  });

  it('returns persistent instance index with auth', async () => {
    // Populate the persistent index
    resolveInstance('/home/user/code/my-project');
    resolveInstance('/home/user/code/other-project');

    const s = createICCServer({ host: '127.0.0.1', port: 0 });
    const { port } = await s.start();
    try {
      const res = await httpRequest(port, 'GET', '/api/instances');
      assert.equal(res.status, 200);
      assert.equal(res.data.host, 'test-host');
      assert.equal(res.data.instances.length, 2);
      assert.ok(res.data.instances.some((i: any) => i.name === 'my-project'));
      assert.ok(res.data.instances.some((i: any) => i.name === 'other-project'));
      assert.ok(res.data.instances[0].path);
    } finally {
      await s.stop();
    }
  });

  it('requires auth', async () => {
    clearConfigCache();
    const config = loadConfig();
    config.remotes = {};
    config.server.tls = { enabled: false, certPath: null, keyPath: null, caPath: null };
    config.server.localToken = 'test-auth-token';
    config.server.peerTokens = {};
    const s = createICCServer({ host: '127.0.0.1', port: 0 });
    const { port } = await s.start();
    try {
      const res = await httpRequest(port, 'GET', '/api/instances', null, 'wrong-token');
      assert.equal(res.status, 401);
    } finally {
      await s.stop();
    }
  });

  it('returns empty list when no instances indexed', async () => {
    const s = createICCServer({ host: '127.0.0.1', port: 0 });
    const { port } = await s.start();
    try {
      const res = await httpRequest(port, 'GET', '/api/instances');
      assert.equal(res.status, 200);
      assert.equal(res.data.instances.length, 0);
    } finally {
      await s.stop();
    }
  });
});

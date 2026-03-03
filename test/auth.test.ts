import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { request } from 'node:http';
import { clearConfigCache, loadConfig, getOutboundToken, getLocalToken } from '../src/config.ts';
import { createICCServer } from '../src/server.ts';
import { reset as resetLog } from '../src/log.ts';
import { reset as resetInbox, init as initInbox } from '../src/inbox.ts';
import type { TlsConfig, ICCConfig } from '../src/types.ts';

// Redirect log and inbox to temp dirs
const testDir = mkdtempSync(join(tmpdir(), 'icc-auth-test-'));
resetLog(testDir);
resetInbox(testDir);
initInbox();

beforeEach(() => {
  clearConfigCache();
});

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function httpRequest(port: number, method: string, path: string, body: any = null, token: string | null = null): Promise<{ status: number | undefined; data: any }> {
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
      res.on('data', (chunk: string) => { data += chunk; });
      res.on('end', () => {
        resolve({
          status: res.statusCode,
          data: data ? JSON.parse(data) : null,
        });
      });
    });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

// --- Config helper tests ---

describe('getOutboundToken', () => {
  it('returns peer-specific token when configured', () => {
    const config = {
      server: { authToken: 'legacy' },
      remotes: { peerA: { token: 'peer-token', httpUrl: 'http://x' } },
    } as unknown as ICCConfig;
    assert.equal(getOutboundToken(config, 'peerA'), 'peer-token');
  });

  it('falls back to authToken when peer has no token', () => {
    const config = {
      server: { authToken: 'legacy' },
      remotes: { peerA: { httpUrl: 'http://x' } },
    } as unknown as ICCConfig;
    assert.equal(getOutboundToken(config, 'peerA'), 'legacy');
  });

  it('returns null when no tokens at all', () => {
    const config = {
      server: { authToken: null },
      remotes: { peerA: { httpUrl: 'http://x' } },
    } as unknown as ICCConfig;
    assert.equal(getOutboundToken(config, 'peerA'), null);
  });

  it('returns null for unknown peer with no authToken', () => {
    const config = {
      server: { authToken: null },
      remotes: {},
    } as unknown as ICCConfig;
    assert.equal(getOutboundToken(config, 'unknown'), null);
  });
});

describe('getLocalToken', () => {
  it('returns localToken when configured', () => {
    const config = { server: { localToken: 'local-tok', authToken: 'legacy' } } as unknown as ICCConfig;
    assert.equal(getLocalToken(config), 'local-tok');
  });

  it('falls back to authToken when no localToken', () => {
    const config = { server: { localToken: null, authToken: 'legacy' } } as unknown as ICCConfig;
    assert.equal(getLocalToken(config), 'legacy');
  });

  it('returns null when nothing configured', () => {
    const config = { server: { localToken: null, authToken: null } } as unknown as ICCConfig;
    assert.equal(getLocalToken(config), null);
  });
});

// --- Server auth integration tests ---

interface TokenConfig {
  authToken?: string | null;
  localToken?: string | null;
  peerTokens?: Record<string, string>;
}

describe('Server: checkAuth resolution', () => {
  // Helper to create a server with specific token config
  async function withServer(tokenConfig: TokenConfig, fn: (port: number) => Promise<void>): Promise<void> {
    process.env.ICC_IDENTITY = 'test-host';
    delete process.env.ICC_AUTH_TOKEN;
    delete process.env.ICC_LOCAL_TOKEN;
    clearConfigCache();
    const config = loadConfig();
    config.remotes = {};
    config.server.tls = { enabled: false } as TlsConfig;
    // Apply token config
    config.server.authToken = tokenConfig.authToken ?? null;
    config.server.localToken = tokenConfig.localToken ?? null;
    config.server.peerTokens = tokenConfig.peerTokens ?? {};

    const s = createICCServer({ host: '127.0.0.1', port: 0 });
    const info = await s.start();
    try {
      await fn(info.port);
    } finally {
      await s.stop();
    }
  }

  it('allows unauthenticated when no tokens configured', async () => {
    await withServer({}, async (port) => {
      const res = await httpRequest(port, 'GET', '/api/registry');
      assert.equal(res.status, 200);
    });
  });

  it('authenticates with localToken', async () => {
    await withServer({ localToken: 'local-secret' }, async (port) => {
      const res = await httpRequest(port, 'GET', '/api/registry', null, 'local-secret');
      assert.equal(res.status, 200);
    });
  });

  it('authenticates with peerToken', async () => {
    await withServer({ peerTokens: { peerA: 'peerA-secret' } }, async (port) => {
      const res = await httpRequest(port, 'GET', '/api/registry', null, 'peerA-secret');
      assert.equal(res.status, 200);
    });
  });

  it('authenticates with legacy authToken', async () => {
    await withServer({ authToken: 'legacy-secret' }, async (port) => {
      const res = await httpRequest(port, 'GET', '/api/registry', null, 'legacy-secret');
      assert.equal(res.status, 200);
    });
  });

  it('rejects invalid token', async () => {
    await withServer({ localToken: 'correct' }, async (port) => {
      const res = await httpRequest(port, 'GET', '/api/registry', null, 'wrong-token');
      assert.equal(res.status, 401);
    });
  });

  it('rejects missing token when tokens are configured', async () => {
    await withServer({ localToken: 'correct' }, async (port) => {
      const res = await httpRequest(port, 'GET', '/api/registry');
      assert.equal(res.status, 401);
    });
  });

  it('accepts token via query param (for SSE)', async () => {
    await withServer({ localToken: 'local-secret' }, async (port) => {
      // The events endpoint is SSE — we just check it doesn't 401
      const res = await httpRequest(port, 'GET', '/api/registry?token=local-secret');
      assert.equal(res.status, 200);
    });
  });
});

// --- from-validation tests ---

describe('Server: validateFrom on /api/message', () => {
  async function withServer(tokenConfig: TokenConfig, fn: (port: number) => Promise<void>): Promise<void> {
    process.env.ICC_IDENTITY = 'test-host';
    delete process.env.ICC_AUTH_TOKEN;
    delete process.env.ICC_LOCAL_TOKEN;
    clearConfigCache();
    const config = loadConfig();
    config.remotes = {};
    config.server.tls = { enabled: false } as TlsConfig;
    config.server.authToken = tokenConfig.authToken ?? null;
    config.server.localToken = tokenConfig.localToken ?? null;
    config.server.peerTokens = tokenConfig.peerTokens ?? {};

    const s = createICCServer({ host: '127.0.0.1', port: 0 });
    const info = await s.start();
    try {
      await fn(info.port);
    } finally {
      await s.stop();
    }
  }

  function makeMessage(from: string) {
    return {
      version: '1',
      id: 'test-' + Math.random().toString(36).slice(2),
      type: 'ping',
      from,
      timestamp: new Date().toISOString(),
      payload: {},
    };
  }

  it('peer token: accepts matching from', async () => {
    await withServer({ peerTokens: { peerA: 'peerA-secret' } }, async (port) => {
      const msg = makeMessage('peerA');
      const res = await httpRequest(port, 'POST', '/api/message', msg, 'peerA-secret');
      assert.equal(res.status, 200);
      assert.equal(res.data.type, 'pong');
    });
  });

  it('peer token: accepts from with instance', async () => {
    await withServer({ peerTokens: { peerA: 'peerA-secret' } }, async (port) => {
      const msg = makeMessage('peerA/icc');
      const res = await httpRequest(port, 'POST', '/api/message', msg, 'peerA-secret');
      assert.equal(res.status, 200);
    });
  });

  it('peer token: rejects mismatched from', async () => {
    await withServer({ peerTokens: { peerA: 'peerA-secret' } }, async (port) => {
      const msg = makeMessage('peerB');
      const res = await httpRequest(port, 'POST', '/api/message', msg, 'peerA-secret');
      assert.equal(res.status, 403);
      assert.ok(res.data.error.includes('identity mismatch'));
    });
  });

  it('local token: accepts any from', async () => {
    await withServer({ localToken: 'local-secret' }, async (port) => {
      const msg = makeMessage('anything');
      const res = await httpRequest(port, 'POST', '/api/message', msg, 'local-secret');
      assert.equal(res.status, 200);
    });
  });

  it('legacy token: accepts any from', async () => {
    await withServer({ authToken: 'legacy-secret' }, async (port) => {
      const msg = makeMessage('anything');
      const res = await httpRequest(port, 'POST', '/api/message', msg, 'legacy-secret');
      assert.equal(res.status, 200);
    });
  });
});

describe('Server: validateFrom on /api/inbox', () => {
  async function withServer(tokenConfig: TokenConfig, fn: (port: number) => Promise<void>): Promise<void> {
    process.env.ICC_IDENTITY = 'test-host';
    delete process.env.ICC_AUTH_TOKEN;
    delete process.env.ICC_LOCAL_TOKEN;
    clearConfigCache();
    const config = loadConfig();
    config.remotes = {};
    config.server.tls = { enabled: false } as TlsConfig;
    config.server.authToken = tokenConfig.authToken ?? null;
    config.server.localToken = tokenConfig.localToken ?? null;
    config.server.peerTokens = tokenConfig.peerTokens ?? {};

    const s = createICCServer({ host: '127.0.0.1', port: 0 });
    const info = await s.start();
    try {
      await fn(info.port);
    } finally {
      await s.stop();
    }
  }

  it('peer token: accepts matching from in inbox push', async () => {
    await withServer({ peerTokens: { peerA: 'peerA-secret' } }, async (port) => {
      const res = await httpRequest(port, 'POST', '/api/inbox',
        { from: 'peerA/icc', body: 'hello' }, 'peerA-secret');
      assert.equal(res.status, 200);
      assert.ok(res.data.id);
    });
  });

  it('peer token: rejects mismatched from in inbox push', async () => {
    await withServer({ peerTokens: { peerA: 'peerA-secret' } }, async (port) => {
      const res = await httpRequest(port, 'POST', '/api/inbox',
        { from: 'peerB/icc', body: 'spoofed' }, 'peerA-secret');
      assert.equal(res.status, 403);
      assert.ok(res.data.error.includes('identity mismatch'));
    });
  });

  it('local token: accepts any from in inbox push', async () => {
    await withServer({ localToken: 'local-secret' }, async (port) => {
      const res = await httpRequest(port, 'POST', '/api/inbox',
        { from: 'peerA/icc', body: 'from local' }, 'local-secret');
      assert.equal(res.status, 200);
    });
  });

  it('legacy token: accepts any from in inbox push', async () => {
    await withServer({ authToken: 'legacy-secret' }, async (port) => {
      const res = await httpRequest(port, 'POST', '/api/inbox',
        { from: 'peerA/icc', body: 'from legacy' }, 'legacy-secret');
      assert.equal(res.status, 200);
    });
  });
});

// --- Token priority tests ---

describe('Server: token resolution priority', () => {
  async function withServer(tokenConfig: TokenConfig, fn: (port: number) => Promise<void>): Promise<void> {
    process.env.ICC_IDENTITY = 'test-host';
    delete process.env.ICC_AUTH_TOKEN;
    delete process.env.ICC_LOCAL_TOKEN;
    clearConfigCache();
    const config = loadConfig();
    config.remotes = {};
    config.server.tls = { enabled: false } as TlsConfig;
    config.server.authToken = tokenConfig.authToken ?? null;
    config.server.localToken = tokenConfig.localToken ?? null;
    config.server.peerTokens = tokenConfig.peerTokens ?? {};

    const s = createICCServer({ host: '127.0.0.1', port: 0 });
    const info = await s.start();
    try {
      await fn(info.port);
    } finally {
      await s.stop();
    }
  }

  it('localToken takes precedence over peerToken with same value', async () => {
    // If localToken and a peerToken have different values,
    // using the localToken should resolve as _local (no from-validation)
    await withServer(
      { localToken: 'local-tok', peerTokens: { peerA: 'peerA-tok' } },
      async (port) => {
        // Using local token — can send from any identity
        const res = await httpRequest(port, 'POST', '/api/inbox',
          { from: 'peerB/spoofed', body: 'test' }, 'local-tok');
        assert.equal(res.status, 200);

        // Using peerA peer token — can only send from peerA
        const res2 = await httpRequest(port, 'POST', '/api/inbox',
          { from: 'peerB/spoofed', body: 'test' }, 'peerA-tok');
        assert.equal(res2.status, 403);
      }
    );
  });

  it('peerToken checked before legacy authToken', async () => {
    await withServer(
      { authToken: 'legacy-tok', peerTokens: { peerA: 'peerA-tok' } },
      async (port) => {
        // Using peerA peer token — from-validated as peerA
        const res = await httpRequest(port, 'POST', '/api/inbox',
          { from: 'peerA/icc', body: 'test' }, 'peerA-tok');
        assert.equal(res.status, 200);

        // Same peer token but wrong from — rejected
        const res2 = await httpRequest(port, 'POST', '/api/inbox',
          { from: 'peerB/icc', body: 'test' }, 'peerA-tok');
        assert.equal(res2.status, 403);

        // Legacy token — no from-validation (accepted)
        const res3 = await httpRequest(port, 'POST', '/api/inbox',
          { from: 'peerB/icc', body: 'test' }, 'legacy-tok');
        assert.equal(res3.status, 200);
      }
    );
  });
});

// --- ENV override ---

describe('ICC_LOCAL_TOKEN env override', () => {
  it('overrides config file localToken', () => {
    process.env.ICC_IDENTITY = 'test-host';
    process.env.ICC_LOCAL_TOKEN = 'env-local-token';
    clearConfigCache();
    const config = loadConfig();
    assert.equal(config.server.localToken, 'env-local-token');
    delete process.env.ICC_LOCAL_TOKEN;
    clearConfigCache();
  });

  it('empty string clears localToken', () => {
    process.env.ICC_IDENTITY = 'test-host';
    process.env.ICC_LOCAL_TOKEN = '';
    clearConfigCache();
    const config = loadConfig();
    assert.equal(config.server.localToken, null);
    delete process.env.ICC_LOCAL_TOKEN;
    clearConfigCache();
  });
});

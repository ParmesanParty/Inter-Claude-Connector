import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { clearConfigCache, loadConfig, getOutboundToken, getLocalToken } from '../src/config.ts';
import { createICCServer } from '../src/server.ts';
import type { ICCConfig } from '../src/types.ts';
import { createTestEnv, isolateConfig, withServer, httpJSON, withEnv } from './helpers.ts';

createTestEnv('icc-auth-test');

// --- Config helper tests ---

describe('getOutboundToken', () => {
  it('returns peer-specific token when configured', () => {
    const config = {
      server: {},
      remotes: { peerA: { token: 'peer-token', httpUrl: 'http://x' } },
    } as unknown as ICCConfig;
    assert.equal(getOutboundToken(config, 'peerA'), 'peer-token');
  });

  it('should NOT fall back to legacy authToken', () => {
    const config = {
      server: {},
      remotes: { peerA: { httpUrl: 'http://x' } },
    } as unknown as ICCConfig;
    assert.equal(getOutboundToken(config, 'peerA'), null);
  });

  it('returns null when no tokens at all', () => {
    const config = {
      server: {},
      remotes: { peerA: { httpUrl: 'http://x' } },
    } as unknown as ICCConfig;
    assert.equal(getOutboundToken(config, 'peerA'), null);
  });

  it('returns null for unknown peer', () => {
    const config = {
      server: {},
      remotes: {},
    } as unknown as ICCConfig;
    assert.equal(getOutboundToken(config, 'unknown'), null);
  });
});

describe('getLocalToken', () => {
  it('returns localToken when configured', () => {
    const config = { server: { localToken: 'local-tok' } } as unknown as ICCConfig;
    assert.equal(getLocalToken(config), 'local-tok');
  });

  it('should NOT fall back to legacy authToken', () => {
    const config = { server: { localToken: null } } as unknown as ICCConfig;
    assert.equal(getLocalToken(config), null);
  });

  it('returns null when nothing configured', () => {
    const config = { server: { localToken: null } } as unknown as ICCConfig;
    assert.equal(getLocalToken(config), null);
  });
});

// --- Server auth integration tests ---

describe('Server: checkAuth resolution', () => {
  it('allows unauthenticated when no tokens configured', async () => {
    await withServer({}, async (port) => {
      const res = await httpJSON(port, 'GET', '/api/registry');
      assert.equal(res.status, 200);
    });
  });

  it('authenticates with localToken', async () => {
    await withServer({ localToken: 'local-secret' }, async (port) => {
      const res = await httpJSON(port, 'GET', '/api/registry', null, 'local-secret');
      assert.equal(res.status, 200);
    });
  });

  it('authenticates with peerToken', async () => {
    await withServer({ peerTokens: { peerA: 'peerA-secret' } }, async (port) => {
      const res = await httpJSON(port, 'GET', '/api/registry', null, 'peerA-secret');
      assert.equal(res.status, 200);
    });
  });

  it('rejects invalid token', async () => {
    await withServer({ localToken: 'correct' }, async (port) => {
      const res = await httpJSON(port, 'GET', '/api/registry', null, 'wrong-token');
      assert.equal(res.status, 401);
    });
  });

  it('rejects missing token when tokens are configured', async () => {
    await withServer({ localToken: 'correct' }, async (port) => {
      const res = await httpJSON(port, 'GET', '/api/registry');
      assert.equal(res.status, 401);
    });
  });

  it('accepts token via query param (for SSE)', async () => {
    await withServer({ localToken: 'local-secret' }, async (port) => {
      const res = await httpJSON(port, 'GET', '/api/registry?token=local-secret');
      assert.equal(res.status, 200);
    });
  });
});

// --- from-validation tests ---

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

describe('Server: validateFrom on /api/message', () => {
  it('peer token: accepts matching from', async () => {
    await withServer({ peerTokens: { peerA: 'peerA-secret' } }, async (port) => {
      const msg = makeMessage('peerA');
      const res = await httpJSON(port, 'POST', '/api/message', msg, 'peerA-secret');
      assert.equal(res.status, 200);
      assert.equal(res.data.type, 'pong');
    });
  });

  it('peer token: accepts from with instance', async () => {
    await withServer({ peerTokens: { peerA: 'peerA-secret' } }, async (port) => {
      const msg = makeMessage('peerA/icc');
      const res = await httpJSON(port, 'POST', '/api/message', msg, 'peerA-secret');
      assert.equal(res.status, 200);
    });
  });

  it('peer token: rejects mismatched from', async () => {
    await withServer({ peerTokens: { peerA: 'peerA-secret' } }, async (port) => {
      const msg = makeMessage('peerB');
      const res = await httpJSON(port, 'POST', '/api/message', msg, 'peerA-secret');
      assert.equal(res.status, 403);
      assert.ok(res.data.error.includes('identity mismatch'));
    });
  });

  it('local token: accepts any from', async () => {
    await withServer({ localToken: 'local-secret' }, async (port) => {
      const msg = makeMessage('anything');
      const res = await httpJSON(port, 'POST', '/api/message', msg, 'local-secret');
      assert.equal(res.status, 200);
    });
  });
});

describe('Server: validateFrom on /api/inbox', () => {
  it('peer token: accepts matching from in inbox push', async () => {
    await withServer({ peerTokens: { peerA: 'peerA-secret' } }, async (port) => {
      const res = await httpJSON(port, 'POST', '/api/inbox',
        { from: 'peerA/icc', body: 'hello' }, 'peerA-secret');
      assert.equal(res.status, 200);
      assert.ok(res.data.id);
    });
  });

  it('peer token: rejects mismatched from in inbox push', async () => {
    await withServer({ peerTokens: { peerA: 'peerA-secret' } }, async (port) => {
      const res = await httpJSON(port, 'POST', '/api/inbox',
        { from: 'peerB/icc', body: 'spoofed' }, 'peerA-secret');
      assert.equal(res.status, 403);
      assert.ok(res.data.error.includes('identity mismatch'));
    });
  });

  it('local token: accepts any from in inbox push', async () => {
    await withServer({ localToken: 'local-secret' }, async (port) => {
      const res = await httpJSON(port, 'POST', '/api/inbox',
        { from: 'peerA/icc', body: 'from local' }, 'local-secret');
      assert.equal(res.status, 200);
    });
  });
});

// --- Token priority tests ---

describe('Server: token resolution priority', () => {
  it('localToken takes precedence over peerToken with same value', async () => {
    await withServer(
      { localToken: 'local-tok', peerTokens: { peerA: 'peerA-tok' } },
      async (port) => {
        // Using local token — can send from any identity
        const res = await httpJSON(port, 'POST', '/api/inbox',
          { from: 'peerB/spoofed', body: 'test' }, 'local-tok');
        assert.equal(res.status, 200);

        // Using peerA peer token — can only send from peerA
        const res2 = await httpJSON(port, 'POST', '/api/inbox',
          { from: 'peerB/spoofed', body: 'test' }, 'peerA-tok');
        assert.equal(res2.status, 403);
      }
    );
  });
});

// --- auth-required startup ---

describe('auth-required startup', () => {
  it('should throw on start if no auth configured and no noAuth', async () => {
    isolateConfig({ identity: 'no-auth-test' });
    const s = createICCServer({ host: '127.0.0.1', port: 0 });
    await assert.rejects(s.start(), /No authentication configured/);
  });

  it('should allow start with noAuth option', async () => {
    isolateConfig({ identity: 'no-auth-test' });
    const s = createICCServer({ host: '127.0.0.1', port: 0, noAuth: true });
    const info = await s.start();
    await s.stop();
    assert.ok(info.port > 0);
  });
});

// --- ENV override ---

describe('ICC_LOCAL_TOKEN env override', () => {
  it('overrides config file localToken', async () => {
    // Can't use isolateConfig() here — it overrides localToken after loadConfig
    await withEnv({ ICC_IDENTITY: 'test-host', ICC_LOCAL_TOKEN: 'env-local-token' }, () => {
      clearConfigCache();
      const config = loadConfig();
      assert.equal(config.server.localToken, 'env-local-token');
    });
  });

  it('empty string clears localToken', async () => {
    await withEnv({ ICC_IDENTITY: 'test-host', ICC_LOCAL_TOKEN: '' }, () => {
      clearConfigCache();
      const config = loadConfig();
      assert.equal(config.server.localToken, null);
    });
  });
});

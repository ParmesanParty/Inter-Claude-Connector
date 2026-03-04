import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { request } from 'node:http';
import { clearConfigCache, loadConfig } from '../src/config.ts';
import { createICCServer } from '../src/server.ts';
import { reset as resetLog } from '../src/log.ts';
import { reset as resetInbox, init as initInbox } from '../src/inbox.ts';
import type { TlsConfig } from '../src/types.ts';

const testDir = mkdtempSync(join(tmpdir(), 'icc-mesh-update-test-'));
resetLog(testDir);
resetInbox(testDir);
initInbox();

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

describe('/api/mesh-update', () => {
  let port: number;
  let stopServer: () => Promise<void>;

  beforeEach(async () => {
    process.env.ICC_IDENTITY = 'test-host';
    clearConfigCache();
    const config = loadConfig();
    config.remotes = {};
    config.server.tls = { enabled: false } as TlsConfig;
    config.server.localToken = 'local-tok';
    config.server.peerTokens = { 'ca-host': 'ca-secret' };
    config.tls = { ca: 'ca-host' };

    const s = createICCServer({ host: '127.0.0.1', port: 0 });
    const info = await s.start();
    port = info.port;
    stopServer = () => s.stop();
  });

  it('accepts add-peer from CA identity', async () => {
    try {
      const res = await httpRequest(port, 'POST', '/api/mesh-update', {
        action: 'add-peer',
        peer: {
          identity: 'new-peer',
          httpsUrl: 'https://192.168.1.100:3179',
          peerToken: 'inbound-from-new',
        },
        outboundToken: 'outbound-to-new',
      }, 'ca-secret');
      assert.equal(res.status, 200);
      assert.ok(res.data.ok);
      assert.equal(res.data.peer, 'new-peer');
    } finally {
      await stopServer();
    }
  });

  it('rejects non-CA identity', async () => {
    try {
      const res = await httpRequest(port, 'POST', '/api/mesh-update', {
        action: 'add-peer',
        peer: { identity: 'x', httpsUrl: 'https://x:3179', peerToken: 'x' },
        outboundToken: 'x',
      }, 'local-tok');
      assert.equal(res.status, 403);
    } finally {
      await stopServer();
    }
  });

  it('rejects unauthenticated request', async () => {
    try {
      const res = await httpRequest(port, 'POST', '/api/mesh-update', {
        action: 'add-peer',
        peer: { identity: 'x', httpsUrl: 'https://x:3179', peerToken: 'x' },
        outboundToken: 'x',
      });
      assert.equal(res.status, 401);
    } finally {
      await stopServer();
    }
  });

  it('rejects invalid payload', async () => {
    try {
      const res = await httpRequest(port, 'POST', '/api/mesh-update', {
        action: 'add-peer',
        peer: { identity: 'new-peer' },
        // missing httpsUrl, peerToken, outboundToken
      }, 'ca-secret');
      assert.equal(res.status, 400);
    } finally {
      await stopServer();
    }
  });

  it('rejects unknown action', async () => {
    try {
      const res = await httpRequest(port, 'POST', '/api/mesh-update', {
        action: 'unknown-action',
      }, 'ca-secret');
      assert.equal(res.status, 400);
    } finally {
      await stopServer();
    }
  });
});

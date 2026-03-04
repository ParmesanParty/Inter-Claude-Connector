import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createTestEnv, withServer, httpJSON } from './helpers.ts';

createTestEnv('icc-mesh-update-test');

const meshServerOpts = {
  localToken: 'local-tok',
  peerTokens: { 'ca-host': 'ca-secret' },
  tls: { ca: 'ca-host' },
  noAuth: false,
};

describe('/api/mesh-update', () => {
  it('accepts add-peer from CA identity', async () => {
    await withServer(meshServerOpts, async (port) => {
      const res = await httpJSON(port, 'POST', '/api/mesh-update', {
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
    });
  });

  it('rejects non-CA identity', async () => {
    await withServer(meshServerOpts, async (port) => {
      const res = await httpJSON(port, 'POST', '/api/mesh-update', {
        action: 'add-peer',
        peer: { identity: 'x', httpsUrl: 'https://x:3179', peerToken: 'x' },
        outboundToken: 'x',
      }, 'local-tok');
      assert.equal(res.status, 403);
    });
  });

  it('rejects unauthenticated request', async () => {
    await withServer(meshServerOpts, async (port) => {
      const res = await httpJSON(port, 'POST', '/api/mesh-update', {
        action: 'add-peer',
        peer: { identity: 'x', httpsUrl: 'https://x:3179', peerToken: 'x' },
        outboundToken: 'x',
      });
      assert.equal(res.status, 401);
    });
  });

  it('rejects invalid payload', async () => {
    await withServer(meshServerOpts, async (port) => {
      const res = await httpJSON(port, 'POST', '/api/mesh-update', {
        action: 'add-peer',
        peer: { identity: 'new-peer' },
      }, 'ca-secret');
      assert.equal(res.status, 400);
    });
  });

  it('rejects unknown action', async () => {
    await withServer(meshServerOpts, async (port) => {
      const res = await httpJSON(port, 'POST', '/api/mesh-update', {
        action: 'unknown-action',
      }, 'ca-secret');
      assert.equal(res.status, 400);
    });
  });
});

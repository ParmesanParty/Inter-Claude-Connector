import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { PeerRouter } from '../src/peers.ts';
import { createTestEnv, isolateConfig } from './helpers.ts';

createTestEnv('icc-peers-test');

// --- 0 peers ---

describe('PeerRouter: no peers configured', () => {
  beforeEach(() => {
    delete process.env.ICC_REMOTES;
  });

  it('listPeers returns empty array', () => {
    isolateConfig();
    const router = new PeerRouter();
    assert.deepEqual(router.listPeers(), []);
  });

  it('getDefaultPeer returns null', () => {
    isolateConfig();
    const router = new PeerRouter();
    assert.equal(router.getDefaultPeer(), null);
  });

  it('getTransport throws for any peer', () => {
    isolateConfig();
    const router = new PeerRouter();
    assert.throws(
      () => router.getTransport('peerA'),
      /Unknown peer: "peerA"/
    );
  });

  it('checkAllConnectivity returns empty object', async () => {
    isolateConfig();
    const router = new PeerRouter();
    const results = await router.checkAllConnectivity();
    assert.deepEqual(results, {});
  });
});

// --- resolveTarget ---

describe('PeerRouter: resolveTarget', () => {
  it('returns null for empty/null address', () => {
    isolateConfig();
    const router = new PeerRouter();
    assert.equal(router.resolveTarget(null as unknown as string), null);
    assert.equal(router.resolveTarget(''), null);
    assert.equal(router.resolveTarget(undefined as unknown as string), null);
  });

  it('returns null for local address', () => {
    isolateConfig();
    const router = new PeerRouter();
    assert.equal(router.resolveTarget('test-host/myapp'), null);
  });

  it('returns peer identity for remote address', () => {
    isolateConfig();
    const router = new PeerRouter();
    assert.equal(router.resolveTarget('peerA/myapp'), 'peerA');
    assert.equal(router.resolveTarget('peerB/icc'), 'peerB');
  });

  it('returns host from broadcast address', () => {
    isolateConfig();
    const router = new PeerRouter();
    assert.equal(router.resolveTarget('peerA'), 'peerA');
  });
});

// --- Error messages and default peer ---

describe('PeerRouter: getTransport error message', () => {
  it('shows (none) when no peers configured', () => {
    isolateConfig();
    const router = new PeerRouter();
    try {
      router.getTransport('nonexistent-peer-xyz');
      assert.fail('should have thrown');
    } catch (err) {
      assert.ok((err as Error).message.includes('Unknown peer: "nonexistent-peer-xyz"'));
      assert.ok((err as Error).message.includes('(none)'));
    }
  });

  it('lists known peers in error message', () => {
    isolateConfig({ remotes: { alpha: { httpUrl: 'http://localhost:1' }, beta: { httpUrl: 'http://localhost:2' } } as any });
    const router = new PeerRouter();
    try {
      router.getTransport('nonexistent-peer-xyz');
      assert.fail('should have thrown');
    } catch (err) {
      assert.ok((err as Error).message.includes('Unknown peer: "nonexistent-peer-xyz"'));
      assert.ok((err as Error).message.includes('alpha'));
      assert.ok((err as Error).message.includes('beta'));
    }
  });
});

describe('PeerRouter: getDefaultPeer', () => {
  it('returns null with 0 peers', () => {
    isolateConfig();
    const router = new PeerRouter();
    assert.equal(router.getDefaultPeer(), null);
  });

  it('returns sole peer with 1 peer', () => {
    isolateConfig({ remotes: { alpha: { httpUrl: 'http://localhost:1' } } as any });
    const router = new PeerRouter();
    assert.equal(router.getDefaultPeer(), 'alpha');
  });

  it('returns null with 2+ peers', () => {
    isolateConfig({ remotes: { alpha: { httpUrl: 'http://localhost:1' }, beta: { httpUrl: 'http://localhost:2' } } as any });
    const router = new PeerRouter();
    assert.equal(router.getDefaultPeer(), null);
  });
});

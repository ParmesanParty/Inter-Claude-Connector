import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { clearConfigCache, loadConfig } from '../src/config.ts';
import { reset as resetLog } from '../src/log.ts';
import { reset as resetInbox, init as initInbox } from '../src/inbox.ts';
import { PeerRouter } from '../src/peers.ts';

// Isolate log/inbox to temp dirs
const testDir = mkdtempSync(join(tmpdir(), 'icc-peers-test-'));
resetLog(testDir);
resetInbox(testDir);
initInbox();

// --- 0 peers ---

describe('PeerRouter: no peers configured', () => {
  beforeEach(() => {
    clearConfigCache();
    delete process.env.ICC_REMOTES;
  });

  function loadIsolatedConfig() {
    process.env.ICC_IDENTITY = 'test-host';
    process.env.ICC_AUTH_TOKEN = 'test-token';
    clearConfigCache();
    const config = loadConfig();
    config.remotes = {};
  }

  it('listPeers returns empty array', () => {
    loadIsolatedConfig();
    const router = new PeerRouter();
    assert.deepEqual(router.listPeers(), []);
  });

  it('getDefaultPeer returns null', () => {
    loadIsolatedConfig();
    const router = new PeerRouter();
    assert.equal(router.getDefaultPeer(), null);
  });

  it('getTransport throws for any peer', () => {
    loadIsolatedConfig();
    const router = new PeerRouter();
    assert.throws(
      () => router.getTransport('peerA'),
      /Unknown peer: "peerA"/
    );
  });

  it('checkAllConnectivity returns empty object', async () => {
    loadIsolatedConfig();
    const router = new PeerRouter();
    const results = await router.checkAllConnectivity();
    assert.deepEqual(results, {});
  });
});

// --- resolveTarget ---

describe('PeerRouter: resolveTarget', () => {
  function loadIsolatedConfig() {
    process.env.ICC_IDENTITY = 'test-host';
    process.env.ICC_AUTH_TOKEN = 'test-token';
    clearConfigCache();
    const config = loadConfig();
    config.remotes = {};
  }

  beforeEach(() => {
    clearConfigCache();
  });

  it('returns null for empty/null address', () => {
    loadIsolatedConfig();
    const router = new PeerRouter();
    assert.equal(router.resolveTarget(null as unknown as string), null);
    assert.equal(router.resolveTarget(''), null);
    assert.equal(router.resolveTarget(undefined as unknown as string), null);
  });

  it('returns null for local address', () => {
    loadIsolatedConfig();
    const router = new PeerRouter();
    assert.equal(router.resolveTarget('test-host/myapp'), null);
  });

  it('returns peer identity for remote address', () => {
    loadIsolatedConfig();
    const router = new PeerRouter();
    assert.equal(router.resolveTarget('peerA/myapp'), 'peerA');
    assert.equal(router.resolveTarget('peerB/icc'), 'peerB');
  });

  it('returns host from broadcast address', () => {
    loadIsolatedConfig();
    const router = new PeerRouter();
    assert.equal(router.resolveTarget('peerA'), 'peerA');
  });
});

// --- Error messages and default peer ---

describe('PeerRouter: getTransport error message', () => {
  it('shows (none) when no peers configured', () => {
    process.env.ICC_IDENTITY = 'test-host';
    process.env.ICC_AUTH_TOKEN = 'test-token';
    clearConfigCache();
    const config = loadConfig();
    config.remotes = {};
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
    process.env.ICC_IDENTITY = 'test-host';
    process.env.ICC_AUTH_TOKEN = 'test-token';
    clearConfigCache();
    const config = loadConfig();
    config.remotes = { alpha: { httpUrl: 'http://localhost:1' }, beta: { httpUrl: 'http://localhost:2' } };
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
    process.env.ICC_IDENTITY = 'test-host';
    process.env.ICC_AUTH_TOKEN = 'test-token';
    clearConfigCache();
    const config = loadConfig();
    config.remotes = {};
    const router = new PeerRouter();
    assert.equal(router.getDefaultPeer(), null);
  });

  it('returns sole peer with 1 peer', () => {
    process.env.ICC_IDENTITY = 'test-host';
    process.env.ICC_AUTH_TOKEN = 'test-token';
    clearConfigCache();
    const config = loadConfig();
    config.remotes = { alpha: { httpUrl: 'http://localhost:1' } };
    const router = new PeerRouter();
    assert.equal(router.getDefaultPeer(), 'alpha');
  });

  it('returns null with 2+ peers', () => {
    process.env.ICC_IDENTITY = 'test-host';
    process.env.ICC_AUTH_TOKEN = 'test-token';
    clearConfigCache();
    const config = loadConfig();
    config.remotes = { alpha: { httpUrl: 'http://localhost:1' }, beta: { httpUrl: 'http://localhost:2' } };
    const router = new PeerRouter();
    assert.equal(router.getDefaultPeer(), null);
  });
});

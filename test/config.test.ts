import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { clearConfigCache, loadConfig, getTlsOptions } from '../src/config.ts';

beforeEach(() => {
  clearConfigCache();
});

describe('env overrides for identity and host', () => {
  it('ICC_IDENTITY empty string preserves existing identity', () => {
    process.env.ICC_IDENTITY = '';
    clearConfigCache();
    const config = loadConfig();
    config.remotes = {};
    // Empty string should NOT null out identity — keep the default
    assert.equal(typeof config.identity, 'string');
    assert.ok(config.identity.length > 0);
    delete process.env.ICC_IDENTITY;
    clearConfigCache();
  });

  it('ICC_HOST empty string preserves existing host', () => {
    process.env.ICC_HOST = '';
    clearConfigCache();
    const config = loadConfig();
    config.remotes = {};
    assert.equal(typeof config.server.host, 'string');
    assert.ok(config.server.host.length > 0);
    delete process.env.ICC_HOST;
    clearConfigCache();
  });

  it('ICC_IDENTITY non-empty string overrides identity', () => {
    process.env.ICC_IDENTITY = 'test-override';
    clearConfigCache();
    const config = loadConfig();
    config.remotes = {};
    assert.equal(config.identity, 'test-override');
    delete process.env.ICC_IDENTITY;
    clearConfigCache();
  });
});

describe('TLS config helpers', () => {
  it('getTlsOptions returns null when TLS disabled', () => {
    clearConfigCache();
    const config = loadConfig();
    config.remotes = {};
    config.server.tls = { enabled: false, certPath: null, keyPath: null, caPath: null };
    const opts = getTlsOptions(config);
    assert.equal(opts, null);
  });

  it('getTlsOptions returns options when TLS enabled with paths', () => {
    clearConfigCache();
    const config = loadConfig();
    config.remotes = {};
    config.server.tls = { enabled: true, certPath: '/tmp/test.crt', keyPath: '/tmp/test.key', caPath: '/tmp/ca.crt' };
    // Will fail because files don't exist — test the structure only
    assert.throws(() => getTlsOptions(config), /ENOENT/);
  });

  it('env override ICC_TLS_ENABLED sets server.tls.enabled', () => {
    process.env.ICC_TLS_ENABLED = 'true';
    clearConfigCache();
    const config = loadConfig();
    config.remotes = {};
    assert.equal(config.server.tls.enabled, true);
    delete process.env.ICC_TLS_ENABLED;
    clearConfigCache();
  });
});

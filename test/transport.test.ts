import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createRequest } from '../src/protocol.ts';
import { clearConfigCache } from '../src/config.ts';
import type { HTTPTransport } from '../src/transport/http.ts';
import type { SSHTransport } from '../src/transport/ssh.ts';

process.env.ICC_IDENTITY = 'test-host';

beforeEach(() => {
  clearConfigCache();
});

describe('TransportManager', () => {
  it('checkConnectivity returns status for all transports', async () => {
    // With no remotes configured, transports report unavailable
    clearConfigCache();

    const { TransportManager } = await import('../src/transport/index.ts');
    const tm = new TransportManager();
    const status = await tm.checkConnectivity();

    assert.ok('ssh' in status);
    assert.ok('http' in status);
    assert.equal(status.ssh.available, false);
    assert.equal(status.http.available, false);
  });

  it('send throws when all transports fail', async () => {
    clearConfigCache();

    const { TransportManager } = await import('../src/transport/index.ts');
    const tm = new TransportManager();
    const msg = createRequest('test');

    await assert.rejects(
      () => tm.send(msg),
      /All transports failed/
    );
  });

  it('accepts peerConfig and passes to transports', async () => {
    clearConfigCache();

    const { TransportManager } = await import('../src/transport/index.ts');
    const tm = new TransportManager({
      httpUrl: 'http://example.com:3179',
      sshHost: 'example',
      projectDir: '~/code/test',
      wolMac: 'aa:bb:cc:dd:ee:ff',
    });

    assert.equal(tm.wolMac, 'aa:bb:cc:dd:ee:ff');
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- test needs to inspect private internals
    const transports = (tm as any)._transports;
    assert.equal((transports.http as HTTPTransport).baseUrl, 'http://example.com:3179');
    assert.equal((transports.ssh as SSHTransport).host, 'example');
    assert.equal((transports.ssh as SSHTransport).projectDir, '~/code/test');
  });
});

describe('SSHTransport', () => {
  it('isAvailable returns false when no host configured', async () => {
    clearConfigCache();

    const { SSHTransport } = await import('../src/transport/ssh.ts');
    const ssh = new SSHTransport();
    // With no host option, should return false
    assert.equal(await ssh.isAvailable(), false);
  });
});

describe('HTTPTransport', () => {
  it('isAvailable returns false when no URL configured', async () => {
    clearConfigCache();

    const { HTTPTransport } = await import('../src/transport/http.ts');
    const http = new HTTPTransport();
    assert.equal(await http.isAvailable(), false);
  });
});

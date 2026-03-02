import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { clearConfigCache } from '../src/config.ts';
import type { HTTPTransport } from '../src/transport/http.ts';

process.env.ICC_IDENTITY = 'test-host';

beforeEach(() => {
  clearConfigCache();
});

describe('TransportManager', () => {
  it('checkConnectivity returns status for http', async () => {
    clearConfigCache();

    const { TransportManager } = await import('../src/transport/index.ts');
    const tm = new TransportManager();
    const status = await tm.checkConnectivity();

    assert.ok('http' in status);
    assert.equal(status.http.available, false);
  });

  it('send throws when HTTP fails', async () => {
    clearConfigCache();
    const { createRequest } = await import('../src/protocol.ts');

    const { TransportManager } = await import('../src/transport/index.ts');
    const tm = new TransportManager();
    const msg = createRequest('test');

    await assert.rejects(
      () => tm.send(msg),
      /HTTP/
    );
  });

  it('accepts peerConfig and passes to HTTP transport', async () => {
    clearConfigCache();

    const { TransportManager } = await import('../src/transport/index.ts');
    const tm = new TransportManager({
      httpUrl: 'http://example.com:3179',
    });

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const http = (tm as any)._http as HTTPTransport;
    assert.equal(http.baseUrl, 'http://example.com:3179');
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

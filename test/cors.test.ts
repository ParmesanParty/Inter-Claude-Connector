import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createTestEnv, withServer, httpRaw } from './helpers.ts';

createTestEnv('icc-cors-test');

describe('CORS', () => {
  it('should reflect allowed origin', async () => {
    await withServer({ corsOrigins: ['http://localhost:3180'] }, async (port) => {
      const res = await httpRaw(port, 'OPTIONS', '/api/health', { headers: { Origin: 'http://localhost:3180' } });
      assert.equal(res.headers['access-control-allow-origin'], 'http://localhost:3180');
    });
  });

  it('should NOT reflect disallowed origin', async () => {
    await withServer({ corsOrigins: ['http://localhost:3180'] }, async (port) => {
      const res = await httpRaw(port, 'OPTIONS', '/api/health', { headers: { Origin: 'http://evil.com' } });
      assert.equal(res.headers['access-control-allow-origin'], undefined);
    });
  });

  it('should include Vary: Origin header', async () => {
    await withServer({ corsOrigins: ['http://localhost:3180'] }, async (port) => {
      const res = await httpRaw(port, 'OPTIONS', '/api/health', { headers: { Origin: 'http://localhost:3180' } });
      assert.equal(res.headers['vary'], 'Origin');
    });
  });
});

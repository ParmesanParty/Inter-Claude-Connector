import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createWebServer } from '../src/web.ts';
import { createTestEnv, isolateConfig, httpRaw } from './helpers.ts';

createTestEnv('icc-web-auth-test');

describe('Web UI session auth', () => {
  let webPort: number;
  let stopWeb: () => Promise<unknown>;

  beforeEach(async () => {
    isolateConfig({ identity: 'web-test', localToken: 'test-web-token' });
    const ws = createWebServer({ host: '127.0.0.1', port: 0 });
    const info = await ws.start() as { port: number; host: string };
    webPort = info.port;
    stopWeb = () => ws.stop();
  });

  it('GET / without session cookie returns login page', async () => {
    try {
      const res = await httpRaw(webPort, 'GET', '/');
      assert.equal(res.status, 200);
      assert.ok(res.body.includes('form'), 'Should contain a login form');
      assert.ok(res.body.includes('/login'), 'Should post to /login');
    } finally {
      await stopWeb();
    }
  });

  it('POST /login with correct token sets session cookie and redirects', async () => {
    try {
      const res = await httpRaw(webPort, 'POST', '/login', { body: 'token=test-web-token' });
      assert.equal(res.status, 302);
      const setCookie = res.headers['set-cookie'];
      assert.ok(setCookie, 'Should set a cookie');
      assert.ok(setCookie![0]!.includes('icc-session='));
    } finally {
      await stopWeb();
    }
  });

  it('GET / with valid session cookie returns dashboard', async () => {
    try {
      const loginRes = await httpRaw(webPort, 'POST', '/login', { body: 'token=test-web-token' });
      const setCookie = loginRes.headers['set-cookie']!;
      const cookie = (setCookie as string[])[0]!.split(';')[0]!;
      const res = await httpRaw(webPort, 'GET', '/', { headers: { Cookie: cookie } });
      assert.equal(res.status, 200);
      assert.ok(res.body.includes('ICC'), 'Should return the dashboard HTML');
      assert.ok(!res.body.includes('/login'), 'Should NOT show login form');
    } finally {
      await stopWeb();
    }
  });

  it('POST /login with wrong token returns 401', async () => {
    try {
      const res = await httpRaw(webPort, 'POST', '/login', { body: 'token=wrong-token' });
      assert.equal(res.status, 401);
    } finally {
      await stopWeb();
    }
  });
});

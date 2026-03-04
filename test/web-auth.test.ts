import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import http from 'node:http';
import { clearConfigCache, loadConfig } from '../src/config.ts';
import { createWebServer } from '../src/web.ts';
import { reset as resetLog } from '../src/log.ts';
import { reset as resetInbox, init as initInbox } from '../src/inbox.ts';

const testDir = mkdtempSync(join(tmpdir(), 'icc-web-auth-test-'));
resetLog(testDir);
resetInbox(testDir);
initInbox();

function httpRequest(
  port: number,
  method: string,
  path: string,
  body?: string,
  headers?: Record<string, string>,
): Promise<{ status: number; headers: http.IncomingHttpHeaders; body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request({
      hostname: '127.0.0.1',
      port,
      method,
      path,
      headers: { ...headers },
    }, (res) => {
      let data = '';
      res.on('data', (chunk: string) => { data += chunk; });
      res.on('end', () => resolve({ status: res.statusCode!, headers: res.headers, body: data }));
    });
    req.on('error', reject);
    if (body) {
      req.setHeader('Content-Type', 'application/x-www-form-urlencoded');
      req.setHeader('Content-Length', Buffer.byteLength(body));
      req.write(body);
    }
    req.end();
  });
}

describe('Web UI session auth', () => {
  let webPort: number;
  let stopWeb: () => Promise<unknown>;

  beforeEach(async () => {
    process.env.ICC_IDENTITY = 'web-test';
    clearConfigCache();
    const config = loadConfig();
    config.remotes = {};
    config.server.localToken = 'test-web-token';
    config.server.peerTokens = {};
    config.server.tls = { enabled: false, certPath: null, keyPath: null, caPath: null };

    const ws = createWebServer({ host: '127.0.0.1', port: 0 });
    const info = await ws.start() as { port: number; host: string };
    webPort = info.port;
    stopWeb = () => ws.stop();
  });

  it('GET / without session cookie returns login page', async () => {
    try {
      const res = await httpRequest(webPort, 'GET', '/');
      assert.equal(res.status, 200);
      assert.ok(res.body.includes('form'), 'Should contain a login form');
      assert.ok(res.body.includes('/login'), 'Should post to /login');
    } finally {
      await stopWeb();
    }
  });

  it('POST /login with correct token sets session cookie and redirects', async () => {
    try {
      const res = await httpRequest(webPort, 'POST', '/login', 'token=test-web-token');
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
      // Login first
      const loginRes = await httpRequest(webPort, 'POST', '/login', 'token=test-web-token');
      const setCookie = loginRes.headers['set-cookie']![0]!;
      const cookie = setCookie.split(';')[0]!;

      // Now access dashboard with cookie
      const res = await httpRequest(webPort, 'GET', '/', undefined, { Cookie: cookie });
      assert.equal(res.status, 200);
      assert.ok(res.body.includes('ICC'), 'Should return the dashboard HTML');
      assert.ok(!res.body.includes('/login'), 'Should NOT show login form');
    } finally {
      await stopWeb();
    }
  });

  it('POST /login with wrong token returns 401', async () => {
    try {
      const res = await httpRequest(webPort, 'POST', '/login', 'token=wrong-token');
      assert.equal(res.status, 401);
    } finally {
      await stopWeb();
    }
  });
});

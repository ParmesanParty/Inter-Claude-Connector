import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createPing, serialize } from '../src/protocol.ts';
import { createICCServer } from '../src/server.ts';
import { clearConfigCache, loadConfig } from '../src/config.ts';
import { reset as resetLog } from '../src/log.ts';
import { reset as resetInbox, init as initInbox } from '../src/inbox.ts';
import { request, type IncomingMessage } from 'node:http';

process.env.ICC_IDENTITY = 'test-host';
process.env.ICC_AUTH_TOKEN = 'test-token-123';
process.env.ICC_PORT = '0'; // Random port

// Redirect log and inbox to temp directories so tests don't pollute ~/.icc/
const testLogDir = mkdtempSync(join(tmpdir(), 'icc-test-'));
resetLog(testLogDir);
resetInbox(testLogDir);
initInbox();

beforeEach(() => {
  clearConfigCache();
});

interface HttpResponse {
  status: number | undefined;
  data: any;
}

interface HttpRawResponse {
  status: number | undefined;
  data: string;
  headers: IncomingMessage['headers'];
}

function httpRequest(port: number, method: string, path: string, body: any = null, token: string | null = 'test-token-123'): Promise<HttpResponse> {
  return new Promise((resolve, reject) => {
    const payload = body ? JSON.stringify(body) : null;
    const req = request(`http://127.0.0.1:${port}${path}`, {
      method,
      headers: {
        ...(payload && { 'Content-Type': 'application/json' }),
        ...(token && { 'Authorization': `Bearer ${token}` }),
      },
    }, (res: IncomingMessage) => {
      let data = '';
      res.on('data', (chunk: Buffer) => { data += chunk; });
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

function httpRequestRaw(port: number, method: string, path: string, token: string | null = null): Promise<HttpRawResponse> {
  return new Promise((resolve, reject) => {
    const req = request(`http://127.0.0.1:${port}${path}`, {
      method,
      headers: {
        ...(token && { 'Authorization': `Bearer ${token}` }),
      },
    }, (res: IncomingMessage) => {
      let data = '';
      res.on('data', (chunk: Buffer) => { data += chunk; });
      res.on('end', () => {
        resolve({
          status: res.statusCode,
          data,
          headers: res.headers,
        });
      });
    });
    req.on('error', reject);
    req.end();
  });
}

describe('HTTP Server', () => {
  // Use a fresh server for each test by creating in the test
  async function startServer() {
    clearConfigCache();
    const config = loadConfig();
    config.remotes = {};
    config.server.tls = { enabled: false, certPath: null, keyPath: null, caPath: null };
    config.server.localToken = null;
    config.server.peerTokens = {};
    const s = createICCServer({ host: '127.0.0.1', port: 0, noAuth: true });
    const info = await s.start();
    return { server: s, port: info.port };
  }

  it('GET /api/health returns ok', async () => {
    const { server: s, port: p } = await startServer();
    try {
      const res = await httpRequest(p, 'GET', '/api/health', null, null);
      assert.equal(res.status, 200);
      assert.equal(res.data.status, 'ok');
      assert.equal(res.data.identity, 'test-host');
      assert.ok(typeof res.data.uptime === 'number');
    } finally {
      await s.stop();
    }
  });

  it('rejects unauthorized requests', async () => {
    clearConfigCache();
    const config = loadConfig();
    config.remotes = {};
    config.server.tls = { enabled: false, certPath: null, keyPath: null, caPath: null };
    config.server.localToken = 'test-auth-token';
    config.server.peerTokens = {};
    const s = createICCServer({ host: '127.0.0.1', port: 0, noAuth: true });
    const { port: p } = await s.start();
    try {
      const res = await httpRequest(p, 'POST', '/api/message', {}, 'wrong-token');
      assert.equal(res.status, 401);
    } finally {
      await s.stop();
    }
  });

  it('POST /api/ping returns pong', async () => {
    const { server: s, port: p } = await startServer();
    try {
      const res = await httpRequest(p, 'POST', '/api/ping', {});
      assert.equal(res.status, 200);
      assert.equal(res.data.type, 'pong');
    } finally {
      await s.stop();
    }
  });

  it('rejects invalid ICC messages', async () => {
    const { server: s, port: p } = await startServer();
    try {
      const res = await httpRequest(p, 'POST', '/api/message', { bad: 'message' });
      assert.equal(res.status, 400);
      assert.ok(res.data.error.includes('Invalid'));
    } finally {
      await s.stop();
    }
  });

  it('handles ping messages via /api/message', async () => {
    const { server: s, port: p } = await startServer();
    try {
      const ping = createPing();
      const res = await httpRequest(p, 'POST', '/api/message', JSON.parse(serialize(ping)));
      assert.equal(res.status, 200);
      assert.equal(res.data.type, 'pong');
      assert.equal(res.data.replyTo, ping.id);
    } finally {
      await s.stop();
    }
  });

  it('returns 404 for unknown routes', async () => {
    const { server: s, port: p } = await startServer();
    try {
      const res = await httpRequest(p, 'GET', '/api/unknown');
      assert.equal(res.status, 404);
    } finally {
      await s.stop();
    }
  });

  it('GET /.well-known/icc-challenge returns challenge from file', async () => {
    const { server: s, port: p } = await startServer();
    try {
      // Write a challenge file to the test tls dir
      const challengeDir = join(testLogDir, 'tls');
      mkdirSync(challengeDir, { recursive: true });
      writeFileSync(join(challengeDir, '.challenge'), 'test-challenge-token-abc123');
      process.env.ICC_TLS_DIR = challengeDir;

      const res = await httpRequestRaw(p, 'GET', '/.well-known/icc-challenge');
      assert.equal(res.status, 200);
      assert.equal(res.data, 'test-challenge-token-abc123');
    } finally {
      delete process.env.ICC_TLS_DIR;
      await s.stop();
    }
  });

  it('GET /.well-known/icc-challenge returns 404 when no challenge file', async () => {
    const { server: s, port: p } = await startServer();
    try {
      // Point ICC_TLS_DIR to a nonexistent dir so no challenge file exists
      process.env.ICC_TLS_DIR = join(testLogDir, 'tls-nonexistent');

      const res = await httpRequest(p, 'GET', '/.well-known/icc-challenge', null, null);
      assert.equal(res.status, 404);
    } finally {
      delete process.env.ICC_TLS_DIR;
      await s.stop();
    }
  });
});

describe('Zod validation', () => {
  async function startServer() {
    clearConfigCache();
    const config = loadConfig();
    config.remotes = {};
    config.server.tls = { enabled: false, certPath: null, keyPath: null, caPath: null };
    config.server.localToken = null;
    config.server.peerTokens = {};
    const s = createICCServer({ host: '127.0.0.1', port: 0, noAuth: true });
    const info = await s.start();
    return { server: s, port: info.port };
  }

  it('POST /api/registry rejects non-numeric pid', async () => {
    const { server: s, port: p } = await startServer();
    try {
      const res = await httpRequest(p, 'POST', '/api/registry', { instance: 'test', pid: 'not-a-number' });
      assert.equal(res.status, 400);
    } finally {
      await s.stop();
    }
  });

  it('POST /api/registry rejects missing instance', async () => {
    const { server: s, port: p } = await startServer();
    try {
      const res = await httpRequest(p, 'POST', '/api/registry', { pid: 123 });
      assert.equal(res.status, 400);
    } finally {
      await s.stop();
    }
  });

  it('POST /api/inbox rejects missing body field', async () => {
    const { server: s, port: p } = await startServer();
    try {
      const res = await httpRequest(p, 'POST', '/api/inbox', { from: 'test-host/app' });
      assert.equal(res.status, 400);
    } finally {
      await s.stop();
    }
  });

  it('POST /api/inbox rejects missing from field', async () => {
    const { server: s, port: p } = await startServer();
    try {
      const res = await httpRequest(p, 'POST', '/api/inbox', { body: 'hello' });
      assert.equal(res.status, 400);
    } finally {
      await s.stop();
    }
  });

  it('POST /api/exec rejects missing command', async () => {
    const { server: s, port: p } = await startServer();
    try {
      const res = await httpRequest(p, 'POST', '/api/exec', { args: ['-la'] });
      assert.equal(res.status, 400);
    } finally {
      await s.stop();
    }
  });

  it('POST /api/readfile rejects missing path', async () => {
    const { server: s, port: p } = await startServer();
    try {
      const res = await httpRequest(p, 'POST', '/api/readfile', {});
      assert.equal(res.status, 400);
    } finally {
      await s.stop();
    }
  });
});

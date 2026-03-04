import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createPing, serialize } from '../src/protocol.ts';
import { createTestEnv, withServer, httpJSON, httpRaw } from './helpers.ts';

const env = createTestEnv('icc-integration-test');

describe('HTTP Server', () => {
  it('GET /api/health returns ok', async () => {
    await withServer({}, async (port) => {
      const res = await httpJSON(port, 'GET', '/api/health');
      assert.equal(res.status, 200);
      assert.equal(res.data.status, 'ok');
      assert.equal(res.data.identity, 'test-host');
      assert.ok(typeof res.data.uptime === 'number');
    });
  });

  it('rejects unauthorized requests', async () => {
    await withServer({ localToken: 'test-auth-token' }, async (port) => {
      const res = await httpJSON(port, 'POST', '/api/message', {}, 'wrong-token');
      assert.equal(res.status, 401);
    });
  });

  it('POST /api/ping returns pong', async () => {
    await withServer({}, async (port) => {
      const res = await httpJSON(port, 'POST', '/api/ping', {});
      assert.equal(res.status, 200);
      assert.equal(res.data.type, 'pong');
    });
  });

  it('rejects invalid ICC messages', async () => {
    await withServer({}, async (port) => {
      const res = await httpJSON(port, 'POST', '/api/message', { bad: 'message' });
      assert.equal(res.status, 400);
      assert.ok(res.data.error.includes('Invalid'));
    });
  });

  it('handles ping messages via /api/message', async () => {
    await withServer({}, async (port) => {
      const ping = createPing();
      const res = await httpJSON(port, 'POST', '/api/message', JSON.parse(serialize(ping)));
      assert.equal(res.status, 200);
      assert.equal(res.data.type, 'pong');
      assert.equal(res.data.replyTo, ping.id);
    });
  });

  it('returns 404 for unknown routes', async () => {
    await withServer({}, async (port) => {
      const res = await httpJSON(port, 'GET', '/api/unknown');
      assert.equal(res.status, 404);
    });
  });

  it('GET /.well-known/icc-challenge returns challenge from file', async () => {
    await withServer({}, async (port) => {
      const challengeDir = join(env.dir, 'tls');
      mkdirSync(challengeDir, { recursive: true });
      writeFileSync(join(challengeDir, '.challenge'), 'test-challenge-token-abc123');
      process.env.ICC_TLS_DIR = challengeDir;
      try {
        const res = await httpRaw(port, 'GET', '/.well-known/icc-challenge');
        assert.equal(res.status, 200);
        assert.equal(res.body, 'test-challenge-token-abc123');
      } finally {
        delete process.env.ICC_TLS_DIR;
      }
    });
  });

  it('GET /.well-known/icc-challenge returns 404 when no challenge file', async () => {
    await withServer({}, async (port) => {
      process.env.ICC_TLS_DIR = join(env.dir, 'tls-nonexistent');
      try {
        const res = await httpJSON(port, 'GET', '/.well-known/icc-challenge');
        assert.equal(res.status, 404);
      } finally {
        delete process.env.ICC_TLS_DIR;
      }
    });
  });
});

describe('Zod validation', () => {
  it('POST /api/registry rejects non-numeric pid', async () => {
    await withServer({}, async (port) => {
      const res = await httpJSON(port, 'POST', '/api/registry', { instance: 'test', pid: 'not-a-number' });
      assert.equal(res.status, 400);
    });
  });

  it('POST /api/registry rejects missing instance', async () => {
    await withServer({}, async (port) => {
      const res = await httpJSON(port, 'POST', '/api/registry', { pid: 123 });
      assert.equal(res.status, 400);
    });
  });

  it('POST /api/inbox rejects missing body field', async () => {
    await withServer({}, async (port) => {
      const res = await httpJSON(port, 'POST', '/api/inbox', { from: 'test-host/app' });
      assert.equal(res.status, 400);
    });
  });

  it('POST /api/inbox rejects missing from field', async () => {
    await withServer({}, async (port) => {
      const res = await httpJSON(port, 'POST', '/api/inbox', { body: 'hello' });
      assert.equal(res.status, 400);
    });
  });

  it('POST /api/exec rejects missing command', async () => {
    await withServer({}, async (port) => {
      const res = await httpJSON(port, 'POST', '/api/exec', { args: ['-la'] });
      assert.equal(res.status, 400);
    });
  });

  it('POST /api/readfile rejects missing path', async () => {
    await withServer({}, async (port) => {
      const res = await httpJSON(port, 'POST', '/api/readfile', {});
      assert.equal(res.status, 400);
    });
  });
});

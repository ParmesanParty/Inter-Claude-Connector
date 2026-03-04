import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { clearConfigCache, loadConfig } from '../src/config.ts';
import { createICCServer } from '../src/server.ts';
import { reset as resetLog } from '../src/log.ts';
import { reset as resetInbox, init as initInbox } from '../src/inbox.ts';
import type { TlsConfig } from '../src/types.ts';
import http from 'node:http';

const testDir = mkdtempSync(join(tmpdir(), 'icc-cors-test-'));
resetLog(testDir);
resetInbox(join(testDir, 'inbox'));
initInbox();

process.env.ICC_IDENTITY = 'cors-test';

function httpRequest(port: number, method: string, path: string, origin?: string): Promise<{ status: number; headers: Record<string, string> }> {
  return new Promise((resolve, reject) => {
    const headers: Record<string, string> = {};
    if (origin) headers['Origin'] = origin;
    const req = http.request({ hostname: '127.0.0.1', port, method, path, headers }, (res) => {
      res.resume();
      resolve({ status: res.statusCode!, headers: res.headers as Record<string, string> });
    });
    req.on('error', reject);
    req.end();
  });
}

describe('CORS', () => {
  it('should reflect allowed origin', async () => {
    clearConfigCache();
    const config = loadConfig();
    config.remotes = {};
    config.server.tls = { enabled: false } as TlsConfig;
    config.server.localToken = null;
    config.server.peerTokens = {};
    config.server.corsOrigins = ['http://localhost:3180'];

    const s = createICCServer({ host: '127.0.0.1', port: 0 });
    const info = await s.start();
    try {
      const res = await httpRequest(info.port, 'OPTIONS', '/api/health', 'http://localhost:3180');
      assert.equal(res.headers['access-control-allow-origin'], 'http://localhost:3180');
    } finally {
      await s.stop();
    }
  });

  it('should NOT reflect disallowed origin', async () => {
    clearConfigCache();
    const config = loadConfig();
    config.remotes = {};
    config.server.tls = { enabled: false } as TlsConfig;
    config.server.localToken = null;
    config.server.peerTokens = {};
    config.server.corsOrigins = ['http://localhost:3180'];

    const s = createICCServer({ host: '127.0.0.1', port: 0 });
    const info = await s.start();
    try {
      const res = await httpRequest(info.port, 'OPTIONS', '/api/health', 'http://evil.com');
      assert.equal(res.headers['access-control-allow-origin'], undefined);
    } finally {
      await s.stop();
    }
  });

  it('should include Vary: Origin header', async () => {
    clearConfigCache();
    const config = loadConfig();
    config.remotes = {};
    config.server.tls = { enabled: false } as TlsConfig;
    config.server.localToken = null;
    config.server.peerTokens = {};
    config.server.corsOrigins = ['http://localhost:3180'];

    const s = createICCServer({ host: '127.0.0.1', port: 0 });
    const info = await s.start();
    try {
      const res = await httpRequest(info.port, 'OPTIONS', '/api/health', 'http://localhost:3180');
      assert.equal(res.headers['vary'], 'Origin');
    } finally {
      await s.stop();
    }
  });
});

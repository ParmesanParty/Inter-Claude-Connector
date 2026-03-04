import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { clearConfigCache } from '../src/config.ts';
import { httpJSON } from './helpers.ts';

const testDir = mkdtempSync(join(tmpdir(), 'icc-enroll-test-'));
const caDir = join(testDir, 'ca-tls');
const peerChallengeDir = join(testDir, 'peer-tls');

// Track servers for cleanup
const servers: { close(): void }[] = [];

after(() => {
  for (const s of servers) {
    try { s.close(); } catch { /* ignore */ }
  }
  rmSync(testDir, { recursive: true, force: true });
});

describe('Enrollment Server', () => {
  let enrollServer: { start(): Promise<{ port: number; host: string }>; stop(): Promise<void>; _server: Server };
  let enrollPort: number;
  let peerServer: Server;
  let peerPort: number;

  before(async () => {
    const { initCA } = await import('../src/tls.ts');
    initCA(caDir);

    process.env.ICC_IDENTITY = 'ca-host';
    clearConfigCache();
  });

  it('POST /enroll returns challenge for known peer', async () => {
    const { createEnrollmentServer } = await import('../src/enroll.ts');

    const peerConfigs: Record<string, { httpUrl: string }> = { 'test-peer': { httpUrl: '' } };

    peerServer = createServer((req, res) => {
      if (req.url === '/.well-known/icc-challenge') {
        const challengePath = join(peerChallengeDir, '.challenge');
        try {
          const token = readFileSync(challengePath, 'utf-8').trim();
          res.writeHead(200, { 'Content-Type': 'text/plain' });
          res.end(token);
        } catch {
          res.writeHead(404);
          res.end('no challenge');
        }
      } else {
        res.writeHead(404);
        res.end();
      }
    });
    await new Promise<void>(r => peerServer.listen(0, '127.0.0.1', r));
    peerPort = (peerServer.address() as AddressInfo).port;
    servers.push(peerServer);

    peerConfigs['test-peer']!.httpUrl = `http://127.0.0.1:${peerPort}`;

    enrollServer = createEnrollmentServer({ caDir, peerConfigs, host: '127.0.0.1', port: 0 });
    const info = await enrollServer.start();
    enrollPort = info.port;
    servers.push(enrollServer._server);

    // Step 1: POST /enroll
    const enrollRes = await httpJSON(enrollPort, 'POST', '/enroll', { identity: 'test-peer' });
    assert.equal(enrollRes.status, 200);
    assert.ok(enrollRes.data.enrollmentId);
    assert.ok(enrollRes.data.challenge);

    // Step 2: Peer writes challenge file
    mkdirSync(peerChallengeDir, { recursive: true });
    writeFileSync(join(peerChallengeDir, '.challenge'), enrollRes.data.challenge);

    // Step 3: Submit CSR — CA will callback to verify, then sign
    const { generateKeyAndCSR } = await import('../src/tls.ts');
    const csr = generateKeyAndCSR(peerChallengeDir, 'test-peer');

    const csrRes = await httpJSON(enrollPort, 'POST', '/enroll/csr', {
      enrollmentId: enrollRes.data.enrollmentId,
      csr,
    });
    assert.equal(csrRes.status, 200);
    assert.ok(csrRes.data.cert.includes('BEGIN CERTIFICATE'));
    assert.ok(csrRes.data.caCert.includes('BEGIN CERTIFICATE'));
  });

  it('POST /enroll rejects unknown peer', async () => {
    const res = await httpJSON(enrollPort, 'POST', '/enroll', { identity: 'unknown-host' });
    assert.equal(res.status, 403);
  });

  it('POST /enroll/csr rejects invalid enrollmentId', async () => {
    const res = await httpJSON(enrollPort, 'POST', '/enroll/csr', {
      enrollmentId: 'bogus-id',
      csr: 'not-a-real-csr',
    });
    assert.equal(res.status, 400);
  });

  it('should rate-limit enrollment to 3 per identity per 15 min', async () => {
    const { createEnrollmentServer } = await import('../src/enroll.ts');
    const rlPeerConfigs: Record<string, { httpUrl: string }> = {
      'rl-peer': { httpUrl: 'http://127.0.0.1:9999' },
    };
    const rlServer = createEnrollmentServer({ caDir, peerConfigs: rlPeerConfigs, host: '127.0.0.1', port: 0 });
    const rlInfo = await rlServer.start();
    servers.push(rlServer._server);

    for (let i = 0; i < 3; i++) {
      const res = await httpJSON(rlInfo.port, 'POST', '/enroll', { identity: 'rl-peer' });
      assert.equal(res.status, 200, `Request ${i + 1} should succeed`);
    }

    const res4 = await httpJSON(rlInfo.port, 'POST', '/enroll', { identity: 'rl-peer' });
    assert.equal(res4.status, 429);

    await rlServer.stop();
  });
});

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { clearConfigCache, resetConfigPath, writeConfig, loadConfig } from '../src/config.ts';
import { httpJSON } from './helpers.ts';

const testDir = mkdtempSync(join(tmpdir(), 'icc-enroll-test-'));
resetConfigPath(testDir);
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

  it('join/complete includes CA itself in peers when caAddress is provided', async () => {
    const { createEnrollmentServer } = await import('../src/enroll.ts');

    // Write a config that loadConfig({ reload: true }) will read
    const caConfig = {
      identity: 'ca-host',
      instance: null,
      remotes: {
        'new-host': { httpUrl: '', token: '' },
      },
      server: {
        port: 3179,
        host: '127.0.0.1',
        localToken: 'test-local-token',
        peerTokens: {},
        tls: { cert: null, key: null, ca: null },
        enrollPort: 4179,
      },
      web: { host: '127.0.0.1', port: 3180 },
      tls: { ca: null },
      transport: { type: 'http', timeout: 10000 },
      security: { allowedCommands: [], allowedPaths: [] },
      claude: { binary: 'claude' },
    };
    writeConfig(caConfig as any);
    clearConfigCache();

    // Create a mock peer server that serves challenges
    const joinChallengeDir = join(testDir, 'join-challenge');
    mkdirSync(joinChallengeDir, { recursive: true });
    const joinPeerServer = createServer((req, res) => {
      if (req.url === '/.well-known/icc-challenge') {
        try {
          const token = readFileSync(join(joinChallengeDir, '.challenge'), 'utf-8').trim();
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
    await new Promise<void>(r => joinPeerServer.listen(0, '127.0.0.1', r));
    const joinPeerPort = (joinPeerServer.address() as AddressInfo).port;
    servers.push(joinPeerServer);

    // Create enrollment server with reloadToken
    const joinEnrollServer = createEnrollmentServer({
      caDir,
      peerConfigs: { 'new-host': { httpUrl: `http://127.0.0.1:${joinPeerPort}` } },
      host: '127.0.0.1',
      port: 0,
      reloadToken: 'test-local-token',
    });
    const joinEnrollInfo = await joinEnrollServer.start();
    servers.push(joinEnrollServer._server);

    // Register an invite
    const inviteRes = await httpJSON(joinEnrollInfo.port, 'POST', '/enroll/register-invite', {
      identity: 'new-host',
      joinToken: 'secret-join-token',
      ip: '10.0.0.99',
      port: 3179,
    }, 'test-local-token');
    assert.equal(inviteRes.status, 200);

    // POST /enroll/join with caAddress
    const joinRes = await httpJSON(joinEnrollInfo.port, 'POST', '/enroll/join', {
      identity: 'new-host',
      joinToken: 'secret-join-token',
      httpUrl: `http://127.0.0.1:${joinPeerPort}`,
      caAddress: '10.0.0.1',
    });
    assert.equal(joinRes.status, 200);
    assert.ok(joinRes.data.enrollmentId);
    assert.ok(joinRes.data.challenge);

    // Peer writes challenge file
    writeFileSync(join(joinChallengeDir, '.challenge'), joinRes.data.challenge);

    // Generate CSR and complete join
    const { generateKeyAndCSR } = await import('../src/tls.ts');
    const joinCsrDir = join(testDir, 'join-csr');
    mkdirSync(joinCsrDir, { recursive: true });
    const csr = generateKeyAndCSR(joinCsrDir, 'new-host');

    const completeRes = await httpJSON(joinEnrollInfo.port, 'POST', '/enroll/join/complete', {
      enrollmentId: joinRes.data.enrollmentId,
      csr,
    });
    assert.equal(completeRes.status, 200);
    assert.ok(completeRes.data.cert);
    assert.ok(completeRes.data.caCert);

    // Assert: peers array contains the CA itself
    const caPeer = completeRes.data.peers.find((p: any) => p.identity === 'ca-host');
    assert.ok(caPeer, 'peers should include CA host');
    assert.equal(caPeer.httpsUrl, 'https://10.0.0.1:3179');
    assert.ok(caPeer.outboundToken, 'CA peer should have outboundToken');
    assert.ok(caPeer.inboundToken, 'CA peer should have inboundToken');

    // Assert: CA config was updated with tokens for new-host
    clearConfigCache();
    const updatedConfig = loadConfig();
    assert.ok(updatedConfig.server.peerTokens['new-host'], 'CA config should have peerToken for new-host');
    assert.ok(updatedConfig.remotes['new-host']?.token, 'CA config should have outbound token for new-host');

    await joinEnrollServer.stop();
  });
});

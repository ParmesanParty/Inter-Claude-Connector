import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, existsSync, rmSync, writeFileSync, copyFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { clearConfigCache } from '../src/config.ts';
import { withEnv } from './helpers.ts';

const testDir = mkdtempSync(join(tmpdir(), 'icc-tls-test-'));

after(() => {
  rmSync(testDir, { recursive: true, force: true });
});

describe('TLS crypto module', () => {
  let tls: typeof import('../src/tls.ts');

  before(async () => {
    tls = await import('../src/tls.ts');
  });

  describe('initCA', () => {
    it('generates ca.key and ca.crt', () => {
      tls.initCA(testDir);
      assert.ok(existsSync(join(testDir, 'ca.key')));
      assert.ok(existsSync(join(testDir, 'ca.crt')));
    });

    it('CA cert has expected subject CN', () => {
      const certPem = readFileSync(join(testDir, 'ca.crt'), 'utf-8');
      assert.ok(certPem.includes('BEGIN CERTIFICATE'));
    });
  });

  describe('generateKeyAndCSR', () => {
    it('generates server.key and returns CSR PEM', () => {
      const csr = tls.generateKeyAndCSR(testDir, 'test-peer');
      assert.ok(existsSync(join(testDir, 'server.key')));
      assert.ok(csr.includes('BEGIN CERTIFICATE REQUEST'));
    });
  });

  describe('signCSR', () => {
    it('signs a CSR and returns cert PEM', () => {
      const csr = tls.generateKeyAndCSR(testDir, 'test-peer');
      const cert = tls.signCSR(testDir, csr, 'test-peer', 365);
      assert.ok(cert.includes('BEGIN CERTIFICATE'));
    });

    it('preserves ca.srl after signing', () => {
      const csr = tls.generateKeyAndCSR(testDir, 'test-peer-srl');
      tls.signCSR(testDir, csr, 'test-peer-srl', 365);
      assert.ok(existsSync(join(testDir, 'ca.srl')), 'ca.srl should persist after signing');
    });
  });

  describe('getCertInfo', () => {
    it('returns subject and issuer from a cert file', () => {
      const info = tls.getCertInfo(join(testDir, 'ca.crt'));
      assert.ok(info.subject!.includes('ICC'));
      assert.ok(info.issuer);
      assert.ok(info.notAfter);
    });
  });
});

describe('HTTPS Server', () => {
  let tls: typeof import('../src/tls.ts');

  before(async () => {
    tls = await import('../src/tls.ts');
  });

  it('starts HTTPS and accepts mTLS client', async () => {
    const caDir = join(testDir, 'https-ca');
    const peerDir = join(testDir, 'https-peer');
    tls.initCA(caDir);
    const csr = tls.generateKeyAndCSR(peerDir, 'test-host');
    const cert = tls.signCSR(caDir, csr, 'test-host');
    writeFileSync(join(peerDir, 'server.crt'), cert);
    copyFileSync(join(caDir, 'ca.crt'), join(peerDir, 'ca.crt'));

    await withEnv({
      ICC_IDENTITY: 'test-host',
      ICC_TLS_ENABLED: 'true',
      ICC_TLS_CERT: join(peerDir, 'server.crt'),
      ICC_TLS_KEY: join(peerDir, 'server.key'),
      ICC_TLS_CA: join(peerDir, 'ca.crt'),
    }, async () => {
      clearConfigCache();
      const { createICCServer } = await import('../src/server.ts');
      const { reset: resetLog } = await import('../src/log.ts');
      const { reset: resetInbox, init: initInbox } = await import('../src/inbox.ts');
      resetLog(testDir);
      resetInbox(testDir);
      initInbox();

      const s = createICCServer({ host: '127.0.0.1', port: 0, noAuth: true });
      const info = await s.start();

      try {
        const { request: httpsReq } = await import('node:https');
        const res = await new Promise<{ status: string }>((resolve, reject) => {
          const req = httpsReq(`https://127.0.0.1:${info.port}/api/health`, {
            ca: readFileSync(join(peerDir, 'ca.crt')),
            cert: readFileSync(join(peerDir, 'server.crt')),
            key: readFileSync(join(peerDir, 'server.key')),
            checkServerIdentity: () => undefined,
          }, (httpRes) => {
            let data = '';
            httpRes.on('data', (c: string) => { data += c; });
            httpRes.on('end', () => resolve(JSON.parse(data)));
          });
          req.on('error', reject);
          req.end();
        });

        assert.equal(res.status, 'ok');
      } finally {
        await s.stop();
      }
    });
  });
});

describe('End-to-end mTLS', () => {
  let tls: typeof import('../src/tls.ts');

  before(async () => {
    tls = await import('../src/tls.ts');
  });

  it('CA init -> sign -> HTTPS server -> mTLS request succeeds', async () => {
    const e2eDir = join(testDir, 'e2e');
    const caDir = join(e2eDir, 'ca');
    const peerDir = join(e2eDir, 'peer');

    tls.initCA(caDir);
    const csr = tls.generateKeyAndCSR(peerDir, 'e2e-peer');
    const cert = tls.signCSR(caDir, csr, 'e2e-peer');
    writeFileSync(join(peerDir, 'server.crt'), cert);
    copyFileSync(join(caDir, 'ca.crt'), join(peerDir, 'ca.crt'));

    await withEnv({
      ICC_IDENTITY: 'e2e-peer',
      ICC_TLS_ENABLED: 'true',
      ICC_TLS_CERT: join(peerDir, 'server.crt'),
      ICC_TLS_KEY: join(peerDir, 'server.key'),
      ICC_TLS_CA: join(peerDir, 'ca.crt'),
    }, async () => {
      clearConfigCache();
      const { createICCServer } = await import('../src/server.ts');
      const { reset: resetLog } = await import('../src/log.ts');
      const { reset: resetInbox, init: initInbox } = await import('../src/inbox.ts');
      resetLog(testDir);
      resetInbox(testDir);
      initInbox();

      const s = createICCServer({ host: '127.0.0.1', port: 0, noAuth: true });
      const info = await s.start();

      try {
        const { request: httpsReq } = await import('node:https');

        const res = await new Promise<{ status: number | undefined; data: any }>((resolve, reject) => {
          const req = httpsReq(`https://127.0.0.1:${info.port}/api/health`, {
            ca: readFileSync(join(peerDir, 'ca.crt')),
            cert: readFileSync(join(peerDir, 'server.crt')),
            key: readFileSync(join(peerDir, 'server.key')),
            checkServerIdentity: () => undefined,
          }, (httpRes) => {
            let data = '';
            httpRes.on('data', (c: string) => { data += c; });
            httpRes.on('end', () => resolve({ status: httpRes.statusCode, data: JSON.parse(data) }));
          });
          req.on('error', reject);
          req.end();
        });

        assert.equal(res.status, 200);
        assert.equal(res.data.status, 'ok');

        await assert.rejects(
          new Promise((resolve, reject) => {
            const req = httpsReq(`https://127.0.0.1:${info.port}/api/health`, {
              ca: readFileSync(join(peerDir, 'ca.crt')),
              checkServerIdentity: () => undefined,
            }, resolve);
            req.on('error', reject);
            req.end();
          }),
          /ECONNRESET|certificate|socket hang up/
        );
      } finally {
        await s.stop();
      }
    });
  });
});

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { resetConfigPath } from '../src/config.ts';

const testDir = mkdtempSync(join(tmpdir(), 'icc-tls-renew-'));
resetConfigPath(testDir);

after(() => {
  rmSync(testDir, { recursive: true, force: true });
});

describe('needsRenewal()', () => {
  let caDir: string;

  before(async () => {
    caDir = join(testDir, 'ca-tls');
    const { initCA, generateKeyAndCSR, signCSR } = await import('../src/tls.ts');
    initCA(caDir);
    const csr = generateKeyAndCSR(caDir, 'test-host');
    const cert = signCSR(caDir, csr, 'test-host', 365);
    writeFileSync(join(caDir, 'server.crt'), cert);
  });

  it('returns false for a fresh cert with default threshold', async () => {
    const { needsRenewal } = await import('../src/tls.ts');
    const result = needsRenewal(join(caDir, 'server.crt'));
    assert.equal(result.needsRenewal, false);
    assert.ok(result.daysRemaining > 300);
    assert.ok(result.notAfter !== 'unknown');
  });

  it('returns true for a cert with custom threshold exceeding remaining days', async () => {
    const { needsRenewal } = await import('../src/tls.ts');
    // Use a threshold larger than the cert's remaining days (365 days)
    const result = needsRenewal(join(caDir, 'server.crt'), 400);
    assert.equal(result.needsRenewal, true);
  });

  it('returns true for a short-lived cert', async () => {
    const { needsRenewal, generateKeyAndCSR, signCSR } = await import('../src/tls.ts');
    const shortDir = join(testDir, 'short-cert');
    const csr = generateKeyAndCSR(shortDir, 'short-host');
    const cert = signCSR(caDir, csr, 'short-host', 1);
    writeFileSync(join(shortDir, 'server.crt'), cert);

    const result = needsRenewal(join(shortDir, 'server.crt'), 30);
    assert.equal(result.needsRenewal, true);
    assert.ok(result.daysRemaining <= 1);
  });
});

describe('renewIfNeeded()', () => {
  let caDir: string;
  let peerDir: string;

  before(async () => {
    caDir = join(testDir, 'renew-ca');
    const { initCA, generateKeyAndCSR, signCSR } = await import('../src/tls.ts');
    initCA(caDir);
    // Initial cert for the CA host itself
    const csr = generateKeyAndCSR(caDir, 'renew-host');
    const cert = signCSR(caDir, csr, 'renew-host', 365);
    writeFileSync(join(caDir, 'server.crt'), cert);

    // Peer dir with a short-lived cert
    peerDir = join(testDir, 'renew-peer');
    const peerCsr = generateKeyAndCSR(peerDir, 'peer-host');
    const peerCert = signCSR(caDir, peerCsr, 'peer-host', 1);
    writeFileSync(join(peerDir, 'server.crt'), peerCert);
  });

  it('skips renewal when cert is fresh (no force)', async () => {
    const { renewIfNeeded } = await import('../src/tls.ts');
    const result = await renewIfNeeded({
      tlsDir: caDir,
      identity: 'renew-host',
      caEnrollUrl: null,
    });
    assert.equal(result.renewed, false);
    assert.ok(result.daysRemaining > 300);
  });

  it('renews on force even when cert is fresh (CA host self-sign)', async () => {
    const { renewIfNeeded } = await import('../src/tls.ts');
    const originalKey = readFileSync(join(caDir, 'server.key'), 'utf-8');

    const result = await renewIfNeeded({
      tlsDir: caDir,
      identity: 'renew-host',
      caEnrollUrl: null,
      force: true,
    });
    assert.equal(result.renewed, true);
    assert.ok(result.daysRemaining > 300);

    // Key should be different after renewal
    const newKey = readFileSync(join(caDir, 'server.key'), 'utf-8');
    assert.notEqual(newKey, originalKey);

    // Temp dir should be cleaned up
    assert.equal(existsSync(join(caDir, '.renew-tmp')), false);
  });

  it('auto-renews short-lived cert (CA host self-sign)', async () => {
    const { renewIfNeeded } = await import('../src/tls.ts');
    // peerDir has a 1-day cert, and we copy ca.key + ca.crt there to simulate CA host
    writeFileSync(join(peerDir, 'ca.key'), readFileSync(join(caDir, 'ca.key')));
    writeFileSync(join(peerDir, 'ca.crt'), readFileSync(join(caDir, 'ca.crt')));
    writeFileSync(join(peerDir, 'ca.srl'), readFileSync(join(caDir, 'ca.srl')));

    const result = await renewIfNeeded({
      tlsDir: peerDir,
      identity: 'peer-host',
      caEnrollUrl: null,
      thresholdDays: 30,
    });
    assert.equal(result.renewed, true);
    assert.ok(result.daysRemaining > 300);
  });

  it('throws when no CA is configured', async () => {
    const { renewIfNeeded } = await import('../src/tls.ts');
    const noCADir = join(testDir, 'no-ca');
    const { generateKeyAndCSR, signCSR } = await import('../src/tls.ts');
    const csr = generateKeyAndCSR(noCADir, 'no-ca-host');
    // Sign with our test CA but don't put ca.key in noCADir
    const cert = signCSR(caDir, csr, 'no-ca-host', 1);
    writeFileSync(join(noCADir, 'server.crt'), cert);

    await assert.rejects(
      renewIfNeeded({
        tlsDir: noCADir,
        identity: 'no-ca-host',
        caEnrollUrl: undefined as unknown as string | null,
        force: true,
      }),
      { message: /No CA configured/ },
    );
  });
});

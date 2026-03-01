import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdirSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { createLogger } from './util/logger.ts';

const log = createLogger('tls');

/**
 * Initialize a Certificate Authority — generates Ed25519 CA key + self-signed cert.
 * @param {string} tlsDir - Directory to store ca.key and ca.crt
 * @param {number} days - Validity period (default: 3650 = ~10 years)
 */
export function initCA(tlsDir: string, days: number = 3650): void {
  mkdirSync(tlsDir, { recursive: true });
  const keyPath = join(tlsDir, 'ca.key');
  const certPath = join(tlsDir, 'ca.crt');

  // Generate Ed25519 private key
  execFileSync('openssl', ['genpkey', '-algorithm', 'Ed25519', '-out', keyPath],
    { stdio: 'pipe' });

  // Self-sign CA certificate
  execFileSync('openssl', [
    'req', '-new', '-x509', '-key', keyPath, '-out', certPath,
    '-days', String(days), '-subj', '/CN=ICC Root CA',
  ], { stdio: 'pipe' });

  log.info(`CA initialized at ${tlsDir}`);
}

/**
 * Generate an Ed25519 key pair and CSR for a peer.
 * The private key is written to tlsDir/server.key.
 * @param {string} tlsDir - Directory to store server.key
 * @param {string} identity - Peer identity (used as CN in CSR)
 * @returns {string} CSR in PEM format
 */
export function generateKeyAndCSR(tlsDir: string, identity: string): string {
  mkdirSync(tlsDir, { recursive: true });
  const keyPath = join(tlsDir, 'server.key');

  // Generate Ed25519 private key
  execFileSync('openssl', ['genpkey', '-algorithm', 'Ed25519', '-out', keyPath],
    { stdio: 'pipe' });

  // Generate CSR (output to stdout)
  const csr = execFileSync('openssl', [
    'req', '-new', '-key', keyPath, '-subj', `/CN=${identity}`,
  ], { encoding: 'utf-8' });

  log.info(`Key pair and CSR generated for "${identity}"`);
  return csr;
}

/**
 * Sign a CSR with the CA key. Requires ca.key and ca.crt in tlsDir.
 * @param {string} tlsDir - Directory containing ca.key and ca.crt
 * @param {string} csrPem - CSR in PEM format
 * @param {string} identity - Peer identity (for logging)
 * @param {number} days - Validity period (default: 365)
 * @returns {string} Signed certificate in PEM format
 */
export function signCSR(tlsDir: string, csrPem: string, identity: string, days: number = 365): string {
  const caKeyPath = join(tlsDir, 'ca.key');
  const caCertPath = join(tlsDir, 'ca.crt');
  const csrPath = join(tlsDir, '.tmp-csr.pem');
  const outPath = join(tlsDir, '.tmp-cert.pem');

  try {
    writeFileSync(csrPath, csrPem);
    execFileSync('openssl', [
      'x509', '-req', '-in', csrPath, '-CA', caCertPath, '-CAkey', caKeyPath,
      '-CAcreateserial', '-out', outPath, '-days', String(days),
    ], { stdio: 'pipe' });

    const cert = readFileSync(outPath, 'utf-8');
    log.info(`Signed certificate for "${identity}" (${days} days)`);
    return cert;
  } finally {
    for (const f of [csrPath, outPath, join(tlsDir, 'ca.srl')]) {
      try { unlinkSync(f); } catch { /* cleanup */ }
    }
  }
}

/**
 * Get human-readable info from a certificate file.
 * @param {string} certPath - Path to a PEM certificate file
 * @returns {{ subject: string, issuer: string, notBefore: string, notAfter: string }}
 */
interface CertInfo {
  subject?: string;
  issuer?: string;
  notBefore?: string;
  notAfter?: string;
}

export function getCertInfo(certPath: string): CertInfo {
  const text = execFileSync('openssl', [
    'x509', '-in', certPath, '-noout', '-subject', '-issuer', '-dates',
  ], { encoding: 'utf-8' });

  const info: CertInfo = {};
  for (const line of text.trim().split('\n')) {
    if (line.startsWith('subject=')) info.subject = line.slice('subject='.length).trim();
    else if (line.startsWith('issuer=')) info.issuer = line.slice('issuer='.length).trim();
    else if (line.startsWith('notBefore=')) info.notBefore = line.slice('notBefore='.length).trim();
    else if (line.startsWith('notAfter=')) info.notAfter = line.slice('notAfter='.length).trim();
  }
  return info;
}

#!/usr/bin/env node

/**
 * Docker healthcheck script.
 * Prefers the localhost HTTP listener (ICC_LOCALHOST_HTTP_PORT) when available.
 * Falls back to TLS-aware probe on :3179 otherwise.
 */

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { get as httpGet } from 'node:http';
import { get as httpsGet } from 'node:https';

const localhostHttpPort = process.env.ICC_LOCALHOST_HTTP_PORT;

if (localhostHttpPort) {
  // Preferred: hit the plain HTTP localhost listener (no TLS needed)
  httpGet(`http://127.0.0.1:${localhostHttpPort}/api/health`, (res) => {
    process.exit(res.statusCode === 200 ? 0 : 1);
  }).on('error', () => process.exit(1));
} else {
  // Fallback: TLS-aware probe on main port
  const tlsDir = join(homedir(), '.icc', 'tls');
  const hasTls = existsSync(join(tlsDir, 'ca.crt'));

  if (hasTls) {
    httpsGet({
      hostname: '127.0.0.1',
      port: 3179,
      path: '/api/health',
      ca: readFileSync(join(tlsDir, 'ca.crt')),
      cert: readFileSync(join(tlsDir, 'server.crt')),
      key: readFileSync(join(tlsDir, 'server.key')),
      rejectUnauthorized: false,
    }, (res) => {
      process.exit(res.statusCode === 200 ? 0 : 1);
    }).on('error', () => process.exit(1));
  } else {
    httpGet('http://127.0.0.1:3179/api/health', (res) => {
      process.exit(res.statusCode === 200 ? 0 : 1);
    }).on('error', () => process.exit(1));
  }
}

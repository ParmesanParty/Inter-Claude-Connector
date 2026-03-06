#!/usr/bin/env node

/**
 * Docker healthcheck script.
 * Handles both HTTP (wizard mode) and HTTPS/mTLS (normal mode).
 */

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { get as httpGet } from 'node:http';
import { get as httpsGet } from 'node:https';

const tlsDir = join(homedir(), '.icc', 'tls');
const hasTls = existsSync(join(tlsDir, 'ca.crt'));

if (hasTls) {
  const opts = {
    hostname: 'localhost',
    port: 3179,
    path: '/api/health',
    ca: readFileSync(join(tlsDir, 'ca.crt')),
    cert: readFileSync(join(tlsDir, 'server.crt')),
    key: readFileSync(join(tlsDir, 'server.key')),
    rejectUnauthorized: false,
  };
  httpsGet(opts, (res) => {
    process.exit(res.statusCode === 200 ? 0 : 1);
  }).on('error', () => process.exit(1));
} else {
  httpGet('http://localhost:3179/api/health', (res) => {
    process.exit(res.statusCode === 200 ? 0 : 1);
  }).on('error', () => process.exit(1));
}

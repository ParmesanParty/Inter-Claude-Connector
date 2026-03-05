import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { request, type IncomingMessage, type IncomingHttpHeaders } from 'node:http';
import { execFileSync } from 'node:child_process';
import { clearConfigCache, loadConfig, resetConfigPath } from '../src/config.ts';
import { createICCServer } from '../src/server.ts';
import { reset as resetLog } from '../src/log.ts';
import { reset as resetInbox, init as initInbox } from '../src/inbox.ts';
import { closeInboxDb } from '../src/inbox-db.ts';
import type { TlsConfig, ICCConfig } from '../src/types.ts';

// ── Test Environment ────────────────────────────────────────────────

export interface TestEnv {
  dir: string;
  cleanup(): void;
}

/**
 * Create an isolated temp directory and redirect log + inbox storage there.
 * Call once at module level in any test file that uses the server, inbox, or log.
 */
export function createTestEnv(prefix = 'icc-test'): TestEnv {
  const dir = mkdtempSync(join(tmpdir(), `${prefix}-`));
  resetLog(dir);
  resetInbox(dir);
  resetConfigPath(dir);
  initInbox();
  return {
    dir,
    cleanup() {
      closeInboxDb();
      try { rmSync(dir, { recursive: true, force: true }); } catch {}
    },
  };
}

// ── Config Isolation ────────────────────────────────────────────────

export interface ConfigOverrides {
  identity?: string;
  localToken?: string | null;
  peerTokens?: Record<string, string>;
  remotes?: ICCConfig['remotes'];
  corsOrigins?: string[];
  tls?: { ca?: string | null };
}

/**
 * Load a fully isolated config. Always zeros remotes, TLS, and tokens
 * so live ~/.icc/config.json cannot leak into tests.
 * Call in beforeEach or at the start of each test.
 */
export function isolateConfig(overrides: ConfigOverrides = {}): ICCConfig {
  process.env.ICC_IDENTITY = overrides.identity ?? 'test-host';
  clearConfigCache();
  const config = loadConfig();
  config.remotes = overrides.remotes ?? {};
  config.server.tls = { enabled: false } as TlsConfig;
  config.server.localToken = overrides.localToken ?? null;
  config.server.peerTokens = overrides.peerTokens ?? {};
  if (overrides.corsOrigins) config.server.corsOrigins = overrides.corsOrigins;
  if (overrides.tls) {
    if (overrides.tls.ca !== undefined) config.tls = { ca: overrides.tls.ca };
  }
  return config;
}

// ── Server Lifecycle ────────────────────────────────────────────────

interface ServerOptions extends ConfigOverrides {
  noAuth?: boolean;
}

/**
 * Create an ICC server with isolated config, run `fn`, then always stop.
 * Guaranteed cleanup even if assertions throw.
 */
export async function withServer(
  opts: ServerOptions,
  fn: (port: number, config: ICCConfig) => Promise<void>,
): Promise<void> {
  const config = isolateConfig(opts);
  const s = createICCServer({ host: '127.0.0.1', port: 0, noAuth: opts.noAuth ?? true });
  const info = await s.start();
  try {
    await fn(info.port, config);
  } finally {
    await s.stop();
  }
}

// ── HTTP Helpers ────────────────────────────────────────────────────

/**
 * Make an HTTP request and parse the JSON response.
 * This is the canonical helper — replaces 7 per-file definitions.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function httpJSON(
  port: number,
  method: string,
  path: string,
  body: unknown = null,
  token: string | null = null,
): Promise<{ status: number | undefined; data: any }> {
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
        try { resolve({ status: res.statusCode, data: data ? JSON.parse(data) : null }); }
        catch { resolve({ status: res.statusCode, data }); }
      });
    });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

/**
 * Make an HTTP request and return the raw response body + headers.
 * For CORS tests, web-auth tests, challenge endpoint, and any test
 * that needs headers or non-JSON bodies.
 */
export function httpRaw(
  port: number,
  method: string,
  path: string,
  opts: { body?: string; headers?: Record<string, string>; token?: string | null } = {},
): Promise<{ status: number | undefined; body: string; headers: IncomingHttpHeaders }> {
  return new Promise((resolve, reject) => {
    const reqHeaders: Record<string, string> = { ...opts.headers };
    if (opts.token) reqHeaders['Authorization'] = `Bearer ${opts.token}`;
    const req = request({
      hostname: '127.0.0.1',
      port,
      method,
      path,
      headers: reqHeaders,
    }, (res: IncomingMessage) => {
      let data = '';
      res.on('data', (chunk: Buffer) => { data += chunk; });
      res.on('end', () => resolve({ status: res.statusCode, body: data, headers: res.headers }));
    });
    req.on('error', reject);
    if (opts.body) {
      if (!reqHeaders['Content-Type']) {
        req.setHeader('Content-Type', 'application/x-www-form-urlencoded');
      }
      req.setHeader('Content-Length', Buffer.byteLength(opts.body));
      req.write(opts.body);
    }
    req.end();
  });
}

// ── Environment Variable Scoping ────────────────────────────────────

/**
 * Temporarily set environment variables, run fn, then restore originals.
 * Prevents env var leakage between tests.
 */
export async function withEnv<T>(
  vars: Record<string, string>,
  fn: () => T | Promise<T>,
): Promise<T> {
  const saved: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(vars)) {
    saved[k] = process.env[k];
    process.env[k] = v;
  }
  try {
    return await fn();
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

// ── Hook Test Helpers ───────────────────────────────────────────────

const iccBin = join(import.meta.dirname, '..', 'bin', 'icc.ts');

/**
 * Run `icc hook <subcmd>` as a subprocess with isolated env.
 * Shared between hook-heartbeat.test.ts and hook-session.test.ts.
 */
export function runHook(subcmd: string, env: Record<string, string> = {}, extraArgs: string[] = []): string {
  return execFileSync('node', [iccBin, 'hook', subcmd, ...extraArgs], {
    env: {
      ...process.env,
      HOME: env.HOME || process.env.HOME,
      ICC_IDENTITY: 'test-host',
      ICC_REMOTE_SSH: '',
      ICC_REMOTE_HTTP: '',
      ...env,
    },
    timeout: 10000,
    encoding: 'utf-8',
    stdio: ['pipe', 'pipe', 'pipe'],
  });
}

/**
 * Create a temporary HOME directory with ~/.icc/ for hook tests.
 * Returns tmpHome path and a cleanup function.
 */
export function createTmpHome(prefix = 'icc-hook-test'): { tmpHome: string; cleanup(): void } {
  const tmpHome = mkdtempSync(join(tmpdir(), `${prefix}-`));
  mkdirSync(join(tmpHome, '.icc'), { recursive: true });
  return {
    tmpHome,
    cleanup() { try { rmSync(tmpHome, { recursive: true, force: true }); } catch {} },
  };
}

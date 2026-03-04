import { readFileSync, statSync, writeFileSync, mkdirSync, chmodSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';
import type { PeerCertificate } from 'node:tls';
import { buildAddress } from './address.ts';
import type { ICCConfig, RemoteConfig } from './types.ts';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DEFAULT_CONFIG_PATH = join(__dirname, '..', 'config', 'default.json');
const USER_CONFIG_PATH = join(homedir(), '.icc', 'config.json');

let _cachedConfig: ICCConfig | null = null;

function readJSON(path: string): Record<string, unknown> {
  return JSON.parse(readFileSync(path, 'utf-8'));
}

function deepMerge(target: Record<string, unknown>, source: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = { ...target };
  for (const key of Object.keys(source)) {
    if (
      source[key] !== null &&
      typeof source[key] === 'object' &&
      !Array.isArray(source[key]) &&
      typeof target[key] === 'object' &&
      target[key] !== null
    ) {
      result[key] = deepMerge(target[key] as Record<string, unknown>, source[key] as Record<string, unknown>);
    } else {
      result[key] = source[key];
    }
  }
  return result;
}

function applyEnvOverrides(config: ICCConfig): ICCConfig {
  const env = process.env;
  // Use 'in' to check key existence — allows empty string to override (clear) a value
  if ('ICC_IDENTITY' in env && env.ICC_IDENTITY) config.identity = env.ICC_IDENTITY;
  if ('ICC_PORT' in env && env.ICC_PORT) config.server.port = parseInt(env.ICC_PORT, 10);
  if ('ICC_LOCAL_TOKEN' in env) config.server.localToken = env.ICC_LOCAL_TOKEN || null;
  if ('ICC_HOST' in env && env.ICC_HOST) config.server.host = env.ICC_HOST;
  if ('ICC_INSTANCE' in env) config.instance = env.ICC_INSTANCE || null;
  if ('ICC_READFILE_ENABLED' in env) config.security.readfileEnabled = env.ICC_READFILE_ENABLED === 'true';
  if ('ICC_EXEC_ENABLED' in env) config.security.execEnabled = env.ICC_EXEC_ENABLED === 'true';
  if ('ICC_TLS_ENABLED' in env) config.server.tls.enabled = env.ICC_TLS_ENABLED === 'true';
  if ('ICC_TLS_CERT' in env) config.server.tls.certPath = env.ICC_TLS_CERT || null;
  if ('ICC_TLS_KEY' in env) config.server.tls.keyPath = env.ICC_TLS_KEY || null;
  if ('ICC_TLS_CA' in env) config.server.tls.caPath = env.ICC_TLS_CA || null;
  if ('ICC_ENROLL_PORT' in env && env.ICC_ENROLL_PORT) config.server.enrollPort = parseInt(env.ICC_ENROLL_PORT, 10);
  return config;
}

export function loadConfig({ reload = false } = {}): ICCConfig {
  if (_cachedConfig && !reload) return _cachedConfig;

  let config = readJSON(DEFAULT_CONFIG_PATH) as unknown as ICCConfig;

  try {
    const userConfig = readJSON(USER_CONFIG_PATH);
    config = deepMerge(config as unknown as Record<string, unknown>, userConfig) as unknown as ICCConfig;
    // Warn if config is readable by group/others
    try {
      const stat = statSync(USER_CONFIG_PATH);
      const mode = stat.mode & 0o777;
      if (mode & 0o077) {
        console.error(`[ICC] WARNING: ${USER_CONFIG_PATH} is readable by group/others (mode ${mode.toString(8)}). Run: chmod 600 ${USER_CONFIG_PATH}`);
      }
    } catch { /* stat failed — ignore */ }
  } catch {
    // No user config — use defaults
  }

  config = applyEnvOverrides(config);
  _cachedConfig = config;
  return config;
}

export function getConfigPath(): string {
  return USER_CONFIG_PATH;
}

export function writeConfig(config: ICCConfig): void {
  const dir = join(homedir(), '.icc');
  mkdirSync(dir, { recursive: true });
  writeFileSync(USER_CONFIG_PATH, JSON.stringify(config, null, 2) + '\n');
  try { chmodSync(USER_CONFIG_PATH, 0o600); } catch { /* Windows */ }
  _cachedConfig = config;
}

export function getFullAddress(config: ICCConfig): string {
  return buildAddress(config.identity, config.instance);
}

export function getPeer(config: ICCConfig, identity: string): RemoteConfig | null {
  return config.remotes?.[identity] || null;
}

export function getPeerIdentities(config: ICCConfig): string[] {
  return Object.keys(config.remotes || {});
}

export function getOutboundToken(config: ICCConfig, peerIdentity: string): string | null {
  return config.remotes?.[peerIdentity]?.token || null;
}

export function getLocalToken(config: ICCConfig): string | null {
  return config.server.localToken || null;
}

export interface ICCTlsOptions {
  cert?: string;
  key?: string;
  ca?: string;
}

export type TlsConnectionOptions = ICCTlsOptions & {
  rejectUnauthorized?: boolean;
  checkServerIdentity?: (hostname: string, cert: PeerCertificate) => Error | undefined;
};

export function getTlsOptions(config: ICCConfig): ICCTlsOptions | null {
  const tls = config.server.tls;
  if (!tls || !tls.enabled) return null;
  const opts: ICCTlsOptions = {};
  if (tls.certPath) opts.cert = readFileSync(tls.certPath, 'utf-8');
  if (tls.keyPath) opts.key = readFileSync(tls.keyPath, 'utf-8');
  if (tls.caPath) opts.ca = readFileSync(tls.caPath, 'utf-8');
  return opts;
}

/**
 * Create a checkServerIdentity function that validates the server cert's CN
 * matches the expected ICC identity. This replaces default hostname/IP
 * verification, which fails for ICC because certs use CN=<identity> without
 * IP SANs. The CA trust chain is already validated by the `ca` TLS option.
 */
export function createIdentityVerifier(expectedIdentity: string): (hostname: string, cert: PeerCertificate) => Error | undefined {
  return (_hostname: string, cert: PeerCertificate) => {
    const cn = cert.subject?.CN;
    if (cn !== expectedIdentity) {
      return new Error(`ICC identity mismatch: expected "${expectedIdentity}", got "${cn}"`);
    }
    // Return undefined = verification passed
  };
}

export function clearConfigCache(): void {
  _cachedConfig = null;
}

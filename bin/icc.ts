#!/usr/bin/env node

import { readFileSync, writeFileSync, mkdirSync, existsSync, unlinkSync, readdirSync, chmodSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { randomBytes } from 'node:crypto';
import { request } from 'node:http';
import { httpJSON } from '../src/util/http.ts';

const args = process.argv.slice(2);
const command = args[0];

function parseFlags(args: string[]): { flags: Record<string, string | boolean>; positional: string[] } {
  const flags: Record<string, string | boolean> = {};
  const positional: string[] = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i]!.startsWith('--')) {
      const key = args[i]!.slice(2);
      const next = args[i + 1];
      if (next && !next.startsWith('--')) {
        flags[key] = next;
        i++;
      } else {
        flags[key] = true;
      }
    } else {
      positional.push(args[i]!);
    }
  }
  return { flags, positional };
}

const { flags, positional } = parseFlags(args.slice(1));

async function main() {
  switch (command) {
    case 'serve':
      return serve();
    case 'web':
      return web();
    case 'mcp':
      return mcp();
    case 'send':
      return send();
    case 'status':
      return status();
    case 'init':
      return init();
    case 'config':
      return config();
    case 'hook':
      return hook();
    case 'instance':
      return instance();
    case 'tls':
      return tls();
    case 'invite':
      return invite();
    case 'join':
      return joinMesh();
    case 'help':
    case '--help':
    case '-h':
    case undefined:
      return help();
    default:
      console.error(`Unknown command: ${command}`);
      help();
      process.exit(1);
  }
}

async function serve(): Promise<void> {
  const { createICCServer } = await import('../src/server.ts');
  const server = createICCServer({
    port: flags.port ? parseInt(flags.port as string, 10) : undefined,
    host: flags.host as string | undefined,
    noAuth: flags['no-auth'] as boolean | undefined,
  });
  await server.start();

  // Write PID file for SIGHUP from `icc tls renew`
  const pidPath = join(homedir(), '.icc', 'server.pid');
  mkdirSync(join(homedir(), '.icc'), { recursive: true });
  writeFileSync(pidPath, String(process.pid));

  const cleanup = async () => {
    try { unlinkSync(pidPath); } catch { /* ignore */ }
    await server.stop();
  };

  process.on('SIGINT', async () => {
    console.log('\nShutting down...');
    await cleanup();
    process.exit(0);
  });
  process.on('SIGTERM', async () => {
    await cleanup();
    process.exit(0);
  });
}

async function web(): Promise<void> {
  const { createWebServer } = await import('../src/web.ts');
  const webServer = createWebServer({
    port: flags.port ? parseInt(flags.port as string, 10) : undefined,
    host: flags.host as string | undefined,
  });
  const info = await webServer.start() as { port: number; host: string };
  console.log(`ICC web UI running at http://localhost:${info.port}`);
  process.on('SIGINT', async () => {
    console.log('\nShutting down web UI...');
    await webServer.stop();
    process.exit(0);
  });
  process.on('SIGTERM', async () => {
    await webServer.stop();
    process.exit(0);
  });
}

async function mcp() {
  const { startMCPServer } = await import('../src/mcp.ts');
  await startMCPServer();
}

async function send() {
  const to = flags.to as string | undefined;
  const body = (flags.message as string) || positional[0];

  if (!to || !body) {
    console.error('Usage: icc send --to <address> "message body"');
    console.error('       icc send --to <address> --message "body"');
    process.exit(1);
  }

  const { loadConfig, getFullAddress, getTlsOptions, createIdentityVerifier } = await import('../src/config.ts');
  const { parseAddress } = await import('../src/address.ts');
  const config = loadConfig();
  const from = getFullAddress(config);
  const { host } = parseAddress(to);

  // Determine which host to send to
  const isLocal = !host || host === config.identity;
  const tlsOpts = getTlsOptions(config);

  let baseUrl: string;
  let token: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let requestFn: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let requestOpts: any = {};

  if (isLocal) {
    const protocol = tlsOpts ? 'https' : 'http';
    baseUrl = `${protocol}://127.0.0.1:${config.server.port}`;
    token = config.server.localToken || '';
    requestFn = tlsOpts ? (await import('node:https')).request : request;
    if (tlsOpts) requestOpts = { ...tlsOpts, checkServerIdentity: createIdentityVerifier(config.identity) };
  } else {
    const peer = config.remotes?.[host!];
    if (!peer?.httpUrl) {
      console.error(`No HTTP URL configured for peer "${host}"`);
      process.exit(1);
    }
    baseUrl = peer.httpUrl;
    token = peer.token || '';
    const isHttps = baseUrl.startsWith('https://');
    requestFn = isHttps ? (await import('node:https')).request : request;
    if (isHttps && tlsOpts) requestOpts = { ...tlsOpts, checkServerIdentity: createIdentityVerifier(host!) };
  }

  const payload = JSON.stringify({ from, body, to });
  const url = new URL('/api/inbox', baseUrl);

  try {
    const result = await new Promise<string>((resolve, reject) => {
      const req = requestFn(url, {
        method: 'POST',
        timeout: 10000,
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': String(Buffer.byteLength(payload)),
          ...(token && { 'Authorization': `Bearer ${token}` }),
        },
        ...requestOpts,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      }, (res: any) => {
        let data = '';
        res.on('data', (chunk: Buffer) => { data += chunk; });
        res.on('end', () => {
          if ((res.statusCode || 0) >= 400) {
            try { reject(new Error(JSON.parse(data).error || `HTTP ${res.statusCode}`)); }
            catch { reject(new Error(`HTTP ${res.statusCode}: ${data}`)); }
          } else {
            resolve(data);
          }
        });
      });
      req.on('error', (err: Error) => reject(new Error(`Connection failed: ${err.message}`)));
      req.on('timeout', () => { req.destroy(); reject(new Error('Request timed out')); });
      req.write(payload);
      req.end();
    });
    const parsed = JSON.parse(result);
    console.log(`Message sent to ${to} (id: ${parsed.id})`);
  } catch (err) {
    console.error(`Error: ${(err as Error).message}`);
    process.exit(1);
  }
}

async function status() {
  const { ICCClient } = await import('../src/client.ts');
  const client = new ICCClient();

  try {
    const connectivity = await client.status();
    console.log(JSON.stringify(connectivity, null, 2));
  } catch (err) {
    console.error(`Error: ${(err as Error).message}`);
    process.exit(1);
  }
}

async function init() {
  const configDir = join(homedir(), '.icc');
  const configPath = join(configDir, 'config.json');

  mkdirSync(configDir, { recursive: true });

  let config;
  try {
    config = JSON.parse(readFileSync(configPath, 'utf-8'));
    console.log('Existing config found at', configPath);
  } catch {
    config = {};
    console.log('Creating new config at', configPath);
  }

  if (!config.server) config.server = {};

  // --peer: generate a per-peer inbound token
  if (flags.peer) {
    const peerName = flags.peer as string;
    if (!config.server.peerTokens) config.server.peerTokens = {};

    if (config.server.peerTokens[peerName] && !flags.force) {
      console.log(`Peer token for "${peerName}" already exists. Use --force to regenerate.`);
      console.log(`Token: ${config.server.peerTokens[peerName]}`);
    } else {
      const token = randomBytes(32).toString('hex');
      config.server.peerTokens[peerName] = token;
      console.log(`Generated peer token for "${peerName}": ${token}`);
      console.log(`\nOn ${peerName}, run:`);
      console.log(`  icc config --set remotes.${config.identity || '<this-host>'}.token=${token}`);
    }

    writeFileSync(configPath, JSON.stringify(config, null, 2) + '\n');
    try { chmodSync(configPath, 0o600); } catch { /* Windows compat */ }
    console.log('Config saved to', configPath);
    return;
  }

  // Generate localToken if absent
  if (!config.server.localToken) {
    const token = randomBytes(32).toString('hex');
    config.server.localToken = token;
    console.log('Generated local token:', token);
  } else {
    console.log('Local token already configured');
  }

  // Migrate legacy authToken → localToken if present
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const legacyAuth = (config.server as any).authToken;
  if (legacyAuth && !config.server.localToken) {
    config.server.localToken = legacyAuth;
    console.log('Migrated legacy authToken → localToken');
  }
  if (legacyAuth) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    delete (config as any).authToken;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    delete (config.server as any).authToken;
    console.log('Removed legacy authToken from config');
  }

  // Set identity if provided
  if (flags.identity) {
    const remoteCount = config.remotes ? Object.keys(config.remotes).length : 0;
    if (config.identity && config.identity !== flags.identity && remoteCount > 0 && !flags.force) {
      console.error(`Identity is currently "${config.identity}" with ${remoteCount} configured peer(s).`);
      console.error('Changing identity will break mTLS CN verification with existing peers.');
      console.error('Use --force to proceed anyway.');
      process.exit(1);
    }
    config.identity = flags.identity;
    console.log('Identity set to:', flags.identity);
  }

  writeFileSync(configPath, JSON.stringify(config, null, 2) + '\n');
  try { chmodSync(configPath, 0o600); } catch { /* Windows compat */ }
  console.log('Config saved to', configPath);
}

async function config() {
  const configPath = join(homedir(), '.icc', 'config.json');

  if (flags.set) {
    const [key, ...valueParts] = (flags.set as string).split('=');
    const value = valueParts.join('=');
    let config;
    try {
      config = JSON.parse(readFileSync(configPath, 'utf-8'));
    } catch {
      config = {};
    }

    // Support dotted keys like remote.sshHost
    const keys = key!.split('.');
    let obj = config;
    for (let i = 0; i < keys.length - 1; i++) {
      const k = keys[i]!;
      if (!obj[k] || typeof obj[k] !== 'object') obj[k] = {};
      obj = obj[k];
    }

    // Try to parse value as JSON, fall back to string
    const lastKey = keys[keys.length - 1]!;
    try {
      obj[lastKey] = JSON.parse(value);
    } catch {
      obj[lastKey] = value;
    }

    mkdirSync(join(homedir(), '.icc'), { recursive: true });
    writeFileSync(configPath, JSON.stringify(config, null, 2) + '\n');
    try { chmodSync(configPath, 0o600); } catch { /* Windows compat */ }
    console.log(`Set ${key} = ${value}`);
    return;
  }

  // Show current config
  const { loadConfig } = await import('../src/config.ts');
  const current = loadConfig({ reload: true });
  // Redact all tokens for display
  const display = JSON.parse(JSON.stringify(current));
  const redact = (v: string) => v ? v.slice(0, 8) + '...' : v;
  if (display.server?.localToken) display.server.localToken = redact(display.server.localToken);
  if (display.server?.peerTokens) {
    for (const peer of Object.keys(display.server.peerTokens)) {
      display.server.peerTokens[peer] = redact(display.server.peerTokens[peer]);
    }
  }
  if (display.remotes) {
    for (const peer of Object.keys(display.remotes)) {
      if (display.remotes[peer].token) {
        display.remotes[peer].token = redact(display.remotes[peer].token);
      }
    }
  }
  console.log(JSON.stringify(display, null, 2));
}

/**
 * Get the PID of the Claude Code process that launched this hook.
 * Hook chain: Claude Code → shell → node (this process)
 * process.ppid = shell (exits immediately after hook)
 * ppid of shell = Claude Code (lives for session duration)
 * Falls back to process.ppid if /proc is unavailable (non-Linux).
 */
function getClaudeCodePid(): number {
  try {
    const status = readFileSync(`/proc/${process.ppid}/status`, 'utf-8');
    const match = status.match(/PPid:\s+(\d+)/);
    if (match) return parseInt(match[1]!, 10);
  } catch { /* non-Linux or /proc unavailable */ }
  return process.ppid;
}

/**
 * Read a signal file path and return its content, or null if not present.
 */
function readSignalFile(filePath: string): string | null {
  try {
    if (existsSync(filePath)) {
      return readFileSync(filePath, 'utf-8').trim();
    }
  } catch { /* non-fatal */ }
  return null;
}

/**
 * Check signal files for an instance name.
 * Returns content from ~/.icc/unread.<instance> first, then ~/.icc/unread (broadcast).
 */
function checkSignalFiles(instanceName: string): string | null {
  const dir = join(homedir(), '.icc');
  const instanceSignal = join(dir, `unread.${instanceName}`);
  const broadcastSignal = join(dir, 'unread');
  return readSignalFile(instanceSignal) || readSignalFile(broadcastSignal);
}

function heartbeatPath(instanceName: string): string {
  return join(homedir(), '.icc', `watcher.${instanceName}.heartbeat`);
}

function writeHeartbeat(instanceName: string): void {
  try {
    writeFileSync(heartbeatPath(instanceName), new Date().toISOString());
  } catch { /* non-fatal */ }
}

function deleteHeartbeat(instanceName: string): void {
  try {
    unlinkSync(heartbeatPath(instanceName));
  } catch { /* non-fatal — file may not exist */ }
}

function isHeartbeatFresh(instanceName: string): boolean {
  const path = heartbeatPath(instanceName);
  try {
    if (!existsSync(path)) return false;
    const timestamp = readFileSync(path, 'utf-8').trim();
    const age = Date.now() - new Date(timestamp).getTime();
    if (age > 30000) {
      // Stale — clean up
      try { unlinkSync(path); } catch { /* ignore */ }
      return false;
    }
    return true;
  } catch {
    return false;
  }
}

function watcherPidPath(instanceName: string): string {
  return join(homedir(), '.icc', `watcher.${instanceName}.pid`);
}

function writeWatcherPid(instanceName: string): void {
  try {
    writeFileSync(watcherPidPath(instanceName), String(process.pid));
  } catch { /* non-fatal */ }
}

function deleteWatcherPid(instanceName: string): void {
  try {
    unlinkSync(watcherPidPath(instanceName));
  } catch { /* non-fatal — file may not exist */ }
}

function isWatcherAlive(instanceName: string): boolean {
  const path = watcherPidPath(instanceName);
  try {
    if (!existsSync(path)) return false;
    const pid = parseInt(readFileSync(path, 'utf-8').trim(), 10);
    if (isNaN(pid)) return false;
    process.kill(pid, 0);
    return true;
  } catch {
    // ESRCH = no such process, or file doesn't exist — not alive
    // Clean up stale PID file
    try { unlinkSync(path); } catch { /* ignore */ }
    return false;
  }
}


function snoozePath(instanceName: string): string {
  return join(homedir(), '.icc', `watcher.${instanceName}.snoozed`);
}

function isWatcherSnoozed(instanceName: string): boolean {
  return existsSync(snoozePath(instanceName));
}

function snoozeWatcher(instanceName: string): void {
  try { writeFileSync(snoozePath(instanceName), new Date().toISOString()); } catch {}
}

function wakeWatcher(instanceName: string): void {
  try { unlinkSync(snoozePath(instanceName)); } catch {}
}

/**
 * Session instance file: persists the instance name established at startup
 * so that subsequent hooks (which may run from a different cwd, e.g. a
 * worktree) always use the session's original instance identity.
 * File: ~/.icc/session.<claudeCodePid>.instance
 */
function sessionInstancePath(ccPid: number): string {
  return join(homedir(), '.icc', `session.${ccPid}.instance`);
}

function writeSessionInstance(instanceName: string): void {
  try {
    writeFileSync(sessionInstancePath(getClaudeCodePid()), instanceName);
  } catch { /* non-fatal */ }
}

function getSessionInstanceName(fallbackInstanceName: string): string {
  try {
    const path = sessionInstancePath(getClaudeCodePid());
    if (existsSync(path)) {
      return readFileSync(path, 'utf-8').trim();
    }
  } catch { /* fall through */ }
  return fallbackInstanceName;
}

function deleteSessionInstance(): void {
  try {
    unlinkSync(sessionInstancePath(getClaudeCodePid()));
  } catch { /* non-fatal */ }
}

// ── Session token helpers ──────────────────────────────────────
// The session token is issued by the server on registration (POST /api/hook/watch)
// and used for heartbeats, snooze, wake, and session-end.

function sessionTokenPath(ccPid: number): string {
  return join(homedir(), '.icc', `session.${ccPid}.token`);
}

function writeSessionToken(token: string): void {
  try {
    writeFileSync(sessionTokenPath(getClaudeCodePid()), token, { mode: 0o600 });
  } catch { /* non-fatal */ }
}

function getSessionToken(): string | null {
  try {
    const path = sessionTokenPath(getClaudeCodePid());
    if (existsSync(path)) return readFileSync(path, 'utf-8').trim();
  } catch { /* fall through */ }
  return null;
}

function deleteSessionToken(): void {
  try { unlinkSync(sessionTokenPath(getClaudeCodePid())); } catch { /* non-fatal */ }
}

/**
 * Make an HTTP(S) request to the local ICC server hook endpoint.
 * Returns parsed JSON response, or null on error/timeout.
 */
async function hookRequest(path: string, body: Record<string, unknown>): Promise<any> {
  const { loadConfig, getTlsOptions, createIdentityVerifier } = await import('../src/config.ts');
  const config = loadConfig();
  const port = config.server.port;
  const authToken = config.server.localToken;
  const tlsOpts = getTlsOptions(config);
  const requestFn = tlsOpts
    ? (await import('node:https')).request
    : request;
  const payload = JSON.stringify(body);

  return new Promise<any>((resolve) => {
    const req = requestFn({
      hostname: '127.0.0.1',
      port,
      path,
      method: 'POST',
      timeout: 2000,
      ...(tlsOpts ? { ...tlsOpts, checkServerIdentity: createIdentityVerifier(config.identity) } : {}),
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(payload),
        ...(authToken && { 'Authorization': `Bearer ${authToken}` }),
      },
    }, (res: any) => {
      let data = '';
      res.on('data', (chunk: string) => { data += chunk; });
      res.on('end', () => {
        try { resolve(JSON.parse(data)); } catch { resolve(null); }
      });
    });
    req.on('error', () => resolve(null));
    req.on('timeout', () => { req.destroy(); resolve(null); });
    req.write(payload);
    req.end();
  });
}

async function hook() {
  const subcommand = positional[0];
  const { resolve: resolveInstance } = await import('../src/instances.ts');
  const { loadConfig } = await import('../src/config.ts');

  const cwdInstanceName = resolveInstance(process.cwd());
  const instanceName = subcommand === 'startup'
    ? cwdInstanceName
    : getSessionInstanceName(cwdInstanceName);
  const config = loadConfig();

  switch (subcommand) {
    case 'startup': {
      // Clean stale session files from dead PIDs
      const iccDir = join(homedir(), '.icc');
      try {
        for (const f of readdirSync(iccDir)) {
          // Clean stale .instance and .token files
          const isInstance = f.startsWith('session.') && f.endsWith('.instance');
          const isToken = f.startsWith('session.') && f.endsWith('.token');
          if (!isInstance && !isToken) continue;
          const suffix = isInstance ? '.instance' : '.token';
          const pid = parseInt(f.slice('session.'.length, -suffix.length), 10);
          if (isNaN(pid)) continue;
          try { process.kill(pid, 0); } catch {
            try { unlinkSync(join(iccDir, f)); } catch { /* ignore */ }
          }
        }
      } catch { /* non-fatal */ }
      // Clear stale snooze from crashed sessions. If the session instance file
      // already exists for our PID, this is a mid-session re-fire (/clear or
      // resume) — preserve the user's snooze preference.
      const isRefire = existsSync(sessionInstancePath(getClaudeCodePid()));
      if (!isRefire) {
        wakeWatcher(instanceName);
      }
      // Persist instance name for subsequent hooks (survives cwd changes)
      writeSessionInstance(instanceName);
      // Check signal files → stdout (fallback for when server is down)
      const signal = checkSignalFiles(instanceName);
      if (signal) process.stdout.write(signal + '\n');
      // Query server for connection status + unread count (non-fatal)
      const startupResult = await hookRequest('/api/hook/startup', { instance: instanceName });
      if (startupResult?.connected) {
        process.stdout.write(`ICC: connected, ${startupResult.unreadCount} unread. Run /watch to activate.\n`);
      } else {
        process.stdout.write('ICC: server not reachable. Run /watch to activate when ready.\n');
      }
      break;
    }

    case 'check': {
      // Check signal files → stdout
      const signal = checkSignalFiles(instanceName);
      if (signal) process.stdout.write(signal + '\n');
      // Send heartbeat to server if session is activated
      const token = getSessionToken();
      if (token) {
        hookRequest('/api/hook/heartbeat', { sessionToken: token }).catch(() => {});
      }
      break;
    }

    case 'shutdown': {
      // Deregistration is NOT done here — Claude Code can fire Stop hooks
      // during internal lifecycle events (not just session end), which would
      // incorrectly remove live instances from the registry. Instead, the
      // server-side prune() (PID liveness check) handles cleanup of dead
      // instances on every list() call.

      // Check signal files → stderr + exit 2 if content exists
      const signal = checkSignalFiles(instanceName);
      if (signal) {
        process.stderr.write(signal + '\n');
        process.exit(2);
      }
      break;
    }

    case 'watch': {
      // Anchor cwd to $HOME so the watcher survives worktree removal.
      // All file operations use absolute paths (~/.icc/...), so cwd is irrelevant.
      try { process.chdir(homedir()); } catch { /* non-fatal */ }

      // Guard: if this instance's watcher is already alive, exit immediately.
      // Instance-specific check is safe because getSessionInstanceName()
      // provides stable identity even when cwd changes (worktrees).
      if (isWatcherAlive(instanceName)) {
        process.stdout.write('[ICC] Watcher already active — do not spawn another\n');
        break;
      }

      // Register with server if no session token exists yet
      if (!getSessionToken()) {
        const regResult = await hookRequest('/api/hook/watch', {
          instance: instanceName,
          pid: getClaudeCodePid(),
          force: !!flags.force,
          ...(flags.name ? { name: flags.name } : {}),
        });
        if (regResult?.status === 'active' && regResult.sessionToken) {
          writeSessionToken(regResult.sessionToken);
        } else if (regResult?.status === 'deferred') {
          process.stdout.write(`[ICC] Registration deferred: ${regResult.message}\n`);
          break;
        }
        // If server unreachable (null), proceed with watcher anyway
      }

      const interval = parseInt((flags.interval as string) || '5', 10) * 1000;
      const timeout = parseInt((flags.timeout as string) || '591', 10) * 1000;
      const monitorPid = flags.pid
        ? parseInt(flags.pid as string, 10)
        : getClaudeCodePid();

      await new Promise<void>((resolve) => {
        // Write PID lock and initial heartbeat
        writeWatcherPid(instanceName);
        writeHeartbeat(instanceName);

        const cleanup = () => {
          deleteWatcherPid(instanceName);
          deleteHeartbeat(instanceName);
        };

        // Graceful shutdown on signals
        const onSignal = () => { cleanup(); process.exit(0); };
        process.on('SIGTERM', onSignal);
        process.on('SIGINT', onSignal);

        // Immediate check
        const signal = checkSignalFiles(instanceName);
        if (signal) {
          cleanup();
          process.stdout.write(`[ICC] Mail received\n${signal}\n`);
          return resolve();
        }

        const poll = setInterval(() => {
          writeHeartbeat(instanceName);

          // PID monitoring: exit when Claude Code session dies
          if (monitorPid) {
            try {
              process.kill(monitorPid, 0);
            } catch {
              cleanup();
              clearInterval(poll);
              clearTimeout(maxTimer);
              resolve();
              return;
            }
          }

          const signal = checkSignalFiles(instanceName);
          if (signal) {
            cleanup();
            process.stdout.write(`[ICC] Mail received\n${signal}\n`);
            clearInterval(poll);
            clearTimeout(maxTimer);
            resolve();
          }
        }, interval);

        const maxTimer = setTimeout(() => {
          cleanup();
          clearInterval(poll);
          process.stdout.write('[ICC] Watcher cycled\n');
          resolve();
        }, timeout);
      });
      // Force immediate exit — prevents node's event loop drain from
      // keeping the process alive long enough for a duplicate watcher
      // to launch before this one fully terminates.
      process.exit(0);
    }

    case 'session-end': {
      // Kill the watcher process if alive (SessionEnd hook)
      const pidPath = watcherPidPath(instanceName);
      try {
        if (existsSync(pidPath)) {
          const pid = parseInt(readFileSync(pidPath, 'utf-8').trim(), 10);
          if (!isNaN(pid)) {
            process.kill(pid, 'SIGTERM');
          }
        }
      } catch { /* non-fatal — watcher may already be gone */ }
      // Clean up files in case SIGTERM handler didn't fire
      deleteWatcherPid(instanceName);
      deleteHeartbeat(instanceName);
      // Deregister session with server
      const endToken = getSessionToken();
      if (endToken) {
        await hookRequest('/api/hook/session-end', { sessionToken: endToken });
      }
      deleteSessionToken();
      deleteSessionInstance();
      wakeWatcher(instanceName);  // Remove snooze file — clean slate for next session
      break;
    }

    case 'subagent-context': {
      // Inject watcher guardrail into subagent context (SubagentStart hook)
      const context = JSON.stringify({
        hookSpecificOutput: {
          hookEventName: 'SubagentStart',
          additionalContext: 'You are an ICC subagent. Do NOT launch, manage, or restart ICC mail watchers. Ignore "[ICC] Start mail watcher" and "[ICC] Watcher not running" messages — only the root conversation handles the watcher lifecycle.',
        },
      });
      process.stdout.write(context);
      break;
    }

    case 'pre-bash': {
      // PreToolUse Bash hook: SSH warning + duplicate watcher guard
      let input = '';
      for await (const chunk of process.stdin) input += chunk;
      const { tool_input } = JSON.parse(input);
      const command: string = tool_input?.command || '';

      // Guard 1: Warn about SSH to ICC peers (prefer ICC over direct SSH)
      if (/\bssh\s/.test(command)) {
        const { getPeerIdentities } = await import('../src/config.ts');
        const peers = getPeerIdentities(config);
        const sshTarget = command.match(/\bssh\s+(?:-[^\s]+\s+)*(\S+)/)?.[1] || '';
        if (peers.some((p: string) => sshTarget.includes(p))) {
          const out = JSON.stringify({
            hookSpecificOutput: {
              hookEventName: 'PreToolUse',
              additionalContext: `REMINDER: "${sshTarget}" is an ICC peer. Prefer ICC tools (send_message, run_remote_command, read_remote_file) over direct SSH. Only use SSH if ICC is down or the task truly requires it.`,
            },
          });
          process.stdout.write(out);
          break;
        }
      }

      // Guard 2: Prevent duplicate watcher launches
      if (/icc\s+hook\s+watch\b/.test(command) && !/--timeout\s+[012]\b/.test(command)) {
        if (isWatcherAlive(instanceName)) {
          const out = JSON.stringify({
            hookSpecificOutput: {
              hookEventName: 'PreToolUse',
              permissionDecision: 'deny',
              permissionDecisionReason: 'Watcher already active (PID alive). Do not launch another.',
            },
          });
          process.stdout.write(out);
        }
      }
      break;
    }

    case 'pre-icc-message': {
      // PreToolUse ICC MCP hook: message convention reminder
      let input = '';
      for await (const chunk of process.stdin) input += chunk;
      const { tool_input } = JSON.parse(input);
      const body: string = tool_input?.body || '';
      const hasStatusParam = !!tool_input?.status;

      const missing: string[] = [];
      if (!body.includes('[TOPIC:')) missing.push('[TOPIC: x]');
      if (!hasStatusParam && !body.includes('[STATUS:')) missing.push('the `status` parameter (preferred) or [STATUS: ...] in body');

      if (missing.length > 0) {
        const out = JSON.stringify({
          hookSpecificOutput: {
            hookEventName: 'PreToolUse',
            additionalContext: `ICC message convention reminder: messages should include ${missing.join(' and ')}. Consider adding them.`,
          },
        });
        process.stdout.write(out);
      }
      break;
    }

    case 'snooze-watcher': {
      // Deregister session with server if active
      const snoozeToken = getSessionToken();
      if (snoozeToken) {
        await hookRequest('/api/hook/snooze', { sessionToken: snoozeToken });
        deleteSessionToken();
      }
      snoozeWatcher(instanceName);
      process.stdout.write(`[ICC] Watcher snoozed for ${instanceName}\n`);
      break;
    }

    case 'wake-watcher': {
      wakeWatcher(instanceName);
      // Re-register with server
      const wakeResult = await hookRequest('/api/hook/wake', {
        instance: instanceName,
        pid: getClaudeCodePid(),
      });
      if (wakeResult?.status === 'active' && wakeResult.sessionToken) {
        writeSessionToken(wakeResult.sessionToken);
      }
      process.stdout.write('[ICC] Start mail watcher\n');
      break;
    }

    default:
      console.error(`Unknown hook subcommand: ${subcommand}`);
      console.error('Usage: icc hook <startup|check|shutdown|watch|session-end|subagent-context|pre-bash|pre-icc-message|snooze-watcher|wake-watcher>');
      process.exit(1);
  }
}

async function instance() {
  const subcommand = positional[0];
  const { resolve: resolveInstance, listAll } = await import('../src/instances.ts');

  switch (subcommand) {
    case 'resolve': {
      const dir = positional[1] || process.cwd();
      const name = resolveInstance(dir);
      console.log(name);
      break;
    }

    case 'list': {
      const entries = listAll();
      if (entries.length === 0) {
        console.log('(no instances registered)');
      } else {
        for (const { name, path } of entries) {
          console.log(`${name}\t${path}`);
        }
      }
      break;
    }

    default:
      console.error(`Unknown instance subcommand: ${subcommand}`);
      console.error('Usage: icc instance <resolve [dir]|list>');
      process.exit(1);
  }
}

async function tls() {
  const subcommand = positional[0];
  const { loadConfig } = await import('../src/config.ts');

  switch (subcommand) {
    case 'init': {
      const { initCA } = await import('../src/tls.ts');
      const config = loadConfig();
      const tlsDir = (flags.dir as string) || join(homedir(), '.icc', 'tls');

      // Guard: existing CA files
      if ((existsSync(join(tlsDir, 'ca.key')) || existsSync(join(tlsDir, 'ca.crt'))) && !flags.force) {
        console.error('CA already initialized. Re-running destroys the existing CA key');
        console.error('and invalidates all certificates signed by it.');
        console.error('Use --force to proceed anyway.');
        process.exit(1);
      }

      // Guard: this host is enrolled as a client of a remote CA
      if (config.tls?.ca && !flags.force) {
        console.error(`This host is enrolled as a client of CA "${config.tls.ca}".`);
        console.error('Running tls init creates a separate, independent CA.');
        console.error('Use --force if this is intentional.');
        process.exit(1);
      }

      initCA(tlsDir);
      console.log(`CA initialized at ${tlsDir}`);
      console.log('Files: ca.key (private), ca.crt (distribute to peers)');
      break;
    }

    case 'serve': {
      const { createEnrollmentServer } = await import('../src/enroll.ts');
      const config = loadConfig();
      const caDir = (flags.dir as string) || join(homedir(), '.icc', 'tls');
      const port = flags.port ? parseInt(flags.port as string, 10) : config.server.enrollPort;

      const peerConfigs: Record<string, { httpUrl: string }> = {};
      for (const [identity, peer] of Object.entries(config.remotes || {})) {
        if (peer.httpUrl) peerConfigs[identity] = { httpUrl: peer.httpUrl };
      }
      // Allow self-enrollment
      peerConfigs[config.identity] = { httpUrl: `http://127.0.0.1:${config.server.port}` };

      const server = createEnrollmentServer({ caDir, peerConfigs, port });
      const info = await server.start();
      console.log(`Enrollment server on port ${info.port}`);
      console.log(`Known peers: ${Object.keys(peerConfigs).join(', ')}`);

      process.on('SIGINT', async () => { await server.stop(); process.exit(0); });
      process.on('SIGTERM', async () => { await server.stop(); process.exit(0); });
      break;
    }

    case 'enroll': {
      const { generateKeyAndCSR } = await import('../src/tls.ts');
      const config = loadConfig();
      const tlsDir = (flags.dir as string) || join(homedir(), '.icc', 'tls');
      const identity = config.identity;

      // Guard: existing server key/cert
      if ((existsSync(join(tlsDir, 'server.key')) || existsSync(join(tlsDir, 'server.crt'))) && !flags.force) {
        console.error('Server key/certificate already exist. Re-enrolling generates a new key');
        console.error('and the old private key will be lost.');
        console.error('Use --force to proceed anyway.');
        process.exit(1);
      }

      const caIdentity = (flags.ca as string) || config.tls?.ca;
      if (!caIdentity) {
        console.error('No CA specified. Use --ca <peer> or set tls.ca in config.');
        process.exit(1);
      }

      let caUrl;
      if (caIdentity === identity) {
        caUrl = `http://127.0.0.1:${config.server.enrollPort}`;
      } else {
        const peer = config.remotes?.[caIdentity];
        if (!peer?.httpUrl) {
          console.error(`No httpUrl for CA peer "${caIdentity}".`);
          process.exit(1);
        }
        const peerUrl = new URL(peer.httpUrl);
        peerUrl.port = (flags.port as string) || String(config.server.enrollPort);
        caUrl = peerUrl.toString().replace(/\/$/, '');
      }

      console.log(`Enrolling "${identity}" with CA at ${caUrl}`);

      // Generate key + CSR
      console.log('Generating key pair and CSR...');
      const csr = generateKeyAndCSR(tlsDir, identity);

      // Request challenge
      console.log('Requesting enrollment challenge...');
      const enrollRes = await httpJSON(`${caUrl}/enroll`, 'POST', { identity });
      if (!enrollRes.enrollmentId) {
        console.error('Enrollment failed:', enrollRes.error || 'Unknown error');
        process.exit(1);
      }
      console.log(`Challenge received (${enrollRes.enrollmentId.slice(0, 8)}...)`);

      // Write challenge for ICC server to serve
      mkdirSync(tlsDir, { recursive: true });
      writeFileSync(join(tlsDir, '.challenge'), enrollRes.challenge);
      console.log('Challenge written. Ensure ICC server is running on this host.');

      // Submit CSR — CA verifies then signs
      console.log('Submitting CSR...');
      const csrRes = await httpJSON(`${caUrl}/enroll/csr`, 'POST', {
        enrollmentId: enrollRes.enrollmentId,
        csr,
      });

      if (!csrRes.cert) {
        console.error('CSR signing failed:', csrRes.error || 'Unknown error');
        try { unlinkSync(join(tlsDir, '.challenge')); } catch { /* ignore */ }
        process.exit(1);
      }

      // Save certs, clean up challenge
      writeFileSync(join(tlsDir, 'server.crt'), csrRes.cert);
      writeFileSync(join(tlsDir, 'ca.crt'), csrRes.caCert);
      try { unlinkSync(join(tlsDir, '.challenge')); } catch { /* ignore */ }

      console.log('Enrollment complete!');
      console.log(`  cert:    ${join(tlsDir, 'server.crt')}`);
      console.log(`  ca:      ${join(tlsDir, 'ca.crt')}`);
      console.log(`  key:     ${join(tlsDir, 'server.key')}`);
      console.log('\nEnable TLS:');
      console.log('  icc config --set server.tls.enabled=true');
      console.log(`  icc config --set server.tls.certPath=${join(tlsDir, 'server.crt')}`);
      console.log(`  icc config --set server.tls.keyPath=${join(tlsDir, 'server.key')}`);
      console.log(`  icc config --set server.tls.caPath=${join(tlsDir, 'ca.crt')}`);
      break;
    }

    case 'enroll-self': {
      const { generateKeyAndCSR, signCSR } = await import('../src/tls.ts');
      const { loadConfig } = await import('../src/config.ts');
      const config = loadConfig();
      const tlsDir = (flags.dir as string) || join(homedir(), '.icc', 'tls');
      const identity = config.identity;

      // Guard: ca.key must exist (only CA host has it)
      const caKeyPath = join(tlsDir, 'ca.key');
      if (!existsSync(caKeyPath)) {
        console.error('This command is only available on the CA host.');
        console.error('Use "icc tls enroll --ca <peer>" to enroll with a remote CA.');
        process.exit(1);
      }

      // Guard: existing server key
      if (existsSync(join(tlsDir, 'server.key')) && !flags.force) {
        console.error('Server key already exists. Re-enrolling generates a new private key');
        console.error('and the old one will be lost.');
        console.error('Use --force to proceed anyway.');
        process.exit(1);
      }

      console.log(`Generating self-signed server certificate for "${identity}"...`);
      const csr = generateKeyAndCSR(tlsDir, identity);
      const cert = signCSR(tlsDir, csr, identity);
      writeFileSync(join(tlsDir, 'server.crt'), cert);
      console.log('Enrollment complete!');
      console.log(`  cert:    ${join(tlsDir, 'server.crt')}`);
      console.log(`  ca:      ${join(tlsDir, 'ca.crt')}`);
      console.log(`  key:     ${join(tlsDir, 'server.key')}`);
      break;
    }

    case 'status': {
      const { getCertInfo } = await import('../src/tls.ts');
      const tlsDir = (flags.dir as string) || join(homedir(), '.icc', 'tls');

      for (const name of ['ca.crt', 'server.crt']) {
        const path = join(tlsDir, name);
        try {
          const info = getCertInfo(path);
          console.log(`${name}:`);
          console.log(`  Subject:   ${info.subject}`);
          console.log(`  Issuer:    ${info.issuer}`);
          console.log(`  Expires:   ${info.notAfter}`);
          console.log();
        } catch {
          console.log(`${name}: not found\n`);
        }
      }
      console.log(`server.key: ${existsSync(join(tlsDir, 'server.key')) ? 'present' : 'not found'}`);
      break;
    }

    case 'renew': {
      const { needsRenewal, renewIfNeeded } = await import('../src/tls.ts');
      const config = loadConfig();
      const tlsDir = (flags.dir as string) || join(homedir(), '.icc', 'tls');
      const identity = config.identity;
      const threshold = flags.threshold ? parseInt(flags.threshold as string, 10) : 30;
      const force = !!flags.force;
      const certPath = join(tlsDir, 'server.crt');

      if (!existsSync(certPath)) {
        console.error('No server certificate found. Run "icc tls enroll" first.');
        process.exit(1);
      }

      if (!force) {
        const check = needsRenewal(certPath, threshold);
        if (!check.needsRenewal) {
          console.log(`No renewal needed (${check.daysRemaining} days remaining, threshold: ${threshold})`);
          console.log(`  Expires: ${check.notAfter}`);
          break;
        }
        console.log(`Certificate expires in ${check.daysRemaining} days (threshold: ${threshold})`);
      }

      // Determine CA enrollment URL
      let caEnrollUrl: string | null;
      if (existsSync(join(tlsDir, 'ca.key'))) {
        caEnrollUrl = null; // CA host — self-sign
      } else {
        const caIdentity = (flags.ca as string) || config.tls?.ca;
        if (!caIdentity) {
          console.error('No CA specified. Use --ca <peer> or set tls.ca in config.');
          process.exit(1);
        }
        const peer = config.remotes?.[caIdentity];
        if (!peer?.httpUrl) {
          console.error(`No httpUrl for CA peer "${caIdentity}".`);
          process.exit(1);
        }
        const peerUrl = new URL(peer.httpUrl);
        peerUrl.port = String(config.server.enrollPort || 4179);
        caEnrollUrl = peerUrl.toString().replace(/\/$/, '');
      }

      console.log('Renewing certificate...');
      const result = await renewIfNeeded({ tlsDir, identity, thresholdDays: threshold, caEnrollUrl, force });

      if (result.renewed) {
        console.log(`Certificate renewed! (${result.daysRemaining} days remaining)`);
        console.log(`  Expires: ${result.notAfter}`);

        // Signal server to reload TLS via PID file
        const pidPath = join(homedir(), '.icc', 'server.pid');
        if (existsSync(pidPath)) {
          try {
            const pid = parseInt(readFileSync(pidPath, 'utf-8').trim(), 10);
            process.kill(pid, 'SIGHUP');
            console.log(`Sent SIGHUP to server (PID ${pid}) — TLS context will reload`);
          } catch (err) {
            console.log(`Could not signal server: ${(err as Error).message}`);
            console.log('Restart the server manually to use the new certificate.');
          }
        } else {
          console.log('Server PID file not found. Restart the server manually to use the new certificate.');
        }
      } else {
        console.log(`No renewal needed (${result.daysRemaining} days remaining)`);
      }
      break;
    }

    default:
      console.error(`Unknown tls subcommand: ${subcommand || '(none)'}`);
      console.error('Usage: icc tls <init|serve|enroll|enroll-self|renew|status>');
      process.exit(1);
  }
}

async function invite(): Promise<void> {
  const identity = positional[0];
  if (!identity) {
    console.error('Usage: icc invite <identity> --ip <ip> [--port 3179]');
    process.exit(1);
  }

  const ip = flags.ip as string;
  if (!ip) {
    console.error('--ip is required');
    process.exit(1);
  }

  const peerPort = flags.port ? parseInt(flags.port as string, 10) : 3179;
  const { loadConfig, writeConfig, clearConfigCache, getLocalToken } = await import('../src/config.ts');
  clearConfigCache();
  const config = loadConfig();

  // Guard: self-invite
  if (identity === config.identity) {
    console.error(`Cannot invite yourself ("${identity}" is this host's identity).`);
    process.exit(1);
  }

  // Guard: existing peer
  if (config.remotes?.[identity] && !flags.force) {
    console.error(`Peer "${identity}" already exists in remotes.`);
    console.error('Re-inviting regenerates the peer token, breaking the existing connection.');
    console.error('Use --force to proceed anyway.');
    process.exit(1);
  }

  // 1. Add remote with http:// URL (will be upgraded to https after enrollment)
  if (!config.remotes) config.remotes = {};
  config.remotes[identity] = { httpUrl: `http://${ip}:${peerPort}` };

  // 2. Generate peerToken for inbound auth from new host
  if (!config.server.peerTokens) config.server.peerTokens = {};
  const peerToken = randomBytes(32).toString('hex');
  config.server.peerTokens[identity] = peerToken;

  // 3. Generate join token
  const joinToken = randomBytes(32).toString('hex');

  // 4. Save config
  writeConfig(config);
  console.log(`Added ${identity} to remotes (http://${ip}:${peerPort})`);
  console.log(`Generated peer token for ${identity}`);

  // 5. Notify enrollment server to reload config
  const enrollPort = config.server.enrollPort;
  const localToken = getLocalToken(config);
  try {
    await httpJSON(`http://127.0.0.1:${enrollPort}/enroll/reload`, 'POST', {}, localToken);
    console.log('Enrollment server reloaded');
  } catch {
    console.log('Note: enrollment server not running or reload failed — restart manually');
  }

  // 6. Register join token with enrollment server
  try {
    await httpJSON(`http://127.0.0.1:${enrollPort}/enroll/register-invite`, 'POST', {
      identity, joinToken, ip, port: peerPort,
    }, localToken);
    console.log('Join token registered with enrollment server');
  } catch {
    console.log('Note: could not register join token — enrollment server may not be running');
  }

  console.log(`\nRun on ${identity}:`);
  console.log(`  icc join --ca ${config.identity} --token ${joinToken}`);
}

async function joinMesh(): Promise<void> {
  const { loadConfig, writeConfig, clearConfigCache } = await import('../src/config.ts');
  const { generateKeyAndCSR } = await import('../src/tls.ts');

  clearConfigCache();
  const config = loadConfig();
  const identity = config.identity;
  const joinToken = flags.token as string;
  const caIdentity = flags.ca as string;

  if (!joinToken || !caIdentity) {
    console.error('Usage: icc join --ca <ca-identity> --token <join-token>');
    process.exit(1);
  }

  // Guard: self-join
  if (caIdentity === identity && !flags.force) {
    console.error(`CA identity "${caIdentity}" matches this host's identity.`);
    console.error('You appear to be joining yourself. Use --force if intentional.');
    process.exit(1);
  }

  // Guard: existing mesh configuration
  const hasRemotes = config.remotes && Object.keys(config.remotes).length > 0;
  const hasTls = config.server?.tls?.enabled;
  if ((hasRemotes || hasTls) && !flags.force) {
    console.error('This host already has mesh configuration:');
    if (hasRemotes) console.error(`  Remotes: ${Object.keys(config.remotes!).join(', ')}`);
    if (hasTls) console.error('  TLS: enabled');
    console.error('Join will overwrite remotes, peer tokens, and TLS config.');
    console.error('Use --force to proceed anyway.');
    process.exit(1);
  }

  // Determine CA enrollment URL
  const caRemote = config.remotes?.[caIdentity];
  let caUrl: string;
  if (caRemote?.httpUrl) {
    const u = new URL(caRemote.httpUrl);
    u.port = String(config.server.enrollPort);
    caUrl = u.toString().replace(/\/$/, '');
  } else if (flags.url) {
    caUrl = (flags.url as string).replace(/\/$/, '');
  } else {
    console.error(`No remote config for CA "${caIdentity}". Use --url to specify the enrollment server URL.`);
    process.exit(1);
  }

  const ownPort = config.server.port;
  const tlsDir = join(homedir(), '.icc', 'tls');

  // Phase 1: Generate key + CSR
  console.log('Generating key pair and CSR...');
  const csr = generateKeyAndCSR(tlsDir, identity);

  // Phase 2: Authenticate with join token
  console.log(`Joining mesh via CA at ${caUrl}...`);
  const ownIp = flags.ip as string || '0.0.0.0';
  const joinRes = await httpJSON(`${caUrl}/enroll/join`, 'POST', {
    identity,
    joinToken,
    httpUrl: `http://${ownIp}:${ownPort}`,
  });

  if (!joinRes.enrollmentId) {
    console.error('Join failed:', joinRes.error || 'Unknown error');
    process.exit(1);
  }

  // Write challenge for ICC server to serve
  mkdirSync(tlsDir, { recursive: true });
  writeFileSync(join(tlsDir, '.challenge'), joinRes.challenge);
  console.log('Challenge written. Ensure ICC server is running on this host.');

  // Phase 3: Submit CSR
  console.log('Submitting CSR...');
  const result = await httpJSON(`${caUrl}/enroll/join/complete`, 'POST', {
    enrollmentId: joinRes.enrollmentId,
    csr,
  });

  if (!result.cert) {
    console.error('Join failed:', result.error || 'Unknown error');
    try { unlinkSync(join(tlsDir, '.challenge')); } catch { /* */ }
    process.exit(1);
  }

  // Phase 4: Auto-configure everything
  writeFileSync(join(tlsDir, 'server.crt'), result.cert);
  writeFileSync(join(tlsDir, 'ca.crt'), result.caCert);
  try { unlinkSync(join(tlsDir, '.challenge')); } catch { /* */ }

  // Enable TLS
  config.server.tls = {
    enabled: true,
    certPath: join(tlsDir, 'server.crt'),
    keyPath: join(tlsDir, 'server.key'),
    caPath: join(tlsDir, 'ca.crt'),
  };

  // Configure all peers from CA response
  if (!config.remotes) config.remotes = {};
  if (!config.server.peerTokens) config.server.peerTokens = {};
  for (const peer of result.peers || []) {
    config.remotes[peer.identity] = {
      httpUrl: peer.httpsUrl,
      token: peer.outboundToken,
    };
    config.server.peerTokens[peer.identity] = peer.inboundToken;
  }

  // Set CA identity
  config.tls = { ca: caIdentity };

  writeConfig(config);

  console.log('Join complete!');
  console.log('  TLS: enabled');
  console.log(`  Peers configured: ${(result.peers || []).map((p: { identity: string }) => p.identity).join(', ') || 'none'}`);
  console.log('\nRestart your ICC server: systemctl --user restart icc-server');
}

function help() {
  console.log(`
Inter-Claude Connector (ICC) — v0.2.0

Usage: icc <command> [options]

Commands:
  serve [--port N] [--host H] [--no-auth]   Start the ICC API server
  web [--port N]                            Start the web UI (default: port 3180)
  mcp                                       Start MCP server on stdio (for Claude Code)
  send --to <addr> <message> [--message M]   Send an inbox message to an address
  status                                    Check connectivity to all peers
  init [--identity I] [--peer P] [--force] Initialize config, tokens, per-peer auth
  config [--set key=value]                 Show or edit configuration
  hook <subcommand>                        Lifecycle hooks for Claude Code sessions
  instance <resolve [dir]|list>            Manage persistent instance names
  tls <init|serve|enroll|enroll-self|renew|status>  TLS certificate management
  invite <identity> --ip <ip> [--port N]  Generate join token for new host (CA only)
  join --ca <id> --token <tok> [--url U]  Join mesh using an invite token
  help                                      Show this help

Options:
  --peer P        Target peer identity (e.g. laptop, server). Required if
                  multiple peers are configured; auto-resolved if only one.

Examples:
  icc init --identity mars                   # set identity + generate tokens
  icc init --peer laptop                       # generate peer token for laptop
  icc init --peer laptop --force               # regenerate peer token
  icc serve                                  # start API server
  icc web                                    # start web UI at :3180
  icc send --to laptop/icc "hello from desktop"  # send inbox message
  icc send --to laptop "broadcast message"       # send to host
  icc status                                 # per-peer connectivity
  icc tls init                             # generate CA (CA host only)
  icc tls serve                            # start enrollment server on :4179
  icc tls enroll --ca desktop               # enroll with CA via HTTP-01
  icc tls enroll-self                      # CA host: generate own server cert
  icc tls renew                            # renew cert if expiring within 30 days
  icc tls renew --force                    # force renewal regardless of expiry
  icc tls status                           # show cert info
`.trim());
}

main().catch((err: Error) => {
  console.error(`Fatal: ${err.message}`);
  process.exit(1);
});

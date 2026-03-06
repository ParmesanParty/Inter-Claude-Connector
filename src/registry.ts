/**
 * Instance registry — ephemeral, in-memory tracking of live ICC instances on this host.
 *
 * State machine: ACTIVE → GRACE (30s) → PURGATORY (10min) → UNREGISTERED
 *
 * Two modes:
 * - Session-based (Docker/new): uses sessionToken for ownership, watcher connection for liveness
 * - PID-based (legacy bare-metal): uses process.kill(pid, 0) for liveness
 *
 * Session-based registrations use the state machine. PID-based registrations
 * fall back to the original prune-on-list behavior.
 */

import { readFileSync } from 'node:fs';
import { createLogger } from './util/logger.ts';
import type { RegistryEntry } from './types.ts';

const log = createLogger('registry');

// ── State machine ────────────────────────────────────────────────

export type RegistrationState = 'ACTIVE' | 'GRACE' | 'PURGATORY' | 'UNREGISTERED';

const GRACE_TIMEOUT_MS = 30_000;    // 30s
const PURGATORY_TIMEOUT_MS = 600_000; // 10min

interface SessionRegistration {
  sessionToken: string;
  pid: number;
  state: RegistrationState;
  lastSeen: string;
  snoozed: boolean;
  graceTimer?: ReturnType<typeof setTimeout>;
  purgatoryTimer?: ReturnType<typeof setTimeout>;
}

// Session-based registrations (keyed by instance name)
const sessions = new Map<string, SessionRegistration>();

// ── Legacy (PID-based) registration ──────────────────────────────

interface RegistryRegisterInput {
  instance: string;
  pid: number;
  address: string;
}

interface DeregisterOptions {
  pid?: number;
}

const instances = new Map<string, RegistryEntry>();

export function register({ instance, pid, address }: RegistryRegisterInput): RegistryEntry {
  if (!instance || !pid || !address) {
    throw new Error('Missing required fields: instance, pid, address');
  }
  const now = new Date().toISOString();
  const existing = instances.get(instance);
  if (existing) {
    existing.pid = pid;
    existing.address = address;
    existing.lastSeen = now;
    log.info(`Updated instance "${instance}" (pid ${pid})`);
    return existing;
  }
  const entry: RegistryEntry = { address, instance, pid, registeredAt: now, lastSeen: now };
  instances.set(instance, entry);
  log.info(`Registered instance "${instance}" (pid ${pid})`);
  return entry;
}

export function list(): RegistryEntry[] {
  prune();
  // Combine legacy entries with session-based entries
  const result = [...instances.values()];
  for (const [name, reg] of sessions) {
    if (reg.state === 'ACTIVE' || reg.state === 'GRACE' || reg.state === 'PURGATORY') {
      // Don't duplicate if also in legacy map
      if (!instances.has(name)) {
        result.push({
          address: '', // filled by server when listing
          instance: name,
          pid: reg.pid,
          registeredAt: reg.lastSeen,
          lastSeen: reg.lastSeen,
        });
      }
    }
  }
  return result;
}

export function prune(): void {
  for (const [name, entry] of instances) {
    if (!isAlive(entry.pid)) {
      log.info(`Pruned dead instance "${name}" (pid ${entry.pid})`);
      instances.delete(name);
    }
  }
}

export function deregister(instance: string, { pid }: DeregisterOptions = {}): boolean {
  const entry = instances.get(instance);
  if (!entry) return false;

  // If a PID is provided, only deregister if it matches the registered PID.
  if (pid != null && entry.pid !== pid) {
    log.info(`Refused deregister "${instance}": caller pid ${pid} != registered pid ${entry.pid}`);
    return false;
  }

  // If no PID provided (legacy callers), refuse to deregister if the
  // registered process is still alive AND is a Claude Code process.
  if (pid == null && isClaudeCodeProcess(entry.pid)) {
    log.info(`Refused deregister "${instance}": registered pid ${entry.pid} is a live Claude Code process`);
    return false;
  }

  instances.delete(instance);
  log.info(`Deregistered instance "${instance}" (pid ${entry.pid})`);
  return true;
}

export function reset(): void {
  instances.clear();
  // Clear all session timers
  for (const reg of sessions.values()) {
    clearTimers(reg);
  }
  sessions.clear();
}

// ── Session-based registration (state machine) ──────────────────

export interface SessionRegisterInput {
  instance: string;
  pid?: number;
  force?: boolean;
  name?: string; // alternate instance name
}

export interface SessionRegisterResult {
  status: 'active' | 'deferred';
  sessionToken?: string;
  currentState?: RegistrationState;
  message?: string;
}

/**
 * Register an instance with a session token.
 * Returns { status: 'active', sessionToken } on success.
 * Returns { status: 'deferred', currentState, message } if instance is occupied.
 */
export function sessionRegister(input: SessionRegisterInput): SessionRegisterResult {
  const instanceName = input.name || input.instance;
  const pid = input.pid || 0;
  const existing = sessions.get(instanceName);

  if (existing && !input.force) {
    if (existing.state === 'ACTIVE' || existing.state === 'GRACE') {
      return {
        status: 'deferred',
        currentState: existing.state,
        message: `Instance "${instanceName}" is ${existing.state}. Use force to take over, or choose a different name.`,
      };
    }
    // PURGATORY — yield to new session
  }

  // Evict existing if present
  if (existing) {
    clearTimers(existing);
    log.info(`Evicted session for "${instanceName}" (state: ${existing.state})`);
  }

  const sessionToken = generateToken();
  const now = new Date().toISOString();

  sessions.set(instanceName, {
    sessionToken,
    pid,
    state: 'ACTIVE',
    lastSeen: now,
    snoozed: false,
  });

  // Also register in legacy map for backward compatibility with list()
  // The address will be empty here — server fills it in
  log.info(`Session registered "${instanceName}" (pid ${pid}, token ${sessionToken.slice(0, 8)}...)`);

  return { status: 'active', sessionToken };
}

/**
 * Called when a watcher disconnects. Transitions ACTIVE → GRACE.
 */
export function onWatcherDisconnect(sessionToken: string): void {
  const [name, reg] = findByToken(sessionToken);
  if (!reg || !name) return;
  if (reg.state !== 'ACTIVE') return;

  reg.state = 'GRACE';
  log.info(`Instance "${name}" → GRACE (watcher disconnected)`);

  // PID shortcut: if PID is set and dead, skip straight to PURGATORY
  if (reg.pid > 0 && !isAlive(reg.pid)) {
    log.info(`Instance "${name}" PID ${reg.pid} is dead — skipping GRACE`);
    transitionToPurgatory(name, reg);
    return;
  }

  reg.graceTimer = setTimeout(() => {
    transitionToPurgatory(name, reg);
  }, GRACE_TIMEOUT_MS);
  reg.graceTimer.unref();
}

/**
 * Update heartbeat for a session.
 */
export function sessionHeartbeat(sessionToken: string): boolean {
  const [, reg] = findByToken(sessionToken);
  if (!reg) return false;
  reg.lastSeen = new Date().toISOString();
  return true;
}

/**
 * Deregister by session token (explicit cleanup).
 */
export function sessionDeregister(sessionToken: string): boolean {
  const [name, reg] = findByToken(sessionToken);
  if (!reg || !name) return false;
  clearTimers(reg);
  sessions.delete(name);
  log.info(`Session deregistered "${name}"`);
  return true;
}

/**
 * Snooze: eagerly deregister and set snoozed flag.
 */
export function sessionSnooze(sessionToken: string): boolean {
  const [name, reg] = findByToken(sessionToken);
  if (!reg || !name) return false;
  clearTimers(reg);
  reg.state = 'UNREGISTERED';
  reg.snoozed = true;
  sessions.delete(name);
  log.info(`Session snoozed "${name}"`);
  return true;
}

/**
 * Get session registration state for an instance.
 */
export function getSessionState(instance: string): SessionRegistration | null {
  return sessions.get(instance) || null;
}

/**
 * Re-register after watcher reconnection (e.g., auto-relaunch).
 * Only succeeds if the sessionToken still matches.
 */
export function sessionReconnect(sessionToken: string): boolean {
  const [name, reg] = findByToken(sessionToken);
  if (!reg || !name) return false;

  clearTimers(reg);
  reg.state = 'ACTIVE';
  reg.lastSeen = new Date().toISOString();
  log.info(`Session reconnected "${name}" (was ${reg.state})`);
  return true;
}

// ── Internal helpers ─────────────────────────────────────────────

function clearTimers(reg: SessionRegistration): void {
  if (reg.graceTimer) { clearTimeout(reg.graceTimer); reg.graceTimer = undefined; }
  if (reg.purgatoryTimer) { clearTimeout(reg.purgatoryTimer); reg.purgatoryTimer = undefined; }
}

function transitionToPurgatory(name: string, reg: SessionRegistration): void {
  clearTimers(reg);
  reg.state = 'PURGATORY';
  log.info(`Instance "${name}" → PURGATORY`);

  reg.purgatoryTimer = setTimeout(() => {
    reg.state = 'UNREGISTERED';
    sessions.delete(name);
    log.info(`Instance "${name}" → UNREGISTERED (purgatory expired)`);
  }, PURGATORY_TIMEOUT_MS);
  reg.purgatoryTimer.unref();
}

function findByToken(token: string): [string | null, SessionRegistration | null] {
  for (const [name, reg] of sessions) {
    if (reg.sessionToken === token) return [name, reg];
  }
  return [null, null];
}

function generateToken(): string {
  const bytes = new Uint8Array(32);
  globalThis.crypto.getRandomValues(bytes);
  return Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('');
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM = process exists but owned by different user — still alive
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

function isClaudeCodeProcess(pid: number): boolean {
  if (!isAlive(pid)) return false;
  try {
    const comm = readFileSync(`/proc/${pid}/comm`, 'utf-8').trim();
    if (comm === 'claude') return true;
    if (comm === 'node') {
      const cmdline = readFileSync(`/proc/${pid}/cmdline`, 'utf-8');
      return cmdline.includes('icc-mcp');
    }
    return false;
  } catch {
    // /proc unavailable (non-Linux) — fall back to alive-only check
    return true;
  }
}

/**
 * Instance registry — ephemeral, in-memory tracking of live ICC instances on this host.
 *
 * Uses PID-based liveness (process.kill(pid, 0)) instead of heartbeats.
 * Dead instances are pruned on every list() call.
 */

import { readFileSync } from 'node:fs';
import { createLogger } from './util/logger.ts';
import type { RegistryEntry } from './types.ts';

const log = createLogger('registry');

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
  return [...instances.values()];
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

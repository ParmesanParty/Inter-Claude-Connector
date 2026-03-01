/**
 * Instance name index — persistent mapping of instance names to project paths.
 *
 * Stored at ~/.icc/instances.json. Same project path always gets the same name.
 * Collisions with different paths get a numeric suffix (-2, -3, ...).
 * Index only grows — stale entries are harmless.
 */

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { basename, join } from 'node:path';
import { homedir } from 'node:os';
import type { InstanceEntry } from './types.ts';

let indexPath = join(homedir(), '.icc', 'instances.json');

export function sanitize(name: string): string {
  let s = String(name).toLowerCase();
  s = s.replace(/[^a-z0-9_-]/g, '-');
  s = s.replace(/-+/g, '-');
  s = s.replace(/^-+|-+$/g, '');
  s = s.slice(0, 32);
  s = s.replace(/^-+|-+$/g, '');
  return s || 'default';
}

export function loadIndex(): Record<string, string> {
  try {
    return JSON.parse(readFileSync(indexPath, 'utf-8'));
  } catch {
    return {};
  }
}

export function saveIndex(index: Record<string, string>): void {
  mkdirSync(join(indexPath, '..'), { recursive: true });
  writeFileSync(indexPath, JSON.stringify(index, null, 2) + '\n');
}

export function resolve(dir: string): string {
  const index = loadIndex();

  // Check for existing entry by path
  for (const [name, path] of Object.entries(index)) {
    if (path === dir) return name;
  }

  // Derive candidate from directory basename
  const candidate = sanitize(basename(dir));

  // Find an available name (handle collisions)
  let name = candidate;
  let suffix = 2;
  while (name in index && index[name] !== dir) {
    name = `${candidate}-${suffix}`.slice(0, 32);
    suffix++;
  }

  index[name] = dir;
  saveIndex(index);
  return name;
}

export function listAll(): InstanceEntry[] {
  const index = loadIndex();
  return Object.entries(index).map(([name, path]) => ({ name, path }));
}

export function reset(dir: string): void {
  indexPath = join(dir, 'instances.json');
}

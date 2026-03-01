import { appendFileSync, readFileSync, writeFileSync, renameSync, mkdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { createLogger } from './util/logger.ts';
import type { Message } from './types.ts';

const log = createLogger('log');
const MAX_MEMORY = 1000;
const ROTATE_SIZE = 5_242_880; // 5MB — rotate when log exceeds this

let logDir = process.env.ICC_LOG_DIR || join(homedir(), '.icc');
let logPath = join(logDir, 'messages.jsonl');

type LogSubscriber = (message: Message) => void;

const messages: Message[] = [];
const subscribers = new Set<LogSubscriber>();

function rotateIfNeeded(): void {
  try {
    const stat = statSync(logPath);
    if (stat.size >= ROTATE_SIZE) {
      const ts = new Date().toISOString().replace(/[:.]/g, '-');
      const archivePath = join(logDir, `messages-${ts}.jsonl`);
      renameSync(logPath, archivePath);
      log.info(`Rotated log to ${archivePath}`);
    }
  } catch {
    // File doesn't exist yet — nothing to rotate
  }
}

export function init(): void {
  mkdirSync(logDir, { recursive: true });
  try {
    const raw = readFileSync(logPath, 'utf-8').trim();
    if (!raw) return;
    const lines = raw.split('\n');
    const recent = lines.slice(-MAX_MEMORY);
    for (const line of recent) {
      try {
        messages.push(JSON.parse(line));
      } catch {
        // skip malformed lines
      }
    }
    log.info(`Loaded ${messages.length} messages from disk`);
  } catch {
    // No existing log file — that's fine
  }
}

export function record(message: Message): void {
  messages.push(message);
  if (messages.length > MAX_MEMORY) {
    messages.shift();
  }
  // Persist to disk (rotate if file is large)
  try {
    rotateIfNeeded();
    appendFileSync(logPath, JSON.stringify(message) + '\n');
  } catch (err) {
    log.error(`Failed to persist message: ${(err as Error).message}`);
  }
  // Notify SSE subscribers
  for (const callback of subscribers) {
    try {
      callback(message);
    } catch {
      subscribers.delete(callback);
    }
  }
}

export function getAll(): Message[] {
  return [...messages];
}

export function subscribe(callback: LogSubscriber): () => void {
  subscribers.add(callback);
  return () => subscribers.delete(callback);
}

export function remove(ids: string[]): number {
  const idSet = new Set(ids);
  let count = 0;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (idSet.has(messages[i]!.id)) {
      messages.splice(i, 1);
      count++;
    }
  }
  if (count > 0) rewrite();
  return count;
}

function rewrite(): void {
  try {
    const data = messages.map(m => JSON.stringify(m)).join('\n') + (messages.length ? '\n' : '');
    writeFileSync(logPath, data);
  } catch (err) {
    log.error(`Failed to rewrite log: ${(err as Error).message}`);
  }
}

export function getLogPath(): string {
  return logPath;
}

export function reset(newLogDir?: string): void {
  messages.length = 0;
  subscribers.clear();
  if (newLogDir) {
    logDir = newLogDir;
    logPath = join(logDir, 'messages.jsonl');
  }
}

import { appendFileSync, writeFileSync, mkdirSync, unlinkSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { createLogger } from './util/logger.ts';
import { parseAddress, addressMatches } from './address.ts';
import type { InboxMessage, InboxMessageStatus, MessageMeta } from './types.ts';
import {
  openInboxDb, closeInboxDb, isDbOpen, migrateFromJsonl,
  dbInsert, dbGetAll, dbGetUnread, dbGetById, dbGetByIds,
  dbMarkRead, dbMarkAllRead, dbRemove, dbUpdateTimestamp,
  dbGetReadOlderThan, dbGetUnreadOlderThan, dbGetReceiptsOlderThan,
} from './inbox-db.ts';

const log = createLogger('inbox');

let inboxDir = process.env.ICC_INBOX_DIR || join(homedir(), '.icc');
let signalPath = join(inboxDir, 'unread');

const subscribers = new Set<(message: InboxMessage) => void>();
let notifyFn: ((message: InboxMessage) => void) | null = null;
let receiptSenderFn: ((message: InboxMessage, readerAddress: string) => void) | null = null;

export function isReceipt(m: InboxMessage): boolean {
  return m._meta?.type === 'read-receipt';
}

export function init(): void {
  mkdirSync(inboxDir, { recursive: true });
  openInboxDb(inboxDir);
  // One-time migration from JSONL
  const jsonlPath = join(inboxDir, 'inbox.jsonl');
  const migrated = migrateFromJsonl(jsonlPath);
  if (migrated > 0) log.info(`Migrated ${migrated} messages from JSONL to SQLite`);
  const total = dbGetAll().length;
  if (total > 0) log.info(`Loaded ${total} inbox messages from database`);
  updateSignalFile();
}

export function setNotifier(fn: ((message: InboxMessage) => void) | null): void {
  notifyFn = fn;
}

export function setReceiptSender(fn: ((message: InboxMessage, readerAddress: string) => void) | null): void {
  receiptSenderFn = fn;
}

interface InboxPushInput {
  from: string;
  to?: string;
  body: string;
  replyTo?: string | null;
  threadId?: string | null;
  status?: InboxMessageStatus | null;
  _meta?: MessageMeta | null;
}

interface PushOptions {
  silent?: boolean;
}

export function push(message: InboxPushInput, { silent = false }: PushOptions = {}): InboxMessage {
  const full: InboxMessage = {
    id: randomUUID(),
    from: message.from,
    to: message.to ?? '',
    timestamp: new Date().toISOString(),
    body: message.body,
    replyTo: message.replyTo || null,
    threadId: message.threadId ?? null,
    status: message.status ?? null,
    _meta: message._meta || null,
    read: false,
  };
  dbInsert(full);
  // Reactive setter: syncs timestamp mutations back to DB.
  // Only exists on objects returned by push(), NOT on objects from getAll()/getById().
  // Needed because purgeStale tests backdate timestamps via direct assignment.
  let _ts = full.timestamp;
  Object.defineProperty(full, 'timestamp', {
    get() { return _ts; },
    set(v: string) { _ts = v; dbUpdateTimestamp(full.id, v); },
    enumerable: true,
    configurable: true,
  });
  if (!silent) {
    updateSignalFile();
    if (notifyFn) {
      try { notifyFn(full); } catch (err) {
        log.error(`Notification failed: ${(err as Error).message}`);
      }
    }
  }
  for (const callback of subscribers) {
    try {
      callback(full);
    } catch {
      subscribers.delete(callback);
    }
  }
  return full;
}

interface GetOptions {
  from?: string;
  forAddress?: string;
  serverIdentity?: string;
}

export function getUnread({ from, forAddress, serverIdentity }: GetOptions = {}): InboxMessage[] {
  if (!isDbOpen()) return [];
  const msgs = dbGetUnread(from ? { from } : {});
  if (forAddress && serverIdentity) {
    return msgs.filter(m => addressMatches(m.to, forAddress, serverIdentity));
  }
  return msgs;
}

export function getAll({ forAddress, serverIdentity }: GetOptions = {}): InboxMessage[] {
  if (!isDbOpen()) return [];
  const msgs = dbGetAll();
  if (forAddress && serverIdentity) {
    return msgs.filter(m => addressMatches(m.to, forAddress, serverIdentity));
  }
  return msgs;
}

export function markRead(ids: string[], readerAddress?: string): number {
  const beforeMsgs = dbGetByIds(ids).filter(m => !m.read);
  const count = dbMarkRead(ids);
  if (count > 0) {
    updateSignalFile();
    sendReceipts(beforeMsgs, readerAddress);
  }
  return count;
}

interface MarkAllReadOptions {
  forAddress?: string;
  serverIdentity?: string;
  readerAddress?: string;
}

export function markAllRead({ forAddress, serverIdentity, readerAddress }: MarkAllReadOptions = {}): number {
  let count: number;
  let newlyRead: InboxMessage[];
  if (forAddress && serverIdentity) {
    const matching = getUnread({ forAddress, serverIdentity });
    newlyRead = matching;
    const ids = matching.map(m => m.id);
    count = dbMarkRead(ids);
  } else {
    newlyRead = dbGetUnread();
    count = dbMarkAllRead();
  }
  if (count > 0) {
    updateSignalFile();
    sendReceipts(newlyRead, readerAddress);
  }
  return count;
}

export function getById(id: string): InboxMessage | null {
  if (!isDbOpen()) return null;
  return dbGetById(id);
}

export function remove(ids: string[]): number {
  const count = dbRemove(ids);
  if (count > 0) {
    updateSignalFile();
  }
  return count;
}

export function purgeStale(maxAgeDays = 7): number {
  const now = Date.now();
  const staleCutoff = now - maxAgeDays * 24 * 60 * 60 * 1000;
  const archiveCutoff = now - 1 * 24 * 60 * 60 * 1000;

  const toArchive = dbGetReadOlderThan(archiveCutoff).filter(m => !isReceipt(m));
  if (toArchive.length > 0) {
    appendToArchive(toArchive);
  }

  const removeIds = new Set<string>();
  for (const m of toArchive) removeIds.add(m.id);
  for (const m of dbGetUnreadOlderThan(staleCutoff)) removeIds.add(m.id);
  for (const m of dbGetReceiptsOlderThan(archiveCutoff)) removeIds.add(m.id);

  if (removeIds.size === 0) return 0;
  const count = dbRemove([...removeIds]);
  if (count > 0) updateSignalFile();
  log.info(`Purged ${count} message(s): archived ${toArchive.length}, removed rest`);
  return count;
}

function appendToArchive(msgs: InboxMessage[]): void {
  const archiveDir = join(inboxDir, 'archive');
  mkdirSync(archiveDir, { recursive: true });
  const month = new Date().toISOString().slice(0, 7); // YYYY-MM
  const archivePath = join(archiveDir, `inbox-${month}.jsonl`);
  const data = msgs.map(m => JSON.stringify(m)).join('\n') + '\n';
  appendFileSync(archivePath, data);
}

export function subscribe(callback: (msg: InboxMessage) => void): () => void {
  subscribers.add(callback);
  return () => subscribers.delete(callback);
}

export function getInboxPath(): string {
  return join(inboxDir, 'inbox.db');
}

export function getInboxDir(): string {
  return inboxDir;
}

export function getSignalPath(instance?: string): string {
  if (instance) return join(inboxDir, `unread.${instance}`);
  return signalPath;
}

export function reset(newDir?: string): void {
  closeInboxDb();
  subscribers.clear();
  notifyFn = null;
  receiptSenderFn = null;
  if (newDir) {
    cleanupSignalFiles();
    inboxDir = newDir;
    signalPath = join(inboxDir, 'unread');
  }
}

function sendReceipts(newlyReadMessages: InboxMessage[], readerAddress?: string): void {
  if (!receiptSenderFn) return;
  for (const m of newlyReadMessages) {
    if (isReceipt(m)) continue; // loop prevention
    try {
      receiptSenderFn(m, readerAddress ?? '');
    } catch (err) {
      log.error(`Failed to send read receipt for ${m.id}: ${(err as Error).message}`);
    }
  }
}

function cleanupSignalFiles(): void {
  try {
    try { unlinkSync(signalPath); } catch { /* already gone */ }
    const files = readdirSync(inboxDir);
    for (const f of files) {
      if (f.startsWith('unread.')) {
        try { unlinkSync(join(inboxDir, f)); } catch { /* already gone */ }
      }
    }
  } catch {
    // Directory may not exist yet
  }
}

function writeSignalContent(path: string, unread: InboxMessage[]): void {
  const senders = [...new Set(unread.map(m => m.from))];
  const latest = unread[unread.length - 1]!;
  const preview = latest.body.length > 80
    ? latest.body.slice(0, 77) + '...'
    : latest.body;
  const lines = [
    `You have ${unread.length} unread ICC message${unread.length === 1 ? '' : 's'}. Run check_messages to read them.`,
    `From: ${senders.join(', ')} | Latest: ${latest.timestamp}`,
    `Preview: ${preview}`,
  ];
  if (latest.status) {
    lines.push(`Status: ${latest.status}`);
  }
  writeFileSync(path, lines.join('\n') + '\n');
}

function updateSignalFile(): void {
  if (!isDbOpen()) return;
  const allUnread = dbGetUnread();
  const unread = allUnread.filter(m => !isReceipt(m));

  try {
    const instanceUnread = new Map<string, InboxMessage[]>();
    const broadcastUnread: InboxMessage[] = [];

    for (const m of unread) {
      const { instance } = parseAddress(m.to);
      if (instance) {
        if (!instanceUnread.has(instance)) instanceUnread.set(instance, []);
        instanceUnread.get(instance)!.push(m);
      } else {
        broadcastUnread.push(m);
      }
    }

    let existingFiles: string[] = [];
    try {
      existingFiles = readdirSync(inboxDir).filter(f => f.startsWith('unread.'));
    } catch { /* dir may not exist */ }

    const activeInstances = new Set(instanceUnread.keys());

    for (const f of existingFiles) {
      const inst = f.slice('unread.'.length);
      if (!activeInstances.has(inst)) {
        if (broadcastUnread.length === 0) {
          try { unlinkSync(join(inboxDir, f)); } catch { /* already gone */ }
        }
      }
    }

    for (const [instance, msgs] of instanceUnread) {
      const allForInstance = [...broadcastUnread, ...msgs];
      writeSignalContent(join(inboxDir, `unread.${instance}`), allForInstance);
    }

    for (const f of existingFiles) {
      const inst = f.slice('unread.'.length);
      if (!activeInstances.has(inst) && broadcastUnread.length > 0) {
        writeSignalContent(join(inboxDir, f), broadcastUnread);
      }
    }

    for (const f of existingFiles) {
      const inst = f.slice('unread.'.length);
      if (!activeInstances.has(inst) && broadcastUnread.length === 0) {
        try { unlinkSync(join(inboxDir, f)); } catch { /* already gone */ }
      }
    }

    if (broadcastUnread.length === 0 && unread.length === 0) {
      try { unlinkSync(signalPath); } catch { /* already gone */ }
    } else if (broadcastUnread.length > 0) {
      writeSignalContent(signalPath, broadcastUnread);
    } else {
      try { unlinkSync(signalPath); } catch { /* already gone */ }
    }
  } catch (err) {
    log.error(`Failed to update signal file: ${(err as Error).message}`);
  }
}

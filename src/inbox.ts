import { appendFileSync, readFileSync, writeFileSync, mkdirSync, unlinkSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { createLogger } from './util/logger.ts';
import { parseAddress, addressMatches } from './address.ts';
import type { InboxMessage, MessageMeta } from './types.ts';

const log = createLogger('inbox');

let inboxDir = process.env.ICC_INBOX_DIR || join(homedir(), '.icc');
let inboxPath = join(inboxDir, 'inbox.jsonl');
let signalPath = join(inboxDir, 'unread');

const messages: InboxMessage[] = [];
const subscribers = new Set<(message: InboxMessage) => void>();
let notifyFn: ((message: InboxMessage) => void) | null = null;
let receiptSenderFn: ((message: InboxMessage, readerAddress: string) => void) | null = null;

export function isReceipt(m: InboxMessage): boolean {
  return m._meta?.type === 'read-receipt';
}

export function init(): void {
  mkdirSync(inboxDir, { recursive: true });
  try {
    const raw = readFileSync(inboxPath, 'utf-8').trim();
    if (!raw) return;
    for (const line of raw.split('\n')) {
      try {
        const msg = JSON.parse(line);
        msg.threadId = msg.threadId ?? null;
        messages.push(msg);
      } catch {
        // skip malformed lines
      }
    }
    log.info(`Loaded ${messages.length} inbox messages from disk`);
  } catch {
    // No existing inbox file — that's fine
  }
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
    _meta: message._meta || null,
    read: false,
  };
  messages.push(full);
  try {
    appendFileSync(inboxPath, JSON.stringify(full) + '\n');
  } catch (err) {
    log.error(`Failed to persist inbox message: ${(err as Error).message}`);
  }
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
  return messages.filter(m => {
    if (m.read) return false;
    if (from && m.from !== from) return false;
    if (forAddress && serverIdentity) {
      if (!addressMatches(m.to, forAddress, serverIdentity)) return false;
    }
    return true;
  });
}

export function getAll({ forAddress, serverIdentity }: GetOptions = {}): InboxMessage[] {
  if (forAddress && serverIdentity) {
    return messages.filter(m => addressMatches(m.to, forAddress, serverIdentity));
  }
  return [...messages];
}

export function markRead(ids: string[], readerAddress?: string): number {
  let count = 0;
  const newlyRead: InboxMessage[] = [];
  for (const m of messages) {
    if (ids.includes(m.id) && !m.read) {
      m.read = true;
      count++;
      newlyRead.push(m);
    }
  }
  if (count > 0) {
    rewrite();
    updateSignalFile();
    sendReceipts(newlyRead, readerAddress);
  }
  return count;
}

interface MarkAllReadOptions {
  forAddress?: string;
  serverIdentity?: string;
  readerAddress?: string;
}

export function markAllRead({ forAddress, serverIdentity, readerAddress }: MarkAllReadOptions = {}): number {
  let count = 0;
  const newlyRead: InboxMessage[] = [];
  for (const m of messages) {
    if (!m.read) {
      if (forAddress && serverIdentity) {
        if (!addressMatches(m.to, forAddress, serverIdentity)) continue;
      }
      m.read = true;
      count++;
      newlyRead.push(m);
    }
  }
  if (count > 0) {
    rewrite();
    updateSignalFile();
    sendReceipts(newlyRead, readerAddress);
  }
  return count;
}

export function getById(id: string): InboxMessage | null {
  return messages.find(m => m.id === id) || null;
}

export function remove(ids: string[]): number {
  let count = 0;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (ids.includes(messages[i]!.id)) {
      messages.splice(i, 1);
      count++;
    }
  }
  if (count > 0) {
    rewrite();
    updateSignalFile();
  }
  return count;
}

export function purgeStale(maxAgeDays = 7): number {
  const now = Date.now();
  const staleCutoff = now - maxAgeDays * 24 * 60 * 60 * 1000;
  const archiveCutoff = now - 1 * 24 * 60 * 60 * 1000;

  const toArchive = messages.filter(m =>
    m.read && !isReceipt(m) && new Date(m.timestamp).getTime() < archiveCutoff
  );
  if (toArchive.length > 0) {
    appendToArchive(toArchive);
  }

  const removeIds = new Set<string>();
  for (const m of toArchive) removeIds.add(m.id);
  for (const m of messages) {
    if (!m.read && new Date(m.timestamp).getTime() < staleCutoff) removeIds.add(m.id);
    if (isReceipt(m) && new Date(m.timestamp).getTime() < archiveCutoff) removeIds.add(m.id);
  }

  if (removeIds.size === 0) return 0;
  const count = remove([...removeIds]);
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
  return inboxPath;
}

export function getInboxDir(): string {
  return inboxDir;
}

export function getSignalPath(instance?: string): string {
  if (instance) return join(inboxDir, `unread.${instance}`);
  return signalPath;
}

export function reset(newDir?: string): void {
  messages.length = 0;
  subscribers.clear();
  notifyFn = null;
  receiptSenderFn = null;
  if (newDir) {
    cleanupSignalFiles();
    inboxDir = newDir;
    inboxPath = join(inboxDir, 'inbox.jsonl');
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

function rewrite(): void {
  try {
    const data = messages.map(m => JSON.stringify(m)).join('\n') + (messages.length ? '\n' : '');
    writeFileSync(inboxPath, data);
  } catch (err) {
    log.error(`Failed to rewrite inbox: ${(err as Error).message}`);
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
  writeFileSync(path, lines.join('\n') + '\n');
}

function updateSignalFile(): void {
  const unread = messages.filter(m => !m.read && !isReceipt(m));

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

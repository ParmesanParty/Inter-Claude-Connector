import Database from 'better-sqlite3';
import type BetterSqlite3 from 'better-sqlite3';
import { join } from 'node:path';
import { readFileSync, renameSync } from 'node:fs';
import { createLogger } from './util/logger.ts';
import type { InboxMessage, InboxMessageStatus, MessageMeta } from './types.ts';

const log = createLogger('inbox-db');

// ── DB lifecycle ────────────────────────────────────────────────────

let db: BetterSqlite3.Database | null = null;

export function openInboxDb(dir: string): BetterSqlite3.Database {
  const dbPath = join(dir, 'inbox.db');
  db = new Database(dbPath);

  db.pragma('journal_mode = WAL');
  db.pragma('synchronous = NORMAL');
  db.pragma('foreign_keys = ON');

  db.exec(`
    CREATE TABLE IF NOT EXISTS messages (
      id         TEXT PRIMARY KEY,
      from_addr  TEXT NOT NULL,
      to_addr    TEXT NOT NULL DEFAULT '',
      timestamp  TEXT NOT NULL,
      body       TEXT NOT NULL,
      replyTo    TEXT,
      threadId   TEXT,
      status     TEXT,
      meta_json  TEXT,
      read       INTEGER NOT NULL DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS idx_messages_read     ON messages(read);
    CREATE INDEX IF NOT EXISTS idx_messages_to       ON messages(to_addr);
    CREATE INDEX IF NOT EXISTS idx_messages_from     ON messages(from_addr);
    CREATE INDEX IF NOT EXISTS idx_messages_threadId ON messages(threadId);
  `);

  return db;
}

export function isDbOpen(): boolean {
  return db !== null;
}

export function getDb(): BetterSqlite3.Database {
  if (!db) throw new Error('Inbox DB not open — call openInboxDb() first');
  return db;
}

export function closeInboxDb(): void {
  if (db) {
    db.close();
    db = null;
  }
}

// ── Row mapping ─────────────────────────────────────────────────────

interface MessageRow {
  id: string;
  from_addr: string;
  to_addr: string;
  timestamp: string;
  body: string;
  replyTo: string | null;
  threadId: string | null;
  status: string | null;
  meta_json: string | null;
  read: number;
}

function rowToMessage(row: MessageRow): InboxMessage {
  return {
    id: row.id,
    from: row.from_addr,
    to: row.to_addr,
    timestamp: row.timestamp,
    body: row.body,
    replyTo: row.replyTo,
    threadId: row.threadId,
    status: row.status as InboxMessageStatus | null,
    _meta: row.meta_json ? JSON.parse(row.meta_json) as MessageMeta : null,
    read: row.read === 1,
  };
}

// ── CRUD ────────────────────────────────────────────────────────────

export function dbInsert(msg: InboxMessage): void {
  const d = getDb();
  const stmt = d.prepare(`
    INSERT INTO messages (id, from_addr, to_addr, timestamp, body, replyTo, threadId, status, meta_json, read)
    VALUES (@id, @from_addr, @to_addr, @timestamp, @body, @replyTo, @threadId, @status, @meta_json, @read)
  `);
  stmt.run({
    id: msg.id,
    from_addr: msg.from,
    to_addr: msg.to,
    timestamp: msg.timestamp,
    body: msg.body,
    replyTo: msg.replyTo,
    threadId: msg.threadId,
    status: msg.status,
    meta_json: msg._meta ? JSON.stringify(msg._meta) : null,
    read: msg.read ? 1 : 0,
  });
}

export function dbGetAll(): InboxMessage[] {
  const d = getDb();
  const rows = d.prepare('SELECT * FROM messages ORDER BY timestamp ASC').all() as MessageRow[];
  return rows.map(rowToMessage);
}

export function dbGetUnread(opts?: { from?: string }): InboxMessage[] {
  const d = getDb();
  if (opts?.from) {
    const rows = d.prepare('SELECT * FROM messages WHERE read = 0 AND from_addr = ? ORDER BY timestamp ASC').all(opts.from) as MessageRow[];
    return rows.map(rowToMessage);
  }
  const rows = d.prepare('SELECT * FROM messages WHERE read = 0 ORDER BY timestamp ASC').all() as MessageRow[];
  return rows.map(rowToMessage);
}

export function dbGetById(id: string): InboxMessage | null {
  const d = getDb();
  const row = d.prepare('SELECT * FROM messages WHERE id = ?').get(id) as MessageRow | undefined;
  return row ? rowToMessage(row) : null;
}

export function dbGetByIds(ids: string[]): InboxMessage[] {
  if (ids.length === 0) return [];
  const d = getDb();
  const placeholders = ids.map(() => '?').join(', ');
  const rows = d.prepare(`SELECT * FROM messages WHERE id IN (${placeholders}) ORDER BY timestamp ASC`).all(...ids) as MessageRow[];
  return rows.map(rowToMessage);
}

export function dbMarkRead(ids: string[]): number {
  if (ids.length === 0) return 0;
  const d = getDb();
  const placeholders = ids.map(() => '?').join(', ');
  const result = d.prepare(`UPDATE messages SET read = 1 WHERE id IN (${placeholders}) AND read = 0`).run(...ids);
  return result.changes;
}

export function dbMarkAllRead(): number {
  const d = getDb();
  const result = d.prepare('UPDATE messages SET read = 1 WHERE read = 0').run();
  return result.changes;
}

export function dbUpdateTimestamp(id: string, timestamp: string): void {
  const d = getDb();
  d.prepare('UPDATE messages SET timestamp = ? WHERE id = ?').run(timestamp, id);
}

export function dbRemove(ids: string[]): number {
  if (ids.length === 0) return 0;
  const d = getDb();
  const placeholders = ids.map(() => '?').join(', ');
  const result = d.prepare(`DELETE FROM messages WHERE id IN (${placeholders})`).run(...ids);
  return result.changes;
}

export function dbGetReadOlderThan(cutoffMs: number): InboxMessage[] {
  const d = getDb();
  const cutoffISO = new Date(cutoffMs).toISOString();
  const rows = d.prepare('SELECT * FROM messages WHERE read = 1 AND timestamp < ? ORDER BY timestamp ASC').all(cutoffISO) as MessageRow[];
  return rows.map(rowToMessage);
}

export function dbGetUnreadOlderThan(cutoffMs: number): InboxMessage[] {
  const d = getDb();
  const cutoffISO = new Date(cutoffMs).toISOString();
  const rows = d.prepare('SELECT * FROM messages WHERE read = 0 AND timestamp < ? ORDER BY timestamp ASC').all(cutoffISO) as MessageRow[];
  return rows.map(rowToMessage);
}

export function dbGetReceiptsOlderThan(cutoffMs: number): InboxMessage[] {
  const d = getDb();
  const cutoffISO = new Date(cutoffMs).toISOString();
  const rows = d.prepare(`SELECT * FROM messages WHERE json_extract(meta_json, '$.type') = 'read-receipt' AND timestamp < ? ORDER BY timestamp ASC`).all(cutoffISO) as MessageRow[];
  return rows.map(rowToMessage);
}

// ── JSONL migration ──────────────────────────────────────────────────

export function migrateFromJsonl(jsonlPath: string): number {
  let content: string;
  try {
    content = readFileSync(jsonlPath, 'utf-8');
  } catch {
    return 0;
  }

  const lines = content.split('\n').filter(l => l.trim() !== '');
  const messages: InboxMessage[] = [];

  for (const line of lines) {
    try {
      const parsed = JSON.parse(line);
      messages.push({
        id: parsed.id,
        from: parsed.from ?? '',
        to: parsed.to ?? '',
        timestamp: parsed.timestamp ?? new Date().toISOString(),
        body: parsed.body ?? '',
        replyTo: parsed.replyTo || null,
        threadId: parsed.threadId ?? null,
        status: parsed.status ?? null,
        _meta: parsed._meta || null,
        read: !!parsed.read,
      });
    } catch {
      log.warn('Skipping malformed JSONL line: %s', line);
    }
  }

  if (messages.length > 0) {
    const d = getDb();
    const stmt = d.prepare(`
      INSERT INTO messages (id, from_addr, to_addr, timestamp, body, replyTo, threadId, status, meta_json, read)
      VALUES (@id, @from_addr, @to_addr, @timestamp, @body, @replyTo, @threadId, @status, @meta_json, @read)
    `);
    const insertAll = d.transaction((msgs: InboxMessage[]) => {
      for (const msg of msgs) {
        stmt.run({
          id: msg.id,
          from_addr: msg.from,
          to_addr: msg.to,
          timestamp: msg.timestamp,
          body: msg.body,
          replyTo: msg.replyTo,
          threadId: msg.threadId,
          status: msg.status,
          meta_json: msg._meta ? JSON.stringify(msg._meta) : null,
          read: msg.read ? 1 : 0,
        });
      }
    });
    insertAll(messages);
  }

  renameSync(jsonlPath, `${jsonlPath}.migrated`);
  return messages.length;
}

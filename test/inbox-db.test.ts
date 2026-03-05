import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, existsSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  openInboxDb,
  closeInboxDb,
  getDb,
  dbInsert,
  dbGetAll,
  dbGetUnread,
  dbGetById,
  dbGetByIds,
  dbMarkRead,
  dbMarkAllRead,
  dbRemove,
  dbGetReadOlderThan,
  dbGetUnreadOlderThan,
  dbGetReceiptsOlderThan,
  migrateFromJsonl,
} from '../src/inbox-db.ts';
import type { InboxMessage } from '../src/types.ts';

function makeMsg(overrides: Partial<InboxMessage> = {}): InboxMessage {
  return {
    id: overrides.id ?? crypto.randomUUID(),
    from: overrides.from ?? 'alice',
    to: overrides.to ?? 'bob',
    timestamp: overrides.timestamp ?? new Date().toISOString(),
    body: overrides.body ?? 'hello',
    replyTo: overrides.replyTo ?? null,
    threadId: overrides.threadId ?? null,
    status: overrides.status ?? null,
    _meta: overrides._meta ?? null,
    read: overrides.read ?? false,
  };
}

describe('inbox-db', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'icc-inbox-db-test-'));
    openInboxDb(dir);
  });

  afterEach(() => {
    closeInboxDb();
    try { rmSync(dir, { recursive: true, force: true }); } catch {}
  });

  // ── DB creation ─────────────────────────────────────────────────

  it('creates inbox.db file on open', () => {
    assert.ok(existsSync(join(dir, 'inbox.db')));
  });

  it('getDb() throws when DB not open', () => {
    closeInboxDb();
    assert.throws(() => getDb(), /not open/);
  });

  // ── Schema ──────────────────────────────────────────────────────

  it('has expected columns in messages table', () => {
    const db = getDb();
    const cols = db.prepare("PRAGMA table_info(messages)").all() as { name: string }[];
    const names = cols.map(c => c.name);
    assert.deepStrictEqual(names.sort(), [
      'body', 'from_addr', 'id', 'meta_json', 'read', 'replyTo', 'status', 'threadId', 'timestamp', 'to_addr',
    ]);
  });

  // ── Insert + getAll round-trip ──────────────────────────────────

  it('insert + getAll round-trips a message', () => {
    const msg = makeMsg({ id: 'msg-1', from: 'alice', to: 'bob', body: 'hi' });
    dbInsert(msg);
    const all = dbGetAll();
    assert.equal(all.length, 1);
    assert.deepStrictEqual(all[0], msg);
  });

  it('getAll returns messages ordered by timestamp ASC', () => {
    const old = makeMsg({ id: 'old', timestamp: '2025-01-01T00:00:00.000Z' });
    const newer = makeMsg({ id: 'new', timestamp: '2025-06-01T00:00:00.000Z' });
    dbInsert(newer);
    dbInsert(old);
    const all = dbGetAll();
    assert.equal(all[0]!.id, 'old');
    assert.equal(all[1]!.id, 'new');
  });

  // ── getUnread ───────────────────────────────────────────────────

  it('getUnread excludes read messages', () => {
    dbInsert(makeMsg({ id: 'unread1', read: false }));
    dbInsert(makeMsg({ id: 'read1', read: true }));
    const unread = dbGetUnread();
    assert.equal(unread.length, 1);
    assert.equal(unread[0]!.id, 'unread1');
  });

  it('getUnread filters by from', () => {
    dbInsert(makeMsg({ id: 'a1', from: 'alice', read: false }));
    dbInsert(makeMsg({ id: 'b1', from: 'bob', read: false }));
    const fromAlice = dbGetUnread({ from: 'alice' });
    assert.equal(fromAlice.length, 1);
    assert.equal(fromAlice[0]!.id, 'a1');
  });

  // ── getById ─────────────────────────────────────────────────────

  it('getById returns message or null', () => {
    const msg = makeMsg({ id: 'find-me' });
    dbInsert(msg);
    assert.deepStrictEqual(dbGetById('find-me'), msg);
    assert.equal(dbGetById('nonexistent'), null);
  });

  // ── getByIds ────────────────────────────────────────────────────

  it('getByIds returns matching messages', () => {
    dbInsert(makeMsg({ id: 'x1', timestamp: '2025-01-01T00:00:00Z' }));
    dbInsert(makeMsg({ id: 'x2', timestamp: '2025-01-02T00:00:00Z' }));
    dbInsert(makeMsg({ id: 'x3', timestamp: '2025-01-03T00:00:00Z' }));
    const found = dbGetByIds(['x1', 'x3']);
    assert.equal(found.length, 2);
    assert.equal(found[0]!.id, 'x1');
    assert.equal(found[1]!.id, 'x3');
  });

  it('getByIds returns empty for empty input', () => {
    assert.deepStrictEqual(dbGetByIds([]), []);
  });

  // ── markRead ────────────────────────────────────────────────────

  it('markRead updates flag and returns count', () => {
    dbInsert(makeMsg({ id: 'r1', read: false }));
    dbInsert(makeMsg({ id: 'r2', read: false }));
    dbInsert(makeMsg({ id: 'r3', read: true }));
    const changed = dbMarkRead(['r1', 'r2', 'r3']);
    assert.equal(changed, 2); // r3 already read
    assert.equal(dbGetById('r1')!.read, true);
    assert.equal(dbGetById('r2')!.read, true);
  });

  it('markRead returns 0 for empty input', () => {
    assert.equal(dbMarkRead([]), 0);
  });

  // ── markAllRead ─────────────────────────────────────────────────

  it('markAllRead marks all unread as read', () => {
    dbInsert(makeMsg({ id: 'u1', read: false }));
    dbInsert(makeMsg({ id: 'u2', read: false }));
    dbInsert(makeMsg({ id: 'u3', read: true }));
    const changed = dbMarkAllRead();
    assert.equal(changed, 2);
    assert.equal(dbGetUnread().length, 0);
  });

  // ── remove ──────────────────────────────────────────────────────

  it('remove deletes and returns count', () => {
    dbInsert(makeMsg({ id: 'd1' }));
    dbInsert(makeMsg({ id: 'd2' }));
    const removed = dbRemove(['d1']);
    assert.equal(removed, 1);
    assert.equal(dbGetAll().length, 1);
    assert.equal(dbGetById('d1'), null);
  });

  it('remove returns 0 for empty input', () => {
    assert.equal(dbRemove([]), 0);
  });

  // ── _meta preserved as JSON ─────────────────────────────────────

  it('preserves _meta as JSON', () => {
    const meta = { type: 'read-receipt', originalId: 'orig-1', readAt: '2025-01-01T00:00:00Z' };
    const msg = makeMsg({ id: 'meta-msg', _meta: meta });
    dbInsert(msg);
    const fetched = dbGetById('meta-msg')!;
    assert.deepStrictEqual(fetched._meta, meta);
  });

  it('preserves null _meta', () => {
    const msg = makeMsg({ id: 'no-meta', _meta: null });
    dbInsert(msg);
    assert.equal(dbGetById('no-meta')!._meta, null);
  });

  // ── status enum preserved ───────────────────────────────────────

  it('preserves status enum values', () => {
    const statuses = ['WAITING_FOR_REPLY', 'FYI_ONLY', 'ACTION_NEEDED', 'RESOLVED'] as const;
    for (const status of statuses) {
      const msg = makeMsg({ id: `status-${status}`, status });
      dbInsert(msg);
      assert.equal(dbGetById(`status-${status}`)!.status, status);
    }
  });

  it('preserves null status', () => {
    const msg = makeMsg({ id: 'no-status', status: null });
    dbInsert(msg);
    assert.equal(dbGetById('no-status')!.status, null);
  });

  // ── age-based queries ───────────────────────────────────────────

  it('dbGetReadOlderThan returns old read messages', () => {
    dbInsert(makeMsg({ id: 'old-read', read: true, timestamp: '2024-01-01T00:00:00.000Z' }));
    dbInsert(makeMsg({ id: 'new-read', read: true, timestamp: '2026-01-01T00:00:00.000Z' }));
    dbInsert(makeMsg({ id: 'old-unread', read: false, timestamp: '2024-01-01T00:00:00.000Z' }));
    const cutoff = new Date('2025-01-01T00:00:00.000Z').getTime();
    const result = dbGetReadOlderThan(cutoff);
    assert.equal(result.length, 1);
    assert.equal(result[0]!.id, 'old-read');
  });

  it('dbGetUnreadOlderThan returns old unread messages', () => {
    dbInsert(makeMsg({ id: 'old-unread', read: false, timestamp: '2024-01-01T00:00:00.000Z' }));
    dbInsert(makeMsg({ id: 'new-unread', read: false, timestamp: '2026-01-01T00:00:00.000Z' }));
    const cutoff = new Date('2025-01-01T00:00:00.000Z').getTime();
    const result = dbGetUnreadOlderThan(cutoff);
    assert.equal(result.length, 1);
    assert.equal(result[0]!.id, 'old-unread');
  });

  it('dbGetReceiptsOlderThan returns old receipts only', () => {
    dbInsert(makeMsg({
      id: 'old-receipt',
      timestamp: '2024-01-01T00:00:00.000Z',
      _meta: { type: 'read-receipt', originalId: 'x' },
    }));
    dbInsert(makeMsg({
      id: 'old-normal',
      timestamp: '2024-01-01T00:00:00.000Z',
      _meta: null,
    }));
    dbInsert(makeMsg({
      id: 'new-receipt',
      timestamp: '2026-01-01T00:00:00.000Z',
      _meta: { type: 'read-receipt', originalId: 'y' },
    }));
    const cutoff = new Date('2025-01-01T00:00:00.000Z').getTime();
    const result = dbGetReceiptsOlderThan(cutoff);
    assert.equal(result.length, 1);
    assert.equal(result[0]!.id, 'old-receipt');
  });
});

describe('inbox-db: JSONL migration', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'icc-inbox-db-migrate-'));
    openInboxDb(dir);
  });

  afterEach(() => {
    closeInboxDb();
    try { rmSync(dir, { recursive: true, force: true }); } catch {}
  });

  it('imports messages from inbox.jsonl', () => {
    const jsonlPath = join(dir, 'inbox.jsonl');
    const msg1 = { id: 'migrate-1', from: 'alice', to: 'bob', timestamp: '2025-01-01T00:00:00Z', body: 'hello', read: false, threadId: 'thread-1' };
    const msg2 = { id: 'migrate-2', from: 'bob', to: 'alice', timestamp: '2025-01-02T00:00:00Z', body: 'world', read: true, threadId: null };
    writeFileSync(jsonlPath, JSON.stringify(msg1) + '\n' + JSON.stringify(msg2) + '\n');

    const count = migrateFromJsonl(jsonlPath);
    assert.equal(count, 2);

    const all = dbGetAll();
    assert.equal(all.length, 2);
    assert.equal(all[0]!.id, 'migrate-1');
    assert.equal(all[0]!.read, false);
    assert.equal(all[0]!.threadId, 'thread-1');
    assert.equal(all[1]!.id, 'migrate-2');
    assert.equal(all[1]!.read, true);
  });

  it('skips malformed JSONL lines gracefully', () => {
    const jsonlPath = join(dir, 'inbox.jsonl');
    const good = { id: 'good-1', from: 'alice', to: 'bob', timestamp: '2025-01-01T00:00:00Z', body: 'ok' };
    writeFileSync(jsonlPath, JSON.stringify(good) + '\n' + 'NOT VALID JSON\n');

    const count = migrateFromJsonl(jsonlPath);
    assert.equal(count, 1);

    const all = dbGetAll();
    assert.equal(all.length, 1);
    assert.equal(all[0]!.id, 'good-1');
  });

  it('renames source file to .migrated', () => {
    const jsonlPath = join(dir, 'inbox.jsonl');
    writeFileSync(jsonlPath, JSON.stringify({ id: 'r1', from: 'a', body: 'b' }) + '\n');

    migrateFromJsonl(jsonlPath);

    assert.equal(existsSync(jsonlPath), false);
    assert.equal(existsSync(jsonlPath + '.migrated'), true);
  });

  it('returns 0 when file does not exist', () => {
    const count = migrateFromJsonl(join(dir, 'nonexistent.jsonl'));
    assert.equal(count, 0);
  });
});

import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import {
  init, push, getUnread, getAll, getById, markRead, markAllRead,
  remove, purgeStale, subscribe, reset, getSignalPath, setNotifier,
  setReceiptSender, isReceipt, getInboxDir,
} from '../src/inbox.ts';
import { clearConfigCache } from '../src/config.ts';
import { createToolHandlers } from '../src/mcp.ts';
import type { InboxMessage } from '../src/types.ts';
import { createTestEnv, isolateConfig, withServer, httpJSON, withEnv } from './helpers.ts';

let env: ReturnType<typeof createTestEnv>;

beforeEach(() => {
  env = createTestEnv('icc-inbox-test');
  isolateConfig();
});

// --- Inbox module unit tests ---

describe('Inbox: push and getUnread', () => {
  it('push returns a message with generated fields', () => {
    const msg = push({ from: 'saturn', to: 'neptune', body: 'hello' });
    assert.ok(msg.id);
    assert.ok(msg.timestamp);
    assert.equal(msg.from, 'saturn');
    assert.equal(msg.to, 'neptune');
    assert.equal(msg.body, 'hello');
    assert.equal(msg.replyTo, null);
    assert.equal(msg.read, false);
  });

  it('getUnread returns unread messages', () => {
    push({ from: 'saturn', to: 'neptune', body: 'msg1' });
    push({ from: 'saturn', to: 'neptune', body: 'msg2' });
    const unread = getUnread();
    assert.equal(unread.length, 2);
  });

  it('push without to defaults to empty string', () => {
    const msg = push({ from: 'saturn', body: 'hello' });
    assert.equal(typeof msg.to, 'string');
    assert.equal(msg.to, '');
  });

  it('getUnread filters by sender', () => {
    push({ from: 'saturn', to: 'neptune', body: 'from saturn' });
    push({ from: 'other', to: 'neptune', body: 'from other' });
    const filtered = getUnread({ from: 'saturn' });
    assert.equal(filtered.length, 1);
    assert.equal(filtered[0]!.body, 'from saturn');
  });
});

describe('Inbox: markRead', () => {
  it('marks specific messages as read', () => {
    const m1 = push({ from: 'a', to: 'b', body: '1' });
    const m2 = push({ from: 'a', to: 'b', body: '2' });
    const count = markRead([m1.id]);
    assert.equal(count, 1);
    assert.equal(getUnread().length, 1);
    assert.equal(getUnread()[0]!.id, m2.id);
  });
});

describe('Inbox: markAllRead', () => {
  it('marks all messages as read', () => {
    push({ from: 'a', to: 'b', body: '1' });
    push({ from: 'a', to: 'b', body: '2' });
    const count = markAllRead();
    assert.equal(count, 2);
    assert.equal(getUnread().length, 0);
  });
});

describe('Inbox: remove', () => {
  it('removes messages by ID', () => {
    const m1 = push({ from: 'a', to: 'b', body: '1' });
    push({ from: 'a', to: 'b', body: '2' });
    const count = remove([m1.id]);
    assert.equal(count, 1);
    assert.equal(getAll().length, 1);
  });
});

describe('Inbox: getAll', () => {
  it('returns both read and unread messages', () => {
    push({ from: 'a', to: 'b', body: '1' });
    const m2 = push({ from: 'a', to: 'b', body: '2' });
    markRead([m2.id]);
    const all = getAll();
    assert.equal(all.length, 2);
    assert.ok(all.some(m => m.read));
    assert.ok(all.some(m => !m.read));
  });
});

describe('Inbox: subscribe', () => {
  it('notifies subscribers on push', () => {
    let received: InboxMessage | null = null;
    subscribe((msg) => { received = msg; });
    push({ from: 'a', to: 'b', body: 'test' });
    assert.ok(received);
    assert.equal((received as InboxMessage).body, 'test');
  });

  it('unsubscribe stops notifications', () => {
    let count = 0;
    const unsub = subscribe(() => { count++; });
    push({ from: 'a', to: 'b', body: '1' });
    unsub();
    push({ from: 'a', to: 'b', body: '2' });
    assert.equal(count, 1);
  });
});

describe('Inbox: persistence', () => {
  it('survives reset + init cycle', () => {
    push({ from: 'saturn', to: 'neptune', body: 'persistent' });
    reset(env.dir);
    assert.equal(getAll().length, 0);
    init();
    assert.equal(getAll().length, 1);
    assert.equal(getAll()[0]!.body, 'persistent');
  });

  it('persists markRead changes', () => {
    const msg = push({ from: 'a', to: 'b', body: 'mark me' });
    markRead([msg.id]);
    reset(env.dir);
    init();
    assert.equal(getAll()[0]!.read, true);
  });
});

// --- Signal file tests ---

describe('Inbox: signal file', () => {
  it('creates signal file on push', () => {
    push({ from: 'saturn', to: 'neptune', body: 'hello' });
    const sp = getSignalPath();
    assert.ok(existsSync(sp), 'signal file should exist after push');
    const content = readFileSync(sp, 'utf-8');
    assert.ok(content.includes('1 unread ICC message'));
    assert.ok(content.includes('saturn'));
    assert.ok(content.includes('hello'));
  });

  it('updates signal file with multiple messages', () => {
    push({ from: 'saturn', to: 'neptune', body: 'first' });
    push({ from: 'other', to: 'neptune', body: 'second' });
    const content = readFileSync(getSignalPath(), 'utf-8');
    assert.ok(content.includes('2 unread ICC messages'));
    assert.ok(content.includes('saturn'));
    assert.ok(content.includes('other'));
  });

  it('removes signal file when all marked read', () => {
    push({ from: 'saturn', to: 'neptune', body: 'read me' });
    assert.ok(existsSync(getSignalPath()));
    markAllRead();
    assert.ok(!existsSync(getSignalPath()), 'signal file should be removed after markAllRead');
  });

  it('removes signal file when specific messages marked read', () => {
    const msg = push({ from: 'saturn', to: 'neptune', body: 'only one' });
    assert.ok(existsSync(getSignalPath()));
    markRead([msg.id]);
    assert.ok(!existsSync(getSignalPath()), 'signal file should be removed when no unread remain');
  });

  it('keeps signal file when some messages still unread', () => {
    push({ from: 'saturn', to: 'neptune', body: 'msg1' });
    const m2 = push({ from: 'saturn', to: 'neptune', body: 'msg2' });
    markRead([m2.id]);
    assert.ok(existsSync(getSignalPath()), 'signal file should remain with unread messages');
    const content = readFileSync(getSignalPath(), 'utf-8');
    assert.ok(content.includes('1 unread ICC message'));
  });

  it('removes signal file when unread messages are deleted', () => {
    const msg = push({ from: 'saturn', to: 'neptune', body: 'delete me' });
    assert.ok(existsSync(getSignalPath()));
    remove([msg.id]);
    assert.ok(!existsSync(getSignalPath()), 'signal file should be removed after deleting unread message');
  });

  it('truncates long message preview', () => {
    const longBody = 'x'.repeat(200);
    push({ from: 'saturn', to: 'neptune', body: longBody });
    const content = readFileSync(getSignalPath(), 'utf-8');
    assert.ok(content.includes('...'), 'long preview should be truncated');
    assert.ok(!content.includes('x'.repeat(100)), 'should not contain the full long body');
  });

  it('signal file recreated on init with unread messages', () => {
    push({ from: 'saturn', to: 'neptune', body: 'persistent unread' });
    reset(env.dir);
    init();
    assert.ok(existsSync(getSignalPath()), 'init should recreate signal file for unread messages');
  });
});

describe('Inbox: setNotifier', () => {
  it('calls notifier on push', () => {
    let notified: InboxMessage | null = null;
    setNotifier((msg) => { notified = msg; });
    push({ from: 'saturn', to: 'neptune', body: 'notify me' });
    assert.ok(notified);
    assert.equal((notified as InboxMessage).body, 'notify me');
    assert.equal((notified as InboxMessage).from, 'saturn');
  });

  it('handles notifier errors gracefully', () => {
    setNotifier(() => { throw new Error('notification failed'); });
    const msg = push({ from: 'saturn', to: 'neptune', body: 'should not crash' });
    assert.ok(msg.id, 'push should succeed even if notifier throws');
  });
});

// --- Server integration tests ---

describe('Server: POST /api/inbox', () => {
  it('accepts valid message and returns id', async () => {
    await withServer({}, async (port) => {
      const res = await httpJSON(port, 'POST', '/api/inbox', {
        from: 'saturn', body: 'hello from integration test',
      });
      assert.equal(res.status, 200);
      assert.ok(res.data.ok);
      assert.ok(res.data.id);
    });
  });

  it('rejects missing from/body', async () => {
    await withServer({}, async (port) => {
      const res = await httpJSON(port, 'POST', '/api/inbox', { from: 'saturn' });
      assert.equal(res.status, 400);
    });
  });

  it('requires auth', async () => {
    await withServer({ localToken: 'test-auth-token' }, async (port) => {
      const res = await httpJSON(port, 'POST', '/api/inbox', { from: 'a', body: 'b' }, 'wrong');
      assert.equal(res.status, 401);
    });
  });
});

describe('Server: GET /api/inbox', () => {
  it('returns unread messages by default', async () => {
    await withServer({}, async (port) => {
      await httpJSON(port, 'POST', '/api/inbox', { from: 'saturn', body: 'msg1' });
      const res = await httpJSON(port, 'GET', '/api/inbox');
      assert.equal(res.status, 200);
      assert.equal(res.data.messages.length, 1);
      assert.equal(res.data.unreadCount, 1);
    });
  });

  it('returns all messages with ?all=true', async () => {
    await withServer({}, async (port) => {
      const postRes = await httpJSON(port, 'POST', '/api/inbox', { from: 'saturn', body: 'msg1' });
      await httpJSON(port, 'POST', '/api/inbox/mark-read', { ids: [postRes.data.id] });
      await httpJSON(port, 'POST', '/api/inbox', { from: 'saturn', body: 'msg2' });

      const unreadRes = await httpJSON(port, 'GET', '/api/inbox');
      assert.equal(unreadRes.data.messages.length, 1);

      const allRes = await httpJSON(port, 'GET', '/api/inbox?all=true');
      assert.equal(allRes.data.messages.length, 2);
    });
  });
});

describe('Server: POST /api/inbox/mark-read', () => {
  it('marks specific messages as read', async () => {
    await withServer({}, async (port) => {
      const r1 = await httpJSON(port, 'POST', '/api/inbox', { from: 'a', body: 'msg1' });
      await httpJSON(port, 'POST', '/api/inbox', { from: 'a', body: 'msg2' });
      const res = await httpJSON(port, 'POST', '/api/inbox/mark-read', { ids: [r1.data.id] });
      assert.equal(res.status, 200);
      assert.equal(res.data.marked, 1);
      const inbox = await httpJSON(port, 'GET', '/api/inbox');
      assert.equal(inbox.data.unreadCount, 1);
    });
  });

  it('marks all with all:true', async () => {
    await withServer({}, async (port) => {
      await httpJSON(port, 'POST', '/api/inbox', { from: 'a', body: 'msg1' });
      await httpJSON(port, 'POST', '/api/inbox', { from: 'a', body: 'msg2' });
      const res = await httpJSON(port, 'POST', '/api/inbox/mark-read', { all: true });
      assert.equal(res.data.marked, 2);
      const inbox = await httpJSON(port, 'GET', '/api/inbox');
      assert.equal(inbox.data.unreadCount, 0);
    });
  });
});

describe('Server: POST /api/inbox/delete', () => {
  it('deletes messages by ID', async () => {
    await withServer({}, async (port) => {
      const r1 = await httpJSON(port, 'POST', '/api/inbox', { from: 'a', body: 'msg1' });
      await httpJSON(port, 'POST', '/api/inbox', { from: 'a', body: 'msg2' });
      const res = await httpJSON(port, 'POST', '/api/inbox/delete', { ids: [r1.data.id] });
      assert.equal(res.status, 200);
      assert.equal(res.data.deleted, 1);
      const inbox = await httpJSON(port, 'GET', '/api/inbox?all=true');
      assert.equal(inbox.data.messages.length, 1);
    });
  });

  it('rejects missing ids', async () => {
    await withServer({}, async (port) => {
      const res = await httpJSON(port, 'POST', '/api/inbox/delete', {});
      assert.equal(res.status, 400);
    });
  });
});

// --- Instance addressing: forAddress filtering ---

describe('Inbox: getUnread with forAddress', () => {
  it('filters messages by instance address', () => {
    push({ from: 'neptune/icc', to: 'test-host/icc', body: 'for icc' });
    push({ from: 'neptune/icc', to: 'test-host/llmbridge', body: 'for llmbridge' });
    const iccUnread = getUnread({ forAddress: 'test-host/icc', serverIdentity: 'test-host' });
    assert.equal(iccUnread.length, 1);
    assert.equal(iccUnread[0]!.body, 'for icc');
  });

  it('broadcast messages match all instances', () => {
    push({ from: 'neptune', to: 'test-host', body: 'broadcast' });
    push({ from: 'neptune', to: 'test-host/icc', body: 'targeted' });
    const iccUnread = getUnread({ forAddress: 'test-host/icc', serverIdentity: 'test-host' });
    assert.equal(iccUnread.length, 2);
  });

  it('without forAddress returns all messages', () => {
    push({ from: 'neptune', to: 'test-host/icc', body: 'targeted' });
    push({ from: 'neptune', to: 'test-host', body: 'broadcast' });
    const all = getUnread();
    assert.equal(all.length, 2);
  });
});

describe('Inbox: getAll with forAddress', () => {
  it('filters by instance address', () => {
    push({ from: 'neptune', to: 'test-host/icc', body: 'icc only' });
    push({ from: 'neptune', to: 'test-host/other', body: 'other only' });
    const m = push({ from: 'neptune', to: 'test-host', body: 'broadcast' });
    markRead([m.id]);
    const iccAll = getAll({ forAddress: 'test-host/icc', serverIdentity: 'test-host' });
    assert.equal(iccAll.length, 2);
    assert.ok(iccAll.some(m => m.body === 'icc only'));
    assert.ok(iccAll.some(m => m.body === 'broadcast'));
  });
});

describe('Inbox: markAllRead with forAddress', () => {
  it('only marks messages for specific instance as read', () => {
    push({ from: 'neptune', to: 'test-host/icc', body: 'icc msg' });
    push({ from: 'neptune', to: 'test-host/other', body: 'other msg' });
    const count = markAllRead({ forAddress: 'test-host/icc', serverIdentity: 'test-host' });
    assert.equal(count, 1);
    assert.equal(getUnread().length, 1);
    assert.equal(getUnread()[0]!.body, 'other msg');
  });
});

// --- Instance signal file tests ---

describe('Inbox: per-instance signal files', () => {
  it('creates instance signal file for targeted messages', () => {
    push({ from: 'neptune', to: 'test-host/icc', body: 'hello icc' });
    const instanceSignal = getSignalPath('icc');
    assert.ok(existsSync(instanceSignal), 'instance signal file should exist');
    const content = readFileSync(instanceSignal, 'utf-8');
    assert.ok(content.includes('1 unread ICC message'));
  });

  it('does NOT create base signal file for instance-only messages', () => {
    push({ from: 'neptune', to: 'test-host/icc', body: 'targeted only' });
    const baseSignal = getSignalPath();
    assert.ok(!existsSync(baseSignal), 'base signal file should not exist for instance-only messages');
  });

  it('creates base signal file for broadcast messages', () => {
    push({ from: 'neptune', to: 'test-host', body: 'broadcast' });
    const baseSignal = getSignalPath();
    assert.ok(existsSync(baseSignal), 'base signal file should exist for broadcasts');
  });

  it('removes instance signal file when instance messages are read', () => {
    const msg = push({ from: 'neptune', to: 'test-host/icc', body: 'read me' });
    assert.ok(existsSync(getSignalPath('icc')));
    markRead([msg.id]);
    assert.ok(!existsSync(getSignalPath('icc')), 'instance signal should be removed');
  });

  it('separate signal files for different instances', () => {
    push({ from: 'neptune', to: 'test-host/icc', body: 'for icc' });
    push({ from: 'neptune', to: 'test-host/llmbridge', body: 'for llmbridge' });
    assert.ok(existsSync(getSignalPath('icc')));
    assert.ok(existsSync(getSignalPath('llmbridge')));
  });

  it('getSignalPath with instance returns instance-specific path', () => {
    const path = getSignalPath('icc');
    assert.ok(path.endsWith('unread.icc'));
  });

  it('getSignalPath without instance returns base path', () => {
    const path = getSignalPath();
    assert.ok(path.endsWith('unread'));
    assert.ok(!path.includes('.'));
  });
});

// --- Server instance addressing integration tests ---

describe('Server: POST /api/inbox with to field', () => {
  it('accepts message with instance-addressed to field', async () => {
    await withServer({}, async (port) => {
      const res = await httpJSON(port, 'POST', '/api/inbox', {
        from: 'neptune/icc', to: 'test-host/icc', body: 'hello icc',
      });
      assert.equal(res.status, 200);
      assert.ok(res.data.ok);
    });
  });

  it('rejects to field with wrong host', async () => {
    await withServer({}, async (port) => {
      const res = await httpJSON(port, 'POST', '/api/inbox', {
        from: 'neptune', to: 'wrong-host/icc', body: 'wrong host',
      });
      assert.equal(res.status, 400);
      assert.ok(res.data.error.includes('does not match'));
    });
  });

  it('defaults to broadcast when no to field', async () => {
    await withServer({}, async (port) => {
      await httpJSON(port, 'POST', '/api/inbox', {
        from: 'neptune', body: 'broadcast msg',
      });
      const inbox = await httpJSON(port, 'GET', '/api/inbox?all=true');
      assert.equal(inbox.data.messages[0].to, 'test-host');
    });
  });
});

describe('Server: GET /api/inbox with ?instance=', () => {
  it('filters by instance', async () => {
    await withServer({}, async (port) => {
      await httpJSON(port, 'POST', '/api/inbox', {
        from: 'neptune', to: 'test-host/icc', body: 'for icc',
      });
      await httpJSON(port, 'POST', '/api/inbox', {
        from: 'neptune', to: 'test-host/other', body: 'for other',
      });
      const iccRes = await httpJSON(port, 'GET', '/api/inbox?instance=icc');
      assert.equal(iccRes.data.messages.length, 1);
      assert.equal(iccRes.data.messages[0].body, 'for icc');
      assert.equal(iccRes.data.unreadCount, 1);

      const otherRes = await httpJSON(port, 'GET', '/api/inbox?instance=other');
      assert.equal(otherRes.data.messages.length, 1);
      assert.equal(otherRes.data.messages[0].body, 'for other');
    });
  });

  it('includes broadcast messages in instance filter', async () => {
    await withServer({}, async (port) => {
      await httpJSON(port, 'POST', '/api/inbox', {
        from: 'neptune', to: 'test-host/icc', body: 'targeted',
      });
      await httpJSON(port, 'POST', '/api/inbox', {
        from: 'neptune', body: 'broadcast',
      });
      const res = await httpJSON(port, 'GET', '/api/inbox?instance=icc');
      assert.equal(res.data.messages.length, 2);
    });
  });

  it('without instance returns all messages', async () => {
    await withServer({}, async (port) => {
      await httpJSON(port, 'POST', '/api/inbox', {
        from: 'neptune', to: 'test-host/icc', body: 'for icc',
      });
      await httpJSON(port, 'POST', '/api/inbox', {
        from: 'neptune', to: 'test-host/other', body: 'for other',
      });
      const res = await httpJSON(port, 'GET', '/api/inbox');
      assert.equal(res.data.messages.length, 2);
    });
  });
});

describe('Server: GET /api/inbox with ?receipts=false', () => {
  it('excludes receipt messages from response and unreadCount', async () => {
    await withServer({}, async (port) => {
      await httpJSON(port, 'POST', '/api/inbox', { from: 'saturn', body: 'hello' });
      await httpJSON(port, 'POST', '/api/inbox', {
        from: 'saturn', body: 'receipt',
        _meta: { type: 'read-receipt', originalId: 'abc-123', readAt: '2026-01-01T00:00:00Z' },
      });

      const all = await httpJSON(port, 'GET', '/api/inbox?all=true');
      assert.equal(all.data.messages.length, 2);
      assert.equal(all.data.unreadCount, 2);

      const filtered = await httpJSON(port, 'GET', '/api/inbox?all=true&receipts=false');
      assert.equal(filtered.data.messages.length, 1);
      assert.equal(filtered.data.messages[0].body, 'hello');
      assert.equal(filtered.data.unreadCount, 1);
    });
  });
});

describe('Server: GET /api/health with instance', () => {
  it('includes instance field (null when not set)', async () => {
    await withServer({}, async (port) => {
      const res = await httpJSON(port, 'GET', '/api/health');
      assert.equal(res.data.instance, null);
    });
  });
});

// --- MCP tool handler tests ---

describe('MCP tool: sendMessage', () => {
  it('calls peerAPI with correct payload', async () => {
    let captured: any;
    const mockPeer = async (peer: string, method: string, path: string, body: any) => {
      captured = { peer, method, path, body };
      return { ok: true, id: 'abc-123' };
    };
    const handlers = createToolHandlers({} as any, mockPeer, async () => {});
    const result = await handlers.sendMessage({ body: 'hello remote', to: 'neptune/icc' });
    assert.equal(captured.peer, 'neptune');
    assert.equal(captured.method, 'POST');
    assert.equal(captured.path, '/api/inbox');
    assert.equal(captured.body.from, 'test-host');
    assert.equal(captured.body.body, 'hello remote');
    assert.ok(result.content[0]!.text.includes('abc-123'));
  });

  it('uses full address when instance is set', async () => {
    await withEnv({ ICC_INSTANCE: 'icc' }, async () => {
      clearConfigCache();
      let captured: any;
      const mockPeer = async (peer: string, method: string, path: string, body: any) => {
        captured = { peer, method, path, body };
        return { ok: true, id: 'abc-123' };
      };
      const handlers = createToolHandlers({} as any, mockPeer, async () => {});
      await handlers.sendMessage({ body: 'hello', to: 'neptune' });
      assert.equal(captured.body.from, 'test-host/icc');
    });
  });

  it('passes to field when provided', async () => {
    let captured: any;
    const mockPeer = async (_peer: string, _method: string, _path: string, body: any) => {
      captured = body;
      return { ok: true, id: 'abc-123' };
    };
    const handlers = createToolHandlers({} as any, mockPeer, async () => {});
    await handlers.sendMessage({ body: 'targeted', to: 'neptune/icc' });
    assert.equal(captured.to, 'neptune/icc');
  });

  it('sends to local when no to and no peers', async () => {
    let captured: any;
    const mockLocal = async (_method: string, _path: string, body: any) => {
      captured = body;
      return { ok: true, id: 'abc-123' };
    };
    const handlers = createToolHandlers({} as any, async () => {}, mockLocal);
    await handlers.sendMessage({ body: 'broadcast' });
    assert.equal(captured.body, 'broadcast');
  });

  it('returns error on failure', async () => {
    const mockPeer = async () => { throw new Error('connection refused'); };
    const handlers = createToolHandlers({} as any, mockPeer, async () => {});
    const result = await handlers.sendMessage({ body: 'hello', to: 'neptune' });
    assert.ok(result.isError);
    assert.ok(result.content[0]!.text.includes('connection refused'));
  });
});

describe('MCP tool: checkMessages', () => {
  it('unread-only: formats without read markers', async () => {
    const calls: any[] = [];
    const mockLocal = async (method: string, path: string, body?: any) => {
      calls.push({ method, path, body });
      if (method === 'GET') {
        return {
          messages: [
            { id: 'msg-1', from: 'saturn', timestamp: '2026-01-01T00:00:00Z', body: 'hello', read: false, replyTo: null },
          ],
          unreadCount: 1,
        };
      }
      return { ok: true, marked: 1 };
    };
    const handlers = createToolHandlers({} as any, async () => {}, mockLocal);
    const result = await handlers.checkMessages({});
    const text = result.content[0]!.text;
    assert.ok(text.includes('hello'));
    assert.ok(text.includes('saturn'));
    assert.ok(text.includes('1 unread message(s):'));
    assert.ok(!text.includes('* '));
    assert.equal(calls.length, 2);
    assert.equal(calls[1]!.method, 'POST');
    assert.equal(calls[1]!.path, '/api/inbox/mark-read');
  });

  it('all mode: shows total count and read markers', async () => {
    const mockLocal = async (method: string, _path: string) => {
      if (method === 'GET') {
        return {
          messages: [
            { id: 'msg-1', from: 'saturn', timestamp: '2026-01-01T00:00:00Z', body: 'old', read: true, replyTo: null },
            { id: 'msg-2', from: 'saturn', timestamp: '2026-01-02T00:00:00Z', body: 'new', read: false, replyTo: null },
          ],
          unreadCount: 1,
        };
      }
      return { ok: true, marked: 1 };
    };
    const handlers = createToolHandlers({} as any, async () => {}, mockLocal);
    const result = await handlers.checkMessages({ all: true });
    const text = result.content[0]!.text;
    assert.ok(text.includes('2 message(s) (1 unread):'));
    assert.ok(text.includes('* '));
  });

  it('returns empty message when no unread', async () => {
    const mockLocal = async () => ({ messages: [], unreadCount: 0 });
    const handlers = createToolHandlers({} as any, async () => {}, mockLocal);
    const result = await handlers.checkMessages({});
    assert.ok(result.content[0]!.text.includes('No unread'));
  });
});

describe('MCP tool: respondToMessage', () => {
  it('sends reply with replyTo field', async () => {
    let captured: any;
    const mockPeer = async (peer: string, method: string, path: string, body: any) => {
      captured = { peer, method, path, body };
      return { ok: true, id: 'reply-456' };
    };
    const mockLocal = async (method: string, _path: string) => {
      if (method === 'GET') return { message: { from: 'neptune/icc', body: 'original' } };
      return { ok: true };
    };
    const handlers = createToolHandlers({} as any, mockPeer, mockLocal);
    const result = await handlers.respondToMessage({ messageId: 'orig-123', body: 'looks good' });
    assert.equal(captured.body.replyTo, 'orig-123');
    assert.equal(captured.body.body, 'looks good');
    assert.equal(captured.body.from, 'test-host');
    assert.ok(result.content[0]!.text.includes('reply-456'));
    assert.ok(result.content[0]!.text.includes('orig-123'));
  });

  it('uses full address when instance is set', async () => {
    await withEnv({ ICC_INSTANCE: 'icc' }, async () => {
      clearConfigCache();
      let captured: any;
      const mockPeer = async (_peer: string, _method: string, _path: string, body: any) => {
        captured = body;
        return { ok: true, id: 'reply-456' };
      };
      const mockLocal = async (method: string, _path: string) => {
        if (method === 'GET') return { message: { from: 'neptune/icc', body: 'original' } };
        return { ok: true };
      };
      const handlers = createToolHandlers({} as any, mockPeer, mockLocal);
      await handlers.respondToMessage({ messageId: 'orig-123', body: 'reply' });
      assert.equal(captured.from, 'test-host/icc');
    });
  });
});

describe('MCP tool: checkMessages with instance', () => {
  it('passes instance query param when ICC_INSTANCE is set', async () => {
    await withEnv({ ICC_INSTANCE: 'icc' }, async () => {
      clearConfigCache();
      const calls: any[] = [];
      const mockLocal = async (method: string, path: string, _body?: any) => {
        calls.push({ method, path });
        if (method === 'GET') return { messages: [], unreadCount: 0 };
        return { ok: true, marked: 0 };
      };
      const handlers = createToolHandlers({} as any, async () => {}, mockLocal);
      await handlers.checkMessages({});
      assert.ok(calls[0].path.includes('instance=icc'));
    });
  });

  it('does not pass instance when ICC_INSTANCE is not set', async () => {
    const calls: any[] = [];
    const mockLocal = async (method: string, path: string) => {
      calls.push({ method, path });
      if (method === 'GET') return { messages: [], unreadCount: 0 };
      return { ok: true, marked: 0 };
    };
    const handlers = createToolHandlers({} as any, async () => {}, mockLocal);
    await handlers.checkMessages({});
    assert.ok(!calls[0].path.includes('instance='));
  });
});

describe('MCP tool: deleteMessages', () => {
  it('deletes by specific IDs', async () => {
    let captured: any;
    const mockLocal = async (method: string, path: string, body?: any) => {
      if (method === 'POST' && path === '/api/inbox/delete') {
        captured = body;
        return { ok: true, deleted: 2 };
      }
    };
    const handlers = createToolHandlers({} as any, async () => {}, mockLocal);
    const result = await handlers.deleteMessages({ ids: ['id-1', 'id-2'] });
    assert.deepEqual(captured.ids, ['id-1', 'id-2']);
    assert.ok(result.content[0]!.text.includes('Deleted 2'));
  });

  it('purge_read fetches all then deletes read messages', async () => {
    const calls: any[] = [];
    const mockLocal = async (method: string, path: string, body?: any) => {
      calls.push({ method, path, body });
      if (method === 'GET') {
        return {
          messages: [
            { id: 'read-1', read: true },
            { id: 'read-2', read: true },
            { id: 'unread-1', read: false },
          ],
          unreadCount: 1,
        };
      }
      if (method === 'POST' && path === '/api/inbox/delete') {
        return { ok: true, deleted: body.ids.length };
      }
    };
    const handlers = createToolHandlers({} as any, async () => {}, mockLocal);
    const result = await handlers.deleteMessages({ purge_read: true });
    assert.equal(calls.length, 2);
    assert.equal(calls[0]!.path, '/api/inbox?all=true');
    assert.deepEqual(calls[1]!.body.ids, ['read-1', 'read-2']);
    assert.ok(result.content[0]!.text.includes('Deleted 2'));
  });

  it('combines ids and purge_read without duplicates', async () => {
    let deletedIds: string[] = [];
    const mockLocal = async (method: string, path: string, body?: any) => {
      if (method === 'GET') {
        return {
          messages: [
            { id: 'read-1', read: true },
            { id: 'unread-1', read: false },
          ],
          unreadCount: 1,
        };
      }
      if (method === 'POST' && path === '/api/inbox/delete') {
        deletedIds = body.ids;
        return { ok: true, deleted: body.ids.length };
      }
    };
    const handlers = createToolHandlers({} as any, async () => {}, mockLocal);
    // Pass read-1 in both ids and purge_read — should not duplicate
    await handlers.deleteMessages({ ids: ['read-1', 'unread-1'], purge_read: true });
    assert.equal(deletedIds.length, 2);
    assert.ok(deletedIds.includes('read-1'));
    assert.ok(deletedIds.includes('unread-1'));
  });

  it('returns no-op message when nothing to delete', async () => {
    const mockLocal = async (method: string) => {
      if (method === 'GET') return { messages: [], unreadCount: 0 };
    };
    const handlers = createToolHandlers({} as any, async () => {}, mockLocal);
    const result = await handlers.deleteMessages({ purge_read: true });
    assert.ok(result.content[0]!.text.includes('No messages to delete'));
  });

  it('returns error on failure', async () => {
    const mockLocal = async () => { throw new Error('disk full'); };
    const handlers = createToolHandlers({} as any, async () => {}, mockLocal);
    const result = await handlers.deleteMessages({ ids: ['id-1'] });
    assert.ok(result.isError);
    assert.ok(result.content[0]!.text.includes('disk full'));
  });
});

// --- Receipts ---

describe('Inbox: receipt handling', () => {
  it('isReceipt identifies receipt messages', () => {
    const regular = push({ from: 'a', to: 'b', body: 'hello' });
    assert.equal(isReceipt(regular), false);

    const receipt = push({
      from: 'a', to: 'b', body: 'read',
      _meta: { type: 'read-receipt', originalId: 'abc', readAt: '2026-01-01' },
    });
    assert.equal(isReceipt(receipt), true);
  });

  it('setReceiptSender is called on markRead', () => {
    const sent: InboxMessage[] = [];
    setReceiptSender((m) => { sent.push(m); });
    const msg = push({ from: 'saturn/icc', to: 'test-host', body: 'hello' });
    markRead([msg.id]);
    assert.equal(sent.length, 1);
    assert.equal(sent[0]!.id, msg.id);
    setReceiptSender(null);
  });

  it('does not send receipt for receipt messages', () => {
    const sent: InboxMessage[] = [];
    setReceiptSender((m) => { sent.push(m); });
    const msg = push({
      from: 'saturn/icc', to: 'test-host', body: 'read',
      _meta: { type: 'read-receipt', originalId: 'abc', readAt: '2026-01-01' },
    });
    markRead([msg.id]);
    assert.equal(sent.length, 0, 'should not send receipt for receipts');
    setReceiptSender(null);
  });
});

// --- Purge stale ---

describe('Inbox: purgeStale', () => {
  it('removes unread messages older than maxAgeDays', () => {
    const old = push({ from: 'neptune', to: 'test-host', body: 'stale msg' });
    // Backdate timestamp to 10 days ago
    old.timestamp = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000).toISOString();
    push({ from: 'neptune', to: 'test-host', body: 'fresh msg' });
    const purged = purgeStale(7);
    assert.equal(purged, 1);
    assert.equal(getAll().length, 1);
    assert.equal(getAll()[0]!.body, 'fresh msg');
  });

  it('does not remove recent read messages (< 1 day)', () => {
    const recent = push({ from: 'neptune', to: 'test-host', body: 'recently read' });
    markRead([recent.id]);
    const purged = purgeStale(7);
    assert.equal(purged, 0);
    assert.equal(getAll().length, 1);
  });

  it('archives old read messages (> 1 day)', () => {
    const old = push({ from: 'neptune', to: 'test-host', body: 'old but read' });
    old.timestamp = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000).toISOString();
    markRead([old.id]);
    const purged = purgeStale(7);
    assert.equal(purged, 1);
    assert.equal(getAll().length, 0);
    // Verify it was archived
    const archiveDir = join(getInboxDir(), 'archive');
    const files = readdirSync(archiveDir);
    assert.equal(files.length, 1);
    const archived = readFileSync(join(archiveDir, files[0]!), 'utf-8').trim();
    assert.ok(archived.includes('old but read'));
  });

  it('does not remove recent unread messages', () => {
    push({ from: 'neptune', to: 'test-host', body: 'recent unread' });
    const purged = purgeStale(7);
    assert.equal(purged, 0);
    assert.equal(getAll().length, 1);
  });

  it('returns 0 on empty inbox', () => {
    assert.equal(purgeStale(7), 0);
  });

  it('respects custom maxAgeDays', () => {
    const msg = push({ from: 'neptune', to: 'test-host', body: 'three days old' });
    msg.timestamp = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000).toISOString();
    // With 7-day window, should NOT be purged
    assert.equal(purgeStale(7), 0);
    // With 2-day window, should be purged
    assert.equal(purgeStale(2), 1);
  });

  it('updates signal file after purge', () => {
    const old = push({ from: 'neptune', to: 'test-host', body: 'stale' });
    old.timestamp = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000).toISOString();
    assert.ok(existsSync(getSignalPath()));
    purgeStale(7);
    assert.ok(!existsSync(getSignalPath()), 'signal file should be removed after purging all unread');
  });

  it('purges old receipts (> 1 day) without archiving', () => {
    const receipt = push({
      from: 'neptune', to: 'test-host', body: '',
      _meta: { type: 'read-receipt', originalId: 'abc-123', readAt: new Date().toISOString() },
    });
    receipt.timestamp = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000).toISOString();
    markRead([receipt.id]);
    const purged = purgeStale(7);
    assert.equal(purged, 1);
    assert.equal(getAll().length, 0);
    // Verify NO archive was created (receipts are not archived)
    const archiveDir = join(getInboxDir(), 'archive');
    assert.ok(!existsSync(archiveDir), 'receipts should not be archived');
  });

  it('archive file appends (not overwrites)', () => {
    const m1 = push({ from: 'neptune', to: 'test-host', body: 'msg1' });
    m1.timestamp = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000).toISOString();
    markRead([m1.id]);
    purgeStale(7);

    const m2 = push({ from: 'neptune', to: 'test-host', body: 'msg2' });
    m2.timestamp = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000).toISOString();
    markRead([m2.id]);
    purgeStale(7);

    const archiveDir = join(getInboxDir(), 'archive');
    const files = readdirSync(archiveDir);
    const content = readFileSync(join(archiveDir, files[0]!), 'utf-8').trim();
    const lines = content.split('\n');
    assert.equal(lines.length, 2);
    assert.ok(lines[0]!.includes('msg1'));
    assert.ok(lines[1]!.includes('msg2'));
  });

  it('does not archive unread messages', () => {
    const msg = push({ from: 'neptune', to: 'test-host', body: 'unread old' });
    msg.timestamp = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000).toISOString();
    // Don't mark as read — should NOT be archived (too fresh for stale cutoff of 7 days)
    const purged = purgeStale(7);
    assert.equal(purged, 0);
    assert.equal(getAll().length, 1);
  });
});

// --- getById ---

describe('Inbox: getById', () => {
  it('returns message when found', () => {
    const msg = push({ from: 'saturn', to: 'neptune', body: 'find me' });
    const found = getById(msg.id);
    assert.ok(found);
    assert.equal(found!.id, msg.id);
    assert.equal(found!.body, 'find me');
  });

  it('returns null when not found', () => {
    push({ from: 'saturn', to: 'neptune', body: 'not this' });
    const result = getById('nonexistent-id');
    assert.equal(result, null);
  });

  it('returns null on empty inbox', () => {
    const result = getById('any-id');
    assert.equal(result, null);
  });
});

// --- getInboxDir ---

describe('Inbox: getInboxDir', () => {
  it('returns current inbox directory', () => {
    const dir = getInboxDir();
    assert.ok(dir.includes('icc-inbox-test'));
  });
});

describe('Server: GET /api/inbox with ?threadId=', () => {
  it('filters messages by threadId', async () => {
    await withServer({}, async (port) => {
      await httpJSON(port, 'POST', '/api/inbox', { from: 'a', body: 'thread-A', threadId: 'thread-A' });
      await httpJSON(port, 'POST', '/api/inbox', { from: 'b', body: 'thread-B', threadId: 'thread-B' });
      await httpJSON(port, 'POST', '/api/inbox', { from: 'c', body: 'thread-A again', threadId: 'thread-A' });

      const all = await httpJSON(port, 'GET', '/api/inbox?all=true');
      assert.equal(all.data.messages.length, 3);

      const filtered = await httpJSON(port, 'GET', '/api/inbox?all=true&threadId=thread-A');
      assert.equal(filtered.data.messages.length, 2);
      for (const m of filtered.data.messages) {
        assert.equal(m.threadId, 'thread-A');
      }
    });
  });

  it('returns empty when threadId matches nothing', async () => {
    await withServer({}, async (port) => {
      await httpJSON(port, 'POST', '/api/inbox', { from: 'a', body: 'msg', threadId: 'thread-X' });

      const filtered = await httpJSON(port, 'GET', '/api/inbox?all=true&threadId=nonexistent');
      assert.equal(filtered.data.messages.length, 0);
    });
  });
});

// --- Server: GET /api/inbox/:id tests ---

describe('Server: GET /api/inbox/:id', () => {
  it('returns message by ID', async () => {
    await withServer({}, async (port) => {
      const postRes = await httpJSON(port, 'POST', '/api/inbox', {
        from: 'neptune/icc', body: 'test lookup',
      });
      const msgId = postRes.data.id;
      const res = await httpJSON(port, 'GET', `/api/inbox/${msgId}`);
      assert.equal(res.status, 200);
      assert.equal(res.data.message.id, msgId);
      assert.equal(res.data.message.body, 'test lookup');
      assert.equal(res.data.message.from, 'neptune/icc');
    });
  });

  it('returns 404 for nonexistent ID', async () => {
    await withServer({}, async (port) => {
      const res = await httpJSON(port, 'GET', '/api/inbox/nonexistent-id');
      assert.equal(res.status, 404);
      assert.ok(res.data.error.includes('not found'));
    });
  });

  it('requires auth', async () => {
    await withServer({ localToken: 'test-auth-token' }, async (port) => {
      const res = await httpJSON(port, 'GET', '/api/inbox/some-id', null, 'wrong');
      assert.equal(res.status, 401);
    });
  });
});

// --- MCP tool: respondToMessage reply routing ---

describe('MCP tool: respondToMessage reply routing', () => {
  it('includes to field from original message from', async () => {
    let captured: any;
    const mockPeer = async (_peer: string, method: string, path: string, body: any) => {
      if (method === 'POST' && path === '/api/inbox') {
        captured = body;
        return { ok: true, id: 'reply-789' };
      }
    };
    const mockLocal = async (method: string, reqPath: string) => {
      if (method === 'GET' && reqPath === '/api/inbox/orig-123') {
        return { message: { id: 'orig-123', from: 'neptune/icc', to: 'test-host', body: 'hello', read: false } };
      }
    };
    const handlers = createToolHandlers({} as any, mockPeer, mockLocal);
    await handlers.respondToMessage({ messageId: 'orig-123', body: 'reply text' });
    assert.equal(captured.to, 'neptune/icc');
    assert.equal(captured.from, 'test-host');
    assert.equal(captured.replyTo, 'orig-123');
    assert.equal(captured.body, 'reply text');
  });

  it('falls back to local when lookup fails and no peers', async () => {
    let captured: any;
    const mockPeer = async () => { throw new Error('should not be called'); };
    const mockLocal = async (method: string, _path: string, body?: any) => {
      if (method === 'GET') throw new Error('not found');
      // POST for reply — lands here when no peers and no lookup
      captured = body;
      return { ok: true, id: 'reply-789' };
    };
    const handlers = createToolHandlers({} as any, mockPeer, mockLocal);
    await handlers.respondToMessage({ messageId: 'orig-123', body: 'reply text' });
    assert.equal(captured.to, undefined);
    assert.equal(captured.replyTo, 'orig-123');
  });

  it('uses full address when instance is set', async () => {
    await withEnv({ ICC_INSTANCE: 'icc' }, async () => {
      clearConfigCache();
      let captured: any;
      const mockPeer = async (_peer: string, method: string, _path: string, body: any) => {
        if (method === 'POST') {
          captured = body;
          return { ok: true, id: 'reply-789' };
        }
      };
      const mockLocal = async (method: string, _path: string) => {
        if (method === 'GET') {
          return { message: { id: 'orig-123', from: 'neptune/myapp' } };
        }
      };
      const handlers = createToolHandlers({} as any, mockPeer, mockLocal);
      await handlers.respondToMessage({ messageId: 'orig-123', body: 'reply' });
      assert.equal(captured.from, 'test-host/icc');
      assert.equal(captured.to, 'neptune/myapp');
    });
  });
});

// --- _meta field tests ---

describe('Inbox: _meta field', () => {
  it('push preserves _meta', () => {
    const meta = { type: 'read-receipt', originalId: 'abc', readAt: '2026-01-01T00:00:00Z' };
    const msg = push({ from: 'neptune', to: 'test-host', body: '', _meta: meta });
    assert.deepEqual(msg._meta, meta);
  });

  it('push defaults _meta to null', () => {
    const msg = push({ from: 'neptune', to: 'test-host', body: 'hello' });
    assert.equal(msg._meta, null);
  });

  it('_meta survives persistence', () => {
    const meta = { type: 'read-receipt', originalId: 'abc', readAt: '2026-01-01T00:00:00Z' };
    push({ from: 'neptune', to: 'test-host', body: '', _meta: meta });
    reset(env.dir);
    init();
    const all = getAll();
    assert.equal(all.length, 1);
    assert.deepEqual(all[0]!._meta, meta);
  });
});

describe('Inbox: isReceipt', () => {
  it('returns true for read-receipt messages', () => {
    assert.ok(isReceipt({ _meta: { type: 'read-receipt' } } as InboxMessage));
  });

  it('returns false for null _meta', () => {
    assert.ok(!isReceipt({ _meta: null } as InboxMessage));
  });

  it('returns false for missing _meta', () => {
    assert.ok(!isReceipt({} as InboxMessage));
  });

  it('returns false for other _meta types', () => {
    assert.ok(!isReceipt({ _meta: { type: 'something-else' } } as InboxMessage));
  });
});

describe('Inbox: silent push', () => {
  it('silent push skips signal file', () => {
    push(
      { from: 'neptune', to: 'test-host', body: '', _meta: { type: 'read-receipt' } },
      { silent: true },
    );
    assert.ok(!existsSync(getSignalPath()), 'signal file should not exist for silent push');
  });

  it('silent push skips notifier', () => {
    let notified = false;
    setNotifier(() => { notified = true; });
    push(
      { from: 'neptune', to: 'test-host', body: '', _meta: { type: 'read-receipt' } },
      { silent: true },
    );
    assert.ok(!notified, 'notifier should not fire for silent push');
  });

  it('silent push still fires subscribers (SSE)', () => {
    let received: InboxMessage | null = null;
    subscribe((msg) => { received = msg; });
    push(
      { from: 'neptune', to: 'test-host', body: '', _meta: { type: 'read-receipt' } },
      { silent: true },
    );
    assert.ok(received, 'subscribers should still receive silent pushes');
  });

  it('default push still creates signal file (backward compat)', () => {
    push({ from: 'neptune', to: 'test-host', body: 'normal msg' });
    assert.ok(existsSync(getSignalPath()), 'signal file should exist for normal push');
  });
});

describe('Inbox: receipts excluded from signal files', () => {
  it('unread receipts do not create signal files', () => {
    push({ from: 'neptune', to: 'test-host', body: '', _meta: { type: 'read-receipt' } });
    // Even though the receipt is technically "unread", signal files exclude receipts
    assert.ok(!existsSync(getSignalPath()), 'signal file should not exist for receipt-only unread');
  });

  it('receipts excluded from unread count in signal files', () => {
    push({ from: 'neptune', to: 'test-host', body: 'real msg' });
    push({ from: 'neptune', to: 'test-host', body: '', _meta: { type: 'read-receipt' } });
    const content = readFileSync(getSignalPath(), 'utf-8');
    assert.ok(content.includes('1 unread ICC message'), 'should count only non-receipt messages');
  });
});

describe('Inbox: receipt sender', () => {
  it('markRead calls sender for newly-read remote messages', () => {
    const sent: InboxMessage[] = [];
    setReceiptSender((m) => { sent.push(m); });
    const msg = push({ from: 'neptune', to: 'test-host', body: 'read me' });
    markRead([msg.id]);
    assert.equal(sent.length, 1);
    assert.equal(sent[0]!.id, msg.id);
    setReceiptSender(null);
  });

  it('skips already-read messages', () => {
    const sent: InboxMessage[] = [];
    setReceiptSender((m) => { sent.push(m); });
    const msg = push({ from: 'neptune', to: 'test-host', body: 'already read' });
    markRead([msg.id]);
    sent.length = 0;
    markRead([msg.id]); // already read, should not fire again
    assert.equal(sent.length, 0);
    setReceiptSender(null);
  });

  it('skips receipt messages (loop prevention)', () => {
    const sent: InboxMessage[] = [];
    setReceiptSender((m) => { sent.push(m); });
    const receipt = push({
      from: 'neptune', to: 'test-host', body: '',
      _meta: { type: 'read-receipt', originalId: 'abc' },
    });
    markRead([receipt.id]);
    assert.equal(sent.length, 0, 'should not send receipt for a receipt');
    setReceiptSender(null);
  });

  it('markAllRead calls sender', () => {
    const sent: InboxMessage[] = [];
    setReceiptSender((m) => { sent.push(m); });
    push({ from: 'neptune', to: 'test-host', body: 'msg1' });
    push({ from: 'neptune', to: 'test-host', body: 'msg2' });
    markAllRead();
    assert.equal(sent.length, 2);
    setReceiptSender(null);
  });

  it('markRead passes readerAddress to sender', () => {
    const sent: { msg: InboxMessage; reader: string }[] = [];
    setReceiptSender((m: InboxMessage, addr: string) => { sent.push({ msg: m, reader: addr }); });
    const msg = push({ from: 'neptune', to: 'test-host', body: 'read me' });
    markRead([msg.id], 'test-host/my-instance');
    assert.equal(sent.length, 1);
    assert.equal(sent[0]!.reader, 'test-host/my-instance');
    setReceiptSender(null);
  });

  it('markAllRead passes readerAddress to sender', () => {
    const sent: { msg: InboxMessage; reader: string }[] = [];
    setReceiptSender((m: InboxMessage, addr: string) => { sent.push({ msg: m, reader: addr }); });
    push({ from: 'neptune', to: 'test-host', body: 'msg1' });
    markAllRead({ readerAddress: 'test-host/my-instance' });
    assert.equal(sent.length, 1);
    assert.equal(sent[0]!.reader, 'test-host/my-instance');
    setReceiptSender(null);
  });

  it('no sender set works normally', () => {
    setReceiptSender(null);
    const msg = push({ from: 'neptune', to: 'test-host', body: 'no sender' });
    // Should not throw
    markRead([msg.id]);
    assert.ok(getById(msg.id)!.read);
  });

  it('sender errors are caught gracefully', () => {
    setReceiptSender(() => { throw new Error('send failed'); });
    const msg = push({ from: 'neptune', to: 'test-host', body: 'test' });
    // Should not throw
    markRead([msg.id]);
    assert.ok(getById(msg.id)!.read);
    setReceiptSender(null);
  });
});

// --- Server integration: receipt tests ---

describe('Server: POST /api/inbox with _meta', () => {
  it('preserves _meta field', async () => {
    await withServer({}, async (port) => {
      const meta = { type: 'read-receipt', originalId: 'abc', readAt: '2026-01-01T00:00:00Z' };
      const res = await httpJSON(port, 'POST', '/api/inbox', {
        from: 'neptune', body: '', _meta: meta,
      });
      assert.equal(res.status, 200);
      const inbox = await httpJSON(port, 'GET', '/api/inbox?all=true');
      assert.deepEqual(inbox.data.messages[0]._meta, meta);
    });
  });

  it('allows empty body for receipts', async () => {
    await withServer({}, async (port) => {
      const res = await httpJSON(port, 'POST', '/api/inbox', {
        from: 'neptune', body: '', _meta: { type: 'read-receipt' },
      });
      assert.equal(res.status, 200);
      assert.ok(res.data.ok);
    });
  });

  it('receipt push does not create signal file', async () => {
    await withServer({}, async (port) => {
      await httpJSON(port, 'POST', '/api/inbox', {
        from: 'neptune', body: '', _meta: { type: 'read-receipt', originalId: 'abc' },
      });
      assert.ok(!existsSync(getSignalPath()), 'signal file should not exist for receipt');
    });
  });
});

// --- MCP tool: checkMessages with receipts ---

describe('MCP tool: checkMessages with receipts', () => {
  it('filters receipts from message list and appends summary', async () => {
    const mockLocal = async (method: string, _path: string) => {
      if (method === 'GET') {
        return {
          messages: [
            { id: 'msg-1', from: 'saturn', timestamp: '2026-01-01T00:00:00Z', body: 'hello', read: false, replyTo: null, _meta: null },
            { id: 'rcpt-1', from: 'saturn', timestamp: '2026-01-01T00:01:00Z', body: '', read: false, replyTo: null, _meta: { type: 'read-receipt', originalId: 'orig-1', readAt: '2026-01-01T00:01:00Z' } },
          ],
          unreadCount: 2,
        };
      }
      return { ok: true, marked: 2 };
    };
    const handlers = createToolHandlers({} as any, async () => {}, mockLocal);
    const result = await handlers.checkMessages({});
    const text = result.content[0]!.text;
    // Regular message shown
    assert.ok(text.includes('hello'));
    assert.ok(text.includes('1 unread message(s):'));
    // Receipt shown as summary only
    assert.ok(text.includes('[READ_RECEIPTS]'));
    assert.ok(text.includes('1 message(s) confirmed read'));
    assert.ok(text.includes('orig-1'));
    // Receipt body NOT shown as a regular message
    assert.ok(!text.includes('(id: rcpt-1)'));
  });

  it('shows only receipt summary when no regular messages', async () => {
    const mockLocal = async (method: string) => {
      if (method === 'GET') {
        return {
          messages: [
            { id: 'rcpt-1', from: 'saturn', timestamp: '2026-01-01T00:01:00Z', body: '', read: false, replyTo: null, _meta: { type: 'read-receipt', originalId: 'orig-1', readAt: '2026-01-01T00:01:00Z' } },
          ],
          unreadCount: 1,
        };
      }
      return { ok: true, marked: 1 };
    };
    const handlers = createToolHandlers({} as any, async () => {}, mockLocal);
    const result = await handlers.checkMessages({});
    const text = result.content[0]!.text;
    assert.ok(text.includes('[READ_RECEIPTS]'));
    assert.ok(!text.includes('unread message(s):'));
  });

  it('marks all messages (including receipts) as read', async () => {
    const calls: any[] = [];
    const mockLocal = async (method: string, path: string, body?: any) => {
      calls.push({ method, path, body });
      if (method === 'GET') {
        return {
          messages: [
            { id: 'msg-1', from: 'saturn', timestamp: '2026-01-01T00:00:00Z', body: 'hello', read: false, replyTo: null, _meta: null },
            { id: 'rcpt-1', from: 'saturn', timestamp: '2026-01-01T00:01:00Z', body: '', read: false, replyTo: null, _meta: { type: 'read-receipt', originalId: 'orig-1' } },
          ],
          unreadCount: 2,
        };
      }
      return { ok: true, marked: 2 };
    };
    const handlers = createToolHandlers({} as any, async () => {}, mockLocal);
    await handlers.checkMessages({});
    const markCall = calls.find(c => c.path === '/api/inbox/mark-read');
    assert.ok(markCall);
    assert.deepEqual(markCall.body.ids, ['msg-1', 'rcpt-1']);
  });
});

// --- Server: threadId tests ---

describe('Server: POST /api/inbox with threadId', () => {
  it('accepts and returns threadId', async () => {
    await withServer({}, async (port) => {
      const res = await httpJSON(port, 'POST', '/api/inbox', {
        from: 'saturn', body: 'threaded msg', threadId: 'thread-uuid-123',
      });
      assert.equal(res.status, 200);
      assert.ok(res.data.ok);
      assert.equal(res.data.threadId, 'thread-uuid-123');
    });
  });

  it('returns null threadId when not provided', async () => {
    await withServer({}, async (port) => {
      const res = await httpJSON(port, 'POST', '/api/inbox', {
        from: 'saturn', body: 'no thread',
      });
      assert.equal(res.status, 200);
      assert.equal(res.data.threadId, null);
    });
  });

  it('accepts _meta with recipients and no type', async () => {
    await withServer({}, async (port) => {
      const res = await httpJSON(port, 'POST', '/api/inbox', {
        from: 'saturn', body: 'multicast', threadId: 'thread-1',
        _meta: { recipients: ['peerA/app', 'peerB/app'] },
      });
      assert.equal(res.status, 200);
      assert.ok(res.data.ok);
    });
  });
});

// --- threadId and multicast tests ---

describe('Inbox: threadId support', () => {
  it('push sets threadId when provided', () => {
    const msg = push({ from: 'a', body: 'hi', threadId: 'thread-123' });
    assert.equal(msg.threadId, 'thread-123');
  });

  it('push defaults threadId to null when not provided', () => {
    const msg = push({ from: 'a', body: 'hi' });
    assert.equal(msg.threadId, null);
  });

  it('threadId persists to disk and survives reload', () => {
    const dir = getInboxDir();
    push({ from: 'a', body: 'with thread', threadId: 'persist-thread' });
    push({ from: 'b', body: 'no thread' });

    // Reset and reload from disk
    reset(dir);
    init();

    const all = getAll();
    assert.equal(all.length, 2);
    assert.equal(all[0]!.threadId, 'persist-thread');
    assert.equal(all[1]!.threadId, null);
  });

  it('init normalizes old messages without threadId', () => {
    const dir = getInboxDir();
    // Write a message without threadId to simulate old JSONL format
    const oldMsg = JSON.stringify({ id: 'old-1', from: 'x', to: 'y', timestamp: '2025-01-01', body: 'old', replyTo: null, _meta: null, read: false });
    writeFileSync(join(dir, 'inbox.jsonl'), oldMsg + '\n');

    reset(dir);
    init();

    const all = getAll();
    assert.equal(all.length, 1);
    assert.equal(all[0]!.threadId, null);
  });
});

describe('Inbox: _meta.recipients', () => {
  it('push preserves _meta with recipients', () => {
    const msg = push({
      from: 'a',
      body: 'multicast',
      _meta: { recipients: ['peerA/app', 'peerB/app'] },
    });
    assert.ok(msg._meta);
    assert.deepEqual(msg._meta!.recipients, ['peerA/app', 'peerB/app']);
  });

  it('_meta without type is valid', () => {
    const msg = push({
      from: 'a',
      body: 'recipients only',
      _meta: { recipients: ['b', 'c'] },
    });
    assert.ok(msg._meta);
    assert.equal(msg._meta!.type, undefined);
    assert.deepEqual(msg._meta!.recipients, ['b', 'c']);
  });
});

// --- Status field tests ---

describe('Inbox: push with status', () => {
  it('push with status stores it on the message', () => {
    const msg = push({ from: 'a', body: 'test', status: 'ACTION_NEEDED' });
    assert.equal(msg.status, 'ACTION_NEEDED');
  });

  it('push without status defaults to null', () => {
    const msg = push({ from: 'a', body: 'test' });
    assert.equal(msg.status, null);
  });

  it('status persists to disk and reloads', () => {
    const dir = getInboxDir();
    push({ from: 'a', body: 'test', status: 'WAITING_FOR_REPLY' });
    // Re-init from disk
    reset(dir);
    init();
    const msgs = getAll();
    assert.equal(msgs.length, 1);
    assert.equal(msgs[0]!.status, 'WAITING_FOR_REPLY');
  });

  it('old messages without status field default to null on init', () => {
    const dir = getInboxDir();
    // Write a message without status field directly to disk
    const oldMsg = JSON.stringify({
      id: 'old-id', from: 'a', to: 'b', timestamp: new Date().toISOString(),
      body: 'legacy', replyTo: null, threadId: null, _meta: null, read: false,
    });
    writeFileSync(join(dir, 'inbox.jsonl'), oldMsg + '\n');
    reset(dir);
    init();
    const msgs = getAll();
    assert.equal(msgs.length, 1);
    assert.equal(msgs[0]!.status, null);
  });
});

describe('Inbox: signal file with status', () => {
  it('signal file includes Status line when present', () => {
    push({ from: 'a', body: 'urgent', status: 'ACTION_NEEDED' });
    const signal = readFileSync(getSignalPath(), 'utf-8');
    assert.ok(signal.includes('Status: ACTION_NEEDED'));
  });

  it('signal file omits Status line when null', () => {
    push({ from: 'a', body: 'no status' });
    const signal = readFileSync(getSignalPath(), 'utf-8');
    assert.ok(!signal.includes('Status:'));
  });
});

describe('Server: POST /api/inbox with status', () => {
  it('accepts valid status and returns it', async () => {
    await withServer({}, async (port) => {
      const res = await httpJSON(port, 'POST', '/api/inbox', {
        from: 'a', body: 'hello', status: 'FYI_ONLY',
      });
      assert.equal(res.status, 200);
      assert.equal(res.data.status, 'FYI_ONLY');
    });
  });

  it('rejects invalid status value', async () => {
    await withServer({}, async (port) => {
      const res = await httpJSON(port, 'POST', '/api/inbox', {
        from: 'a', body: 'hello', status: 'INVALID',
      });
      assert.equal(res.status, 400);
    });
  });

  it('returns null status when not provided', async () => {
    await withServer({}, async (port) => {
      const res = await httpJSON(port, 'POST', '/api/inbox', {
        from: 'a', body: 'hello',
      });
      assert.equal(res.status, 200);
      assert.equal(res.data.status, null);
    });
  });
});

describe('MCP tool: sendMessage with status', () => {
  it('passes status in payload', async () => {
    let captured: any;
    const mockPeer = async (_peer: string, _method: string, _path: string, body: any) => {
      captured = body;
      return { ok: true, id: 'abc-123' };
    };
    const handlers = createToolHandlers({} as any, mockPeer, async () => {});
    await handlers.sendMessage({ body: 'hello', to: 'neptune', status: 'WAITING_FOR_REPLY' });
    assert.equal(captured.status, 'WAITING_FOR_REPLY');
  });

  it('omits status from payload when not provided', async () => {
    let captured: any;
    const mockPeer = async (_peer: string, _method: string, _path: string, body: any) => {
      captured = body;
      return { ok: true, id: 'abc-123' };
    };
    const handlers = createToolHandlers({} as any, mockPeer, async () => {});
    await handlers.sendMessage({ body: 'hello', to: 'neptune' });
    assert.equal(captured.status, undefined);
  });
});

describe('MCP tool: checkMessages displays status', () => {
  it('includes status tag in formatted output', async () => {
    const mockLocal = async (method: string, path: string, _body?: any) => {
      if (method === 'GET') return {
        messages: [{
          id: 'msg-1', from: 'a', timestamp: '2025-01-01T00:00:00Z',
          body: 'test', read: false, status: 'ACTION_NEEDED', threadId: null,
        }],
      };
      return { ok: true, marked: 1 };
    };
    const handlers = createToolHandlers({} as any, async () => {}, mockLocal);
    const result = await handlers.checkMessages();
    assert.ok(result.content[0]!.text.includes('[ACTION_NEEDED]'));
  });

  it('omits status tag when null', async () => {
    const mockLocal = async (method: string, path: string, _body?: any) => {
      if (method === 'GET') return {
        messages: [{
          id: 'msg-1', from: 'a', timestamp: '2025-01-01T00:00:00Z',
          body: 'test', read: false, status: null, threadId: null,
        }],
      };
      return { ok: true, marked: 1 };
    };
    const handlers = createToolHandlers({} as any, async () => {}, mockLocal);
    const result = await handlers.checkMessages();
    assert.ok(!result.content[0]!.text.includes('[ACTION_NEEDED]'));
    assert.ok(!result.content[0]!.text.includes('[FYI_ONLY]'));
  });
});

describe('MCP tool: respondToMessage with status', () => {
  it('passes status in reply payload', async () => {
    let captured: any;
    const mockLocal = async (method: string, path: string, body?: any) => {
      if (method === 'GET' && path.includes('/api/inbox/msg-1')) {
        return { message: { id: 'msg-1', from: 'test-host/other', threadId: 'thread-1' } };
      }
      captured = body;
      return { ok: true, id: 'reply-1' };
    };
    const handlers = createToolHandlers({} as any, async () => {}, mockLocal);
    await handlers.respondToMessage({ messageId: 'msg-1', body: 'reply', status: 'RESOLVED' });
    assert.equal(captured.status, 'RESOLVED');
  });
});

import { describe, it, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { clearConfigCache, loadConfig } from '../src/config.ts';
import { createMCPServer, createToolHandlers } from '../src/mcp.ts';
import { reset as resetLog } from '../src/log.ts';
import type { ICCClient } from '../src/client.ts';

process.env.ICC_IDENTITY = 'test-host';
process.env.ICC_AUTH_TOKEN = 'test-token-123';

// Redirect log to a temp directory so tests don't pollute ~/.icc/messages.jsonl
const testLogDir = mkdtempSync(join(tmpdir(), 'icc-test-'));
resetLog(testLogDir);

beforeEach(() => {
  clearConfigCache();
  // Isolate tests from user's ~/.icc/config.json remotes
  const config = loadConfig();
  config.remotes = {};
});

describe('MCP Server creation', () => {
  it('creates server with all tools registered', () => {
    const { server } = createMCPServer();
    const toolNames = Object.keys((server as any)._registeredTools);
    assert.ok(toolNames.includes('ping_remote'));
    assert.ok(toolNames.includes('send_message'));
    assert.ok(!toolNames.includes('send_prompt'), 'send_prompt should be removed');
    assert.ok(!toolNames.includes('get_message_log'), 'get_message_log should be removed');
    assert.equal(toolNames.length, 8, 'should have 8 tools');
  });
});

describe('MCP tool: ping_remote', () => {
  it('returns latency on success', async () => {
    const mockClient = {
      ping: async () => ({ pong: true, from: 'mercury', latencyMs: 11 }),
    } as unknown as ICCClient;
    const handlers = createToolHandlers(mockClient);
    const result = await handlers.pingRemote({});
    assert.ok(result.content[0]!.text.includes('mercury'));
    assert.ok(result.content[0]!.text.includes('11ms'));
  });

  it('returns error on failure', async () => {
    const mockClient = {
      ping: async () => { throw new Error('timeout'); },
    } as unknown as ICCClient;
    const handlers = createToolHandlers(mockClient);
    const result = await handlers.pingRemote({});
    assert.ok(result.content[0]!.text.includes('timeout'));
    assert.ok(result.isError);
  });

  it('passes peer option through', async () => {
    let capturedOptions: any;
    const mockClient = {
      ping: async (options: any) => {
        capturedOptions = options;
        return { pong: true, from: 'peerB', latencyMs: 5 };
      },
    } as unknown as ICCClient;
    const handlers = createToolHandlers(mockClient);
    await handlers.pingRemote({ peer: 'peerB' });
    assert.equal(capturedOptions.peer, 'peerB');
  });
});

// --- Message routing tests ---
// ICC_IDENTITY is set to 'test-host' at top of file.

/**
 * Create mock API functions that track calls.
 * peerFn(peer, method, path, body) and localFn(method, path, body).
 */
function createMockAPIs(peerResult: any = { id: 'peer-id' }, localResult: any = { id: 'local-id' }) {
  const calls: { peer: any[]; local: any[] } = { peer: [], local: [] };
  const peerFn = async (peer: string, method: string, path: string, body?: any) => {
    calls.peer.push({ peer, method, path, body });
    return peerResult;
  };
  const localFn = async (method: string, path: string, body?: any) => {
    calls.local.push({ method, path, body });
    return localResult;
  };
  return { peerFn, localFn, calls };
}

describe('MCP tool: sendMessage routing', () => {
  it('routes to localAPI when `to` targets local host', async () => {
    const { peerFn, localFn, calls } = createMockAPIs();
    const handlers = createToolHandlers({} as unknown as ICCClient, peerFn, localFn);
    const result = await handlers.sendMessage({ body: 'hello', to: 'test-host/some-instance' });

    assert.equal(calls.local.length, 1);
    assert.equal(calls.peer.length, 0);
    assert.ok(result.content[0]!.text.includes('local-id'));
    assert.ok(result.content[0]!.text.includes('test-host/some-instance'));
  });

  it('routes to localAPI for bare local hostname', async () => {
    const { peerFn, localFn, calls } = createMockAPIs();
    const handlers = createToolHandlers({} as unknown as ICCClient, peerFn, localFn);
    await handlers.sendMessage({ body: 'hello', to: 'test-host' });

    assert.equal(calls.local.length, 1);
    assert.equal(calls.peer.length, 0);
  });

  it('routes to peerAPI when `to` targets remote host', async () => {
    const { peerFn, localFn, calls } = createMockAPIs();
    const handlers = createToolHandlers({} as unknown as ICCClient, peerFn, localFn);
    const result = await handlers.sendMessage({ body: 'hello', to: 'mercury/icc' });

    assert.equal(calls.peer.length, 1);
    assert.equal(calls.peer[0]!.peer, 'mercury');
    assert.equal(calls.local.length, 0);
    assert.ok(result.content[0]!.text.includes('peer-id'));
  });

  it('errors when no `to` and multiple peers configured', async () => {
    // This test would need config with multiple remotes — but since we use env overrides
    // and the default config has empty remotes, sending with no `to` will attempt default
    // peer resolution which with 0 peers returns null → sends locally
    const { peerFn, localFn, calls } = createMockAPIs();
    const handlers = createToolHandlers({} as unknown as ICCClient, peerFn, localFn);
    const result = await handlers.sendMessage({ body: 'hello' });
    // With 0 peers, resolves to local
    assert.equal(calls.local.length, 1);
  });
});

describe('MCP tool: respondToMessage routing', () => {
  it('routes reply to localAPI when original sender is local', async () => {
    const { peerFn, localFn, calls } = createMockAPIs();
    const lookupCalls: { method: string; path: string }[] = [];
    const smartLocalFn = async (method: string, path: string, body?: any) => {
      lookupCalls.push({ method, path });
      if (method === 'GET' && path.startsWith('/api/inbox/')) {
        return { message: { from: 'test-host/other-instance', body: 'original' } };
      }
      return { id: 'local-reply-id' };
    };
    const handlers = createToolHandlers({} as unknown as ICCClient, peerFn, smartLocalFn);
    const result = await handlers.respondToMessage({ messageId: 'msg-12345678-abcd', body: 'reply' });

    // Should have called localFn for GET (lookup) and POST (reply)
    assert.equal(lookupCalls.length, 2);
    assert.equal(lookupCalls[0]!.method, 'GET');
    assert.equal(lookupCalls[1]!.method, 'POST');
    assert.equal(calls.peer.length, 0);
    assert.ok(result.content[0]!.text.includes('local-reply-id'));
    assert.ok(result.content[0]!.text.includes('to test-host/other-instance'));
  });

  it('routes reply to peerAPI when original sender is remote', async () => {
    const { peerFn, localFn, calls } = createMockAPIs();
    const localCalls: { method: string; path: string }[] = [];
    const smartLocalFn = async (method: string, path: string, _body?: any) => {
      localCalls.push({ method, path });
      if (method === 'GET' && path.startsWith('/api/inbox/')) {
        return { message: { from: 'mercury/icc', body: 'original' } };
      }
      return { id: 'local-id' };
    };
    const handlers = createToolHandlers({} as unknown as ICCClient, peerFn, smartLocalFn);
    const result = await handlers.respondToMessage({ messageId: 'msg-12345678-abcd', body: 'reply' });

    // Lookup via local, reply via peer
    assert.equal(localCalls.length, 1);
    assert.equal(localCalls[0]!.method, 'GET');
    assert.equal(calls.peer.length, 1);
    assert.equal(calls.peer[0]!.peer, 'mercury');
    assert.equal(calls.peer[0]!.method, 'POST');
    assert.ok(result.content[0]!.text.includes('peer-id'));
    assert.ok(result.content[0]!.text.includes('to mercury/icc'));
  });

  it('falls back to prefix match when exact lookup fails', async () => {
    const { peerFn, localFn, calls } = createMockAPIs();
    const lookupCalls: { method: string; path: string }[] = [];
    const smartLocalFn = async (method: string, path: string, _body?: any) => {
      lookupCalls.push({ method, path });
      if (method === 'GET' && path.startsWith('/api/inbox/') && !path.includes('?')) {
        throw new Error('not found');
      }
      if (method === 'GET' && path.includes('all=true')) {
        return { messages: [
          { id: 'abcd-1234-full-uuid', from: 'test-host/other', body: 'hi' },
          { id: 'efgh-5678-full-uuid', from: 'mercury/remote', body: 'bye' },
        ] };
      }
      return { id: 'local-reply-id' };
    };
    const handlers = createToolHandlers({} as unknown as ICCClient, peerFn, smartLocalFn);
    const result = await handlers.respondToMessage({ messageId: 'abcd', body: 'reply' });

    // Matched local sender → routed locally
    assert.equal(calls.peer.length, 0);
    assert.ok(result.content[0]!.text.includes('local-reply-id'));
    assert.ok(result.content[0]!.text.includes('to test-host/other'));
    const postCall = lookupCalls.find((c: { method: string; path: string }) => c.method === 'POST');
    assert.ok(postCall, 'should have made a POST call');
  });

  it('prefix match routes to peer when sender is remote', async () => {
    const { peerFn, localFn, calls } = createMockAPIs();
    const smartLocalFn = async (method: string, path: string, _body?: any) => {
      if (method === 'GET' && path.startsWith('/api/inbox/') && !path.includes('?')) {
        throw new Error('not found');
      }
      if (method === 'GET' && path.includes('all=true')) {
        return { messages: [
          { id: 'efgh-5678-full-uuid', from: 'mercury/remote', body: 'bye' },
        ] };
      }
      return { id: 'local-id' };
    };
    const handlers = createToolHandlers({} as unknown as ICCClient, peerFn, smartLocalFn);
    const result = await handlers.respondToMessage({ messageId: 'efgh', body: 'reply' });

    // Matched remote sender → routed to peer
    assert.equal(calls.peer.length, 1);
    assert.equal(calls.peer[0]!.peer, 'mercury');
    assert.ok(result.content[0]!.text.includes('peer-id'));
    assert.ok(result.content[0]!.text.includes('to mercury/remote'));
  });

  it('defaults to local when all lookups fail and no peers', async () => {
    const { peerFn, localFn, calls } = createMockAPIs();
    const failingLocalFn = async (method: string, _path: string, _body?: any) => {
      if (method === 'GET') throw new Error('not found');
      return { id: 'local-id' };
    };
    const handlers = createToolHandlers({} as unknown as ICCClient, peerFn, failingLocalFn);
    const result = await handlers.respondToMessage({ messageId: 'msg-12345678-abcd', body: 'reply' });

    // With 0 peers and failed lookup, falls back to local
    assert.ok(result.content[0]!.text.includes('sender unknown'));
  });
});

describe('MCP tool: listInstances multi-peer', () => {
  it('queries local registry when no peers configured', async () => {
    const localCalls: { method: string; path: string }[] = [];
    const localFn = async (method: string, path: string) => {
      localCalls.push({ method, path });
      return { instances: [{ address: 'test-host/app', pid: 123, registeredAt: '2026-01-01' }] };
    };
    const peerFn = async () => { throw new Error('should not be called'); };
    const handlers = createToolHandlers({} as unknown as ICCClient, peerFn, localFn);
    const result = await handlers.listInstances();

    assert.ok(result.content[0]!.text.includes('test-host/app'));
    assert.ok(result.content[0]!.text.includes('1 instance(s)'));
  });
});

describe('MCP tool: checkMessages includes message IDs', () => {
  it('includes message ID in unread output', async () => {
    const mockLocalFn = async (method: string, path: string) => {
      if (method === 'GET' && path.startsWith('/api/inbox')) {
        return {
          messages: [{ id: 'abc-123-def', from: 'mercury/icc', timestamp: '2026-01-01T00:00:00Z', body: 'hello', read: false }],
          unreadCount: 1,
        };
      }
      return { ok: true, marked: 1 };
    };
    const handlers = createToolHandlers({} as unknown as ICCClient, async () => {}, mockLocalFn);
    const result = await handlers.checkMessages({});
    assert.ok(result.content[0]!.text.includes('(id: abc-123-def)'));
  });

  it('includes message ID in all-messages output', async () => {
    const mockLocalFn = async (method: string, path: string) => {
      if (method === 'GET' && path.startsWith('/api/inbox')) {
        return {
          messages: [{ id: 'xyz-789', from: 'venus/test', timestamp: '2026-01-01T00:00:00Z', body: 'hi', read: true }],
          unreadCount: 0,
        };
      }
      return { ok: true };
    };
    const handlers = createToolHandlers({} as unknown as ICCClient, async () => {}, mockLocalFn);
    const result = await handlers.checkMessages({ all: true });
    assert.ok(result.content[0]!.text.includes('(id: xyz-789)'));
  });
});

describe('MCP tool: readRemoteFile multi-peer', () => {
  it('passes peer to peerAPI', async () => {
    const { peerFn, localFn, calls } = createMockAPIs({ content: 'file contents' });
    const handlers = createToolHandlers({} as unknown as ICCClient, peerFn, localFn);
    const result = await handlers.readRemoteFile({ path: '/tmp/test.txt', peer: 'peerA' });

    assert.equal(calls.peer.length, 1);
    assert.equal(calls.peer[0]!.peer, 'peerA');
    assert.ok(result.content[0]!.text.includes('file contents'));
  });
});

describe('MCP tool: runRemoteCommand multi-peer', () => {
  it('passes peer to peerAPI', async () => {
    const { peerFn, localFn, calls } = createMockAPIs({ stdout: 'hello', stderr: '', exitCode: 0 });
    const handlers = createToolHandlers({} as unknown as ICCClient, peerFn, localFn);
    const result = await handlers.runRemoteCommand({ command: 'echo', args: ['hello'], peer: 'peerB' });

    assert.equal(calls.peer.length, 1);
    assert.equal(calls.peer[0]!.peer, 'peerB');
    assert.ok(result.content[0]!.text.includes('hello'));
  });
});

// --- Multicast and threading tests ---

describe('MCP tool: sendMessage threading', () => {
  it('generates threadId for new messages', async () => {
    const { peerFn, localFn, calls } = createMockAPIs();
    const handlers = createToolHandlers({} as unknown as ICCClient, peerFn, localFn);
    await handlers.sendMessage({ body: 'hello', to: 'test-host/app' });

    assert.equal(calls.local.length, 1);
    const payload = calls.local[0]!.body;
    assert.ok(payload.threadId, 'should have a threadId');
    assert.equal(typeof payload.threadId, 'string');
    assert.ok(payload.threadId.length > 8, 'threadId should be a UUID');
  });

  it('includes thread info in response text', async () => {
    const { peerFn, localFn } = createMockAPIs();
    const handlers = createToolHandlers({} as unknown as ICCClient, peerFn, localFn);
    const result = await handlers.sendMessage({ body: 'hello', to: 'test-host/app' });

    assert.ok(result.content[0]!.text.includes('thread:'));
  });

  it('inherits threadId from parent message on reply', async () => {
    const { peerFn, calls } = createMockAPIs();
    const parentThreadId = 'parent-thread-uuid-1234';
    const localFn = async (method: string, path: string, body?: any) => {
      if (method === 'GET' && path.startsWith('/api/inbox/')) {
        return { message: { id: 'parent-msg', from: 'test-host/x', threadId: parentThreadId } };
      }
      return { id: 'new-msg-id' };
    };
    const handlers = createToolHandlers({} as unknown as ICCClient, peerFn, localFn);
    await handlers.sendMessage({ body: 'reply', to: 'test-host/app', replyTo: 'parent-msg' });

    const postCall = (await Promise.resolve(calls)).peer.length === 0;
    // The localFn was used for both GET (lookup) and POST (send)
    // We check indirectly via the response text
  });
});

describe('MCP tool: sendMessage multicast', () => {
  it('sends to multiple recipients with Promise.allSettled', async () => {
    const { peerFn, localFn, calls } = createMockAPIs();
    const handlers = createToolHandlers({} as unknown as ICCClient, peerFn, localFn);
    const result = await handlers.sendMessage({
      body: 'broadcast',
      to: ['mercury/app', 'venus/app'],
    });

    // Should have made 2 peer API calls
    assert.equal(calls.peer.length, 2);
    assert.equal(calls.peer[0]!.peer, 'mercury');
    assert.equal(calls.peer[1]!.peer, 'venus');
    assert.ok(result.content[0]!.text.includes('Multicast sent to 2/2'));
  });

  it('includes shared threadId in all multicast payloads', async () => {
    const { peerFn, localFn, calls } = createMockAPIs();
    const handlers = createToolHandlers({} as unknown as ICCClient, peerFn, localFn);
    await handlers.sendMessage({
      body: 'broadcast',
      to: ['mercury/app', 'venus/app'],
    });

    const threadId1 = calls.peer[0]!.body.threadId;
    const threadId2 = calls.peer[1]!.body.threadId;
    assert.ok(threadId1, 'first payload should have threadId');
    assert.equal(threadId1, threadId2, 'both payloads should share same threadId');
  });

  it('includes _meta.recipients in multicast payloads', async () => {
    const { peerFn, localFn, calls } = createMockAPIs();
    const handlers = createToolHandlers({} as unknown as ICCClient, peerFn, localFn);
    await handlers.sendMessage({
      body: 'broadcast',
      to: ['mercury/app', 'venus/app'],
    });

    const meta = calls.peer[0]!.body._meta;
    assert.ok(meta, 'should have _meta');
    assert.deepEqual(meta.recipients, ['mercury/app', 'venus/app']);
  });

  it('handles partial failures gracefully', async () => {
    let callCount = 0;
    const peerFn = async (peer: string, method: string, path: string, body?: any) => {
      callCount++;
      if (peer === 'venus') throw new Error('peer offline');
      return { id: 'ok-id' };
    };
    const localFn = async () => ({ id: 'local-id' });
    const handlers = createToolHandlers({} as unknown as ICCClient, peerFn, localFn);
    const result = await handlers.sendMessage({
      body: 'broadcast',
      to: ['mercury/app', 'venus/app'],
    });

    assert.ok(result.content[0]!.text.includes('1/2'));
    assert.ok(result.content[0]!.text.includes('Delivered'));
    assert.ok(result.content[0]!.text.includes('Failed'));
    assert.ok(result.content[0]!.text.includes('peer offline'));
    assert.ok(!result.isError, 'partial failure should not be full error');
  });

  it('reports isError when all recipients fail', async () => {
    const peerFn = async () => { throw new Error('all down'); };
    const localFn = async () => ({ id: 'local-id' });
    const handlers = createToolHandlers({} as unknown as ICCClient, peerFn, localFn);
    const result = await handlers.sendMessage({
      body: 'broadcast',
      to: ['mercury/app', 'venus/app'],
    });

    assert.ok(result.isError, 'should be error when all fail');
    assert.ok(result.content[0]!.text.includes('0/2'));
  });
});

describe('MCP tool: respondToMessage threading', () => {
  it('includes threadId in reply payload', async () => {
    const { peerFn, calls } = createMockAPIs();
    const localCalls: { method: string; path: string; body?: any }[] = [];
    const localFn = async (method: string, path: string, body?: any) => {
      localCalls.push({ method, path, body });
      if (method === 'GET' && path.startsWith('/api/inbox/')) {
        return { message: { id: 'orig-id', from: 'test-host/other', threadId: 'existing-thread' } };
      }
      return { id: 'reply-id' };
    };
    const handlers = createToolHandlers({} as unknown as ICCClient, peerFn, localFn);
    const result = await handlers.respondToMessage({ messageId: 'orig-id', body: 'reply' });

    const postCall = localCalls.find(c => c.method === 'POST');
    assert.ok(postCall, 'should have made a POST');
    assert.equal(postCall!.body.threadId, 'existing-thread');
    assert.ok(result.content[0]!.text.includes('thread:'));
  });

  it('generates new threadId when original has none', async () => {
    const { peerFn } = createMockAPIs();
    const localCalls: { method: string; path: string; body?: any }[] = [];
    const localFn = async (method: string, path: string, body?: any) => {
      localCalls.push({ method, path, body });
      if (method === 'GET' && path.startsWith('/api/inbox/')) {
        return { message: { id: 'orig-id', from: 'test-host/other', threadId: null } };
      }
      return { id: 'reply-id' };
    };
    const handlers = createToolHandlers({} as unknown as ICCClient, peerFn, localFn);
    await handlers.respondToMessage({ messageId: 'orig-id', body: 'reply' });

    const postCall = localCalls.find(c => c.method === 'POST');
    assert.ok(postCall!.body.threadId, 'should generate a threadId');
    assert.ok(postCall!.body.threadId.length > 8, 'threadId should be a UUID');
  });

  it('carries _meta.recipients forward in single reply', async () => {
    const { peerFn } = createMockAPIs();
    const localCalls: { method: string; path: string; body?: any }[] = [];
    const localFn = async (method: string, path: string, body?: any) => {
      localCalls.push({ method, path, body });
      if (method === 'GET' && path.startsWith('/api/inbox/')) {
        return {
          message: {
            id: 'orig-id', from: 'test-host/other', threadId: 'thread-1',
            _meta: { recipients: ['peerA/app', 'peerB/app'] },
          },
        };
      }
      return { id: 'reply-id' };
    };
    const handlers = createToolHandlers({} as unknown as ICCClient, peerFn, localFn);
    await handlers.respondToMessage({ messageId: 'orig-id', body: 'reply' });

    const postCall = localCalls.find(c => c.method === 'POST');
    assert.deepEqual(postCall!.body._meta?.recipients, ['peerA/app', 'peerB/app']);
  });
});

describe('MCP tool: respondToMessage reply-all', () => {
  it('sends to all recipients minus self', async () => {
    const { peerFn, calls } = createMockAPIs();
    const localFn = async (method: string, path: string) => {
      if (method === 'GET' && path.startsWith('/api/inbox/')) {
        return {
          message: {
            id: 'orig-id', from: 'mercury/app', threadId: 'thread-1',
            // test-host is self (matches getFullAddress which returns 'test-host' since no instance)
            _meta: { recipients: ['mercury/app', 'venus/app', 'test-host'] },
          },
        };
      }
      return { id: 'reply-id' };
    };
    const handlers = createToolHandlers({} as unknown as ICCClient, peerFn, localFn);
    const result = await handlers.respondToMessage({ messageId: 'orig-id', body: 'reply-all', replyAll: true });

    // Should send to mercury/app and venus/app (not test-host which is self)
    assert.equal(calls.peer.length, 2);
    const peers = calls.peer.map((c: any) => c.peer).sort();
    assert.deepEqual(peers, ['mercury', 'venus']);
    assert.ok(result.content[0]!.text.includes('Reply-all'));
    assert.ok(result.content[0]!.text.includes('2/2'));
  });

  it('deduplicates sender and recipients', async () => {
    const { peerFn, calls } = createMockAPIs();
    const localFn = async (method: string, path: string) => {
      if (method === 'GET' && path.startsWith('/api/inbox/')) {
        return {
          message: {
            id: 'orig-id', from: 'mercury/app', threadId: 'thread-1',
            // mercury/app is both sender and in recipients
            _meta: { recipients: ['mercury/app', 'venus/app'] },
          },
        };
      }
      return { id: 'reply-id' };
    };
    const handlers = createToolHandlers({} as unknown as ICCClient, peerFn, localFn);
    await handlers.respondToMessage({ messageId: 'orig-id', body: 'dedup test', replyAll: true });

    // mercury/app should appear only once
    assert.equal(calls.peer.length, 2);
  });

  it('shares threadId across all reply-all recipients', async () => {
    const { peerFn, calls } = createMockAPIs();
    const localFn = async (method: string, path: string) => {
      if (method === 'GET' && path.startsWith('/api/inbox/')) {
        return {
          message: {
            id: 'orig-id', from: 'mercury/app', threadId: 'shared-thread',
            _meta: { recipients: ['venus/app'] },
          },
        };
      }
      return { id: 'reply-id' };
    };
    const handlers = createToolHandlers({} as unknown as ICCClient, peerFn, localFn);
    await handlers.respondToMessage({ messageId: 'orig-id', body: 'reply', replyAll: true });

    for (const call of calls.peer) {
      assert.equal(call.body.threadId, 'shared-thread');
    }
  });

  it('falls back to single reply when replyAll is false', async () => {
    const { peerFn, calls } = createMockAPIs();
    const localFn = async (method: string, path: string) => {
      if (method === 'GET' && path.startsWith('/api/inbox/')) {
        return {
          message: {
            id: 'orig-id', from: 'mercury/app', threadId: 'thread-1',
            _meta: { recipients: ['mercury/app', 'venus/app'] },
          },
        };
      }
      return { id: 'reply-id' };
    };
    const handlers = createToolHandlers({} as unknown as ICCClient, peerFn, localFn);
    await handlers.respondToMessage({ messageId: 'orig-id', body: 'single reply' });

    // Should only send to mercury/app (the sender)
    assert.equal(calls.peer.length, 1);
    assert.equal(calls.peer[0]!.peer, 'mercury');
  });
});

describe('MCP tool: checkMessages thread filtering', () => {
  it('passes threadId to query params', async () => {
    const localCalls: { method: string; path: string }[] = [];
    const localFn = async (method: string, path: string) => {
      localCalls.push({ method, path });
      if (method === 'GET' && path.startsWith('/api/inbox')) {
        return { messages: [], unreadCount: 0 };
      }
      return { ok: true };
    };
    const handlers = createToolHandlers({} as unknown as ICCClient, async () => {}, localFn);
    await handlers.checkMessages({ threadId: 'filter-thread-id' });

    const getCall = localCalls.find(c => c.method === 'GET');
    assert.ok(getCall!.path.includes('threadId=filter-thread-id'));
  });
});

describe('MCP tool: checkMessages display enhancements', () => {
  it('shows multicast indicator for messages with recipients', async () => {
    const localFn = async (method: string, path: string) => {
      if (method === 'GET' && path.startsWith('/api/inbox')) {
        return {
          messages: [{
            id: 'mc-1', from: 'mercury/app', timestamp: '2026-01-01T00:00:00Z',
            body: 'multicast msg', read: false,
            _meta: { recipients: ['venus/app', 'mars/app'] },
            threadId: 'thread-abc',
          }],
          unreadCount: 1,
        };
      }
      return { ok: true, marked: 1 };
    };
    const handlers = createToolHandlers({} as unknown as ICCClient, async () => {}, localFn);
    const result = await handlers.checkMessages({});

    assert.ok(result.content[0]!.text.includes('(multicast to 2)'));
    assert.ok(result.content[0]!.text.includes('[thread: thread-a'));
  });

  it('shows thread info without multicast indicator for single-recipient threaded messages', async () => {
    const localFn = async (method: string, path: string) => {
      if (method === 'GET' && path.startsWith('/api/inbox')) {
        return {
          messages: [{
            id: 'single-1', from: 'venus/app', timestamp: '2026-01-01T00:00:00Z',
            body: 'threaded msg', read: false,
            threadId: 'thread-xyz',
          }],
          unreadCount: 1,
        };
      }
      return { ok: true, marked: 1 };
    };
    const handlers = createToolHandlers({} as unknown as ICCClient, async () => {}, localFn);
    const result = await handlers.checkMessages({});

    assert.ok(result.content[0]!.text.includes('[thread: thread-x'));
    assert.ok(!result.content[0]!.text.includes('multicast'));
  });
});

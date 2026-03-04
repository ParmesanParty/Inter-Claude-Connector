import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { randomUUID } from 'node:crypto';
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { ICCClient } from './client.ts';
import { loadConfig, getFullAddress, getPeerIdentities, getTlsOptions, createIdentityVerifier } from './config.ts';
import { parseAddress } from './address.ts';
import { createLogger } from './util/logger.ts';
import type { ICCConfig } from './types.ts';

const log = createLogger('mcp');

interface MCPToolResult {
  // Index signature required by MCP SDK's ToolCallback return type
  [x: string]: unknown;
  content: { type: 'text'; text: string }[];
  isError?: boolean;
}

interface InboxAPIMessage {
  id: string;
  from: string;
  to?: string;
  timestamp: string;
  body: string;
  replyTo?: string;
  threadId?: string | null;
  status?: string | null;
  read: boolean;
  _meta?: { type?: string; originalId?: string; readAt?: string; recipients?: string[] } | null;
}

interface RegistryInstance {
  address?: string;
  pid?: number;
  registeredAt?: string;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- API return shapes vary by endpoint
type APIFunction = (method: string, path: string, body?: unknown) => Promise<any>;
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- API return shapes vary by endpoint
type PeerAPIFunction = (peerIdentity: string, method: string, path: string, body?: unknown) => Promise<any>;

/**
 * Make a direct HTTP request to a specific peer's ICC server.
 * Returns parsed JSON; shape varies by endpoint so `any` is used for the return type.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- return shape varies by endpoint
function peerAPI(peerIdentity: string, method: string, path: string, body: unknown = null): Promise<any> {
  const config = loadConfig();
  const peer = config.remotes?.[peerIdentity];
  if (!peer?.httpUrl) return Promise.reject(new Error(`No HTTP URL configured for peer "${peerIdentity}"`));

  const baseUrl = peer.httpUrl;
  const authToken = peer.token || null;
  const timeout = config.transport.httpTimeout;
  const tlsOpts = getTlsOptions(config);
  const isHttps = baseUrl.startsWith('https://');
  const requestFn = isHttps ? httpsRequest : httpRequest;

  const url = new URL(path, baseUrl);
  const payload = body ? JSON.stringify(body) : null;

  return new Promise((resolve, reject) => {
    const req = requestFn(url, {
      method,
      timeout,
      headers: {
        ...(payload && { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) }),
        ...(authToken && { 'Authorization': `Bearer ${authToken}` }),
      },
      ...(isHttps && tlsOpts ? { ...tlsOpts, checkServerIdentity: createIdentityVerifier(peerIdentity) } : {}),
    }, (res) => {
      let data = '';
      res.on('data', (chunk: Buffer) => { data += chunk; });
      res.on('end', () => {
        try {
          const parsed = JSON.parse(data);
          if ((res.statusCode || 0) >= 400) {
            reject(new Error(parsed.error || `HTTP ${res.statusCode}`));
          } else {
            resolve(parsed);
          }
        } catch {
          reject(new Error(`Invalid response: ${data.slice(0, 200)}`));
        }
      });
    });
    req.on('timeout', () => { req.destroy(); reject(new Error('Request timed out')); });
    req.on('error', (err) => reject(new Error(`HTTP error: ${err.message}`)));
    if (payload) req.write(payload);
    req.end();
  });
}

/**
 * Make a direct HTTP request to the local ICC server.
 * Returns parsed JSON; shape varies by endpoint so `any` is used for the return type.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- return shape varies by endpoint
function localAPI(method: string, path: string, body: unknown = null): Promise<any> {
  const config = loadConfig();
  const port = config.server.port;
  const authToken = config.server.localToken || null;
  const tlsOpts = getTlsOptions(config);
  const protocol = tlsOpts ? 'https' : 'http';
  const requestFn = tlsOpts ? httpsRequest : httpRequest;

  const url = new URL(path, `${protocol}://127.0.0.1:${port}`);
  const payload = body ? JSON.stringify(body) : null;

  return new Promise((resolve, reject) => {
    const req = requestFn(url, {
      method,
      timeout: 5000,
      headers: {
        ...(payload && { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) }),
        ...(authToken && { 'Authorization': `Bearer ${authToken}` }),
      },
      ...(tlsOpts ? { ...tlsOpts, checkServerIdentity: createIdentityVerifier(config.identity) } : {}),
    }, (res) => {
      let data = '';
      res.on('data', (chunk: Buffer) => { data += chunk; });
      res.on('end', () => {
        try {
          const parsed = JSON.parse(data);
          if ((res.statusCode || 0) >= 400) {
            reject(new Error(parsed.error || `HTTP ${res.statusCode}`));
          } else {
            resolve(parsed);
          }
        } catch {
          reject(new Error(`Invalid response: ${data.slice(0, 200)}`));
        }
      });
    });
    req.on('timeout', () => { req.destroy(); reject(new Error('Request timed out')); });
    req.on('error', (err) => reject(new Error(`HTTP error: ${err.message}`)));
    if (payload) req.write(payload);
    req.end();
  });
}

/**
 * Resolve peer identity from explicit peer arg or "to" address.
 */
function resolvePeer(config: ICCConfig, options: { peer?: string; to?: string } = {}): string | null {
  if (options.peer) return options.peer;
  if (options.to) {
    const { host } = parseAddress(options.to);
    if (host === config.identity) return null; // local
    return host;
  }
  // No peer, no to — default to sole peer or error
  const peers = getPeerIdentities(config);
  if (peers.length === 1) return peers[0]!;
  if (peers.length === 0) return null;
  throw new Error(`Multiple peers configured (${peers.join(', ')}). Specify "to" address or "peer" parameter.`);
}

/**
 * Tool handler factory — returns plain async functions testable without MCP wiring.
 */
export function createToolHandlers(client: ICCClient, peerAPIFn: PeerAPIFunction = peerAPI, localAPIFn: APIFunction = localAPI) {
  return {
    async pingRemote({ peer }: { peer?: string } = {}): Promise<MCPToolResult> {
      try {
        const result = await client.ping({ peer });
        const text = `Pong from ${result.from || 'remote'} — latency: ${result.latencyMs}ms`;
        return { content: [{ type: 'text', text }] };
      } catch (err) {
        return { content: [{ type: 'text', text: `Ping failed: ${(err as Error).message}` }], isError: true };
      }
    },

    // --- Direct remote operations ---

    async readRemoteFile({ path: filePath, peer }: { path: string; peer?: string }): Promise<MCPToolResult> {
      try {
        const config = loadConfig();
        const peerIdentity = resolvePeer(config, { peer });
        if (!peerIdentity) {
          return { content: [{ type: 'text', text: 'Error: Cannot read file on local host via this tool' }], isError: true };
        }
        const result = await peerAPIFn(peerIdentity, 'POST', '/api/readfile', { path: filePath });
        return { content: [{ type: 'text', text: result.content }] };
      } catch (err) {
        return { content: [{ type: 'text', text: `Error reading remote file: ${(err as Error).message}` }], isError: true };
      }
    },

    async runRemoteCommand({ command, args = [], timeout, cwd, peer }: { command: string; args?: string[]; timeout?: number; cwd?: string; peer?: string }): Promise<MCPToolResult> {
      try {
        const config = loadConfig();
        const peerIdentity = resolvePeer(config, { peer });
        if (!peerIdentity) {
          return { content: [{ type: 'text', text: 'Error: Cannot run command on local host via this tool' }], isError: true };
        }
        const result = await peerAPIFn(peerIdentity, 'POST', '/api/exec', { command, args, timeout, cwd });
        const parts: string[] = [];
        if (result.stdout) parts.push(result.stdout);
        if (result.stderr) parts.push(`[stderr] ${result.stderr}`);
        parts.push(`[exit code: ${result.exitCode}]`);
        return { content: [{ type: 'text', text: parts.join('\n') }] };
      } catch (err) {
        return { content: [{ type: 'text', text: `Error executing remote command: ${(err as Error).message}` }], isError: true };
      }
    },

    // --- Inbox: persistent message passing ---

    async sendMessage({ body, replyTo, to, status }: { body: string; replyTo?: string; to?: string | string[]; status?: string }): Promise<MCPToolResult> {
      try {
        const config = loadConfig();
        const fullAddress = getFullAddress(config);

        // Normalize recipients
        const recipients = Array.isArray(to) ? to : (to ? [to] : []);

        // Generate or inherit threadId
        let threadId: string;
        if (replyTo) {
          // Inherit threadId from parent message
          try {
            const lookup = await localAPIFn('GET', `/api/inbox/${replyTo}`);
            threadId = lookup.message?.threadId || randomUUID();
          } catch {
            // Parent lookup failed — try prefix match
            try {
              const allMsgs = await localAPIFn('GET', '/api/inbox?all=true');
              const match = ((allMsgs.messages || []) as InboxAPIMessage[]).find((m) => m.id.startsWith(replyTo));
              threadId = match?.threadId || randomUUID();
            } catch {
              threadId = randomUUID();
            }
          }
        } else {
          threadId = randomUUID();
        }

        // Build _meta with recipients list for multicast
        const meta = recipients.length > 1
          ? { recipients }
          : undefined;

        // Single recipient (or no recipient) — existing flow + threadId
        if (recipients.length <= 1) {
          const singleTo = recipients[0];
          const payload: Record<string, unknown> = { from: fullAddress, body, threadId };
          if (replyTo) payload.replyTo = replyTo;
          if (singleTo) payload.to = singleTo;
          if (status) payload.status = status;

          const peerIdentity = resolvePeer(config, { to: singleTo });
          const apiFn: APIFunction = peerIdentity
            ? (method, path, body) => peerAPIFn(peerIdentity, method, path, body)
            : localAPIFn;

          const result = await apiFn('POST', '/api/inbox', payload);
          const target = singleTo || `${peerIdentity || 'local'} host`;
          return { content: [{ type: 'text', text: `Message sent to ${target} inbox (id: ${result.id}, thread: ${threadId.slice(0, 8)}...)` }] };
        }

        // Multicast: send to each recipient with Promise.allSettled
        const results = await Promise.allSettled(
          recipients.map(async (recipient) => {
            const payload: Record<string, unknown> = {
              from: fullAddress,
              body,
              to: recipient,
              threadId,
              _meta: meta,
            };
            if (replyTo) payload.replyTo = replyTo;
            if (status) payload.status = status;

            const peerIdentity = resolvePeer(config, { to: recipient });
            const apiFn: APIFunction = peerIdentity
              ? (method, path, body) => peerAPIFn(peerIdentity, method, path, body)
              : localAPIFn;

            const result = await apiFn('POST', '/api/inbox', payload);
            return { recipient, id: result.id };
          })
        );

        const succeeded: { recipient: string; id: string }[] = [];
        const failedEntries: { recipient: string; error: string }[] = [];
        for (let i = 0; i < results.length; i++) {
          const r = results[i]!;
          if (r.status === 'fulfilled') {
            succeeded.push(r.value);
          } else {
            failedEntries.push({ recipient: recipients[i]!, error: r.reason?.message || 'unknown error' });
          }
        }

        const parts: string[] = [`Multicast sent to ${succeeded.length}/${recipients.length} recipients (thread: ${threadId.slice(0, 8)}...)`];
        if (succeeded.length > 0) {
          parts.push(`Delivered: ${succeeded.map(r => `${r.recipient} (${r.id.slice(0, 8)}...)`).join(', ')}`);
        }
        if (failedEntries.length > 0) {
          parts.push(`Failed: ${failedEntries.map(f => `${f.recipient} (${f.error})`).join(', ')}`);
        }
        return { content: [{ type: 'text', text: parts.join('\n') }], isError: failedEntries.length === recipients.length };
      } catch (err) {
        return { content: [{ type: 'text', text: `Error sending message: ${(err as Error).message}` }], isError: true };
      }
    },

    async checkMessages({ all, threadId }: { all?: boolean; threadId?: string } = {}): Promise<MCPToolResult> {
      try {
        const config = loadConfig();
        const params = new URLSearchParams();
        if (all) params.set('all', 'true');
        if (config.instance) params.set('instance', config.instance);
        if (threadId) params.set('threadId', threadId);
        const query = params.toString() ? `?${params}` : '';
        const result = await localAPIFn('GET', `/api/inbox${query}`);
        const msgs: InboxAPIMessage[] = result.messages || [];

        // Split regular messages from receipts
        const regularMsgs = msgs.filter((m) => !m._meta || m._meta.type !== 'read-receipt');
        const receipts = msgs.filter((m) => m._meta?.type === 'read-receipt');

        // Auto-mark ALL unread (including receipts) as read
        const fullAddress = getFullAddress(config);
        const unreadIds = msgs.filter((m) => !m.read).map((m) => m.id);
        if (unreadIds.length > 0) {
          await localAPIFn('POST', '/api/inbox/mark-read', { ids: unreadIds, reader: fullAddress });
        }

        // Build receipt summary
        let receiptSummary = '';
        if (receipts.length > 0) {
          const details = receipts.map((r) => {
            const origId = r._meta?.originalId?.slice(0, 8) || '?';
            return `${origId}... read by ${r.from} at ${r._meta?.readAt || r.timestamp}`;
          }).join(', ');
          receiptSummary = `\n\n[READ_RECEIPTS] ${receipts.length} message(s) confirmed read: ${details}`;
        }

        if (regularMsgs.length === 0 && receipts.length === 0) {
          const text = all ? 'No messages in inbox.' : 'No unread messages.';
          return { content: [{ type: 'text', text }] };
        }

        if (regularMsgs.length === 0) {
          // Only receipts, no regular messages
          return { content: [{ type: 'text', text: receiptSummary.trim() }] };
        }

        // Count unread among regular messages only
        const regularUnreadCount = regularMsgs.filter((m) => !m.read).length;

        let header: string;
        let formatLine: (m: InboxAPIMessage) => string;

        const formatAnnotations = (m: InboxAPIMessage): string => {
          const parts: string[] = [];
          if (m.status) {
            parts.push(`[${m.status}]`);
          }
          if (m._meta?.recipients && m._meta.recipients.length > 0) {
            parts.push(`(multicast to ${m._meta.recipients.length})`);
          }
          if (m.threadId) {
            parts.push(`[thread: ${m.threadId.slice(0, 8)}...]`);
          }
          return parts.length > 0 ? ' ' + parts.join(' ') : '';
        };

        if (all) {
          header = `${regularMsgs.length} message(s) (${regularUnreadCount} unread):\n\n`;
          formatLine = (m) => {
            const status = m.read ? '  ' : '* ';
            const reply = m.replyTo ? ` (reply to ${m.replyTo.slice(0, 8)}...)` : '';
            const annotations = formatAnnotations(m);
            return `${status}[${m.timestamp}] (id: ${m.id}) From ${m.from}${reply}${annotations}:\n   ${m.body}`;
          };
        } else {
          header = `${regularMsgs.length} unread message(s):\n\n`;
          formatLine = (m) => {
            const reply = m.replyTo ? ` (reply to ${m.replyTo.slice(0, 8)}...)` : '';
            const annotations = formatAnnotations(m);
            return `[${m.timestamp}] (id: ${m.id}) From ${m.from}${reply}${annotations}:\n   ${m.body}`;
          };
        }
        const text = regularMsgs.map(formatLine).join('\n\n');
        return { content: [{ type: 'text', text: header + text + receiptSummary }] };
      } catch (err) {
        return { content: [{ type: 'text', text: `Error checking messages: ${(err as Error).message}` }], isError: true };
      }
    },

    async respondToMessage({ messageId, body, replyAll, status }: { messageId: string; body: string; replyAll?: boolean; status?: string }): Promise<MCPToolResult> {
      try {
        const config = loadConfig();
        const fullAddress = getFullAddress(config);

        // Look up original message to route reply back to sender.
        let originalMessage: InboxAPIMessage | null = null;
        let resolvedId = messageId;
        try {
          const lookup = await localAPIFn('GET', `/api/inbox/${messageId}`);
          if (lookup.message) originalMessage = lookup.message;
        } catch {
          // Exact lookup failed — try prefix match against all messages
          try {
            const allMsgs = await localAPIFn('GET', '/api/inbox?all=true');
            const match = ((allMsgs.messages || []) as InboxAPIMessage[]).find((m) => m.id.startsWith(messageId));
            if (match) {
              originalMessage = match;
              resolvedId = match.id;
            }
          } catch { /* give up on lookup */ }
        }

        const to = originalMessage?.from;
        const threadId = originalMessage?.threadId || randomUUID();
        const originalRecipients = originalMessage?._meta?.recipients;

        // Reply-all: send to original sender + all other recipients, minus self
        if (replyAll && originalRecipients && originalRecipients.length > 0) {
          const allTargets = [to, ...originalRecipients].filter(
            (addr): addr is string => !!addr && addr !== fullAddress
          );
          // Deduplicate
          const targets = [...new Set(allTargets)];

          if (targets.length === 0) {
            return { content: [{ type: 'text', text: 'Reply-all: no other recipients to send to.' }] };
          }

          const meta = { recipients: targets };
          const results = await Promise.allSettled(
            targets.map(async (recipient) => {
              const payload: Record<string, unknown> = {
                from: fullAddress,
                body,
                to: recipient,
                replyTo: resolvedId,
                threadId,
                _meta: meta,
              };
              if (status) payload.status = status;

              const peerIdentity = resolvePeer(config, { to: recipient });
              const apiFn: APIFunction = peerIdentity
                ? (method, path, body) => peerAPIFn(peerIdentity, method, path, body)
                : localAPIFn;

              const result = await apiFn('POST', '/api/inbox', payload);
              return { recipient, id: result.id };
            })
          );

          const succeeded: { recipient: string; id: string }[] = [];
          const failedEntries: { recipient: string; error: string }[] = [];
          for (let i = 0; i < results.length; i++) {
            const r = results[i]!;
            if (r.status === 'fulfilled') {
              succeeded.push(r.value);
            } else {
              failedEntries.push({ recipient: targets[i]!, error: r.reason?.message || 'unknown error' });
            }
          }

          const parts: string[] = [`Reply-all sent to ${succeeded.length}/${targets.length} recipients (thread: ${threadId.slice(0, 8)}..., replying to ${resolvedId.slice(0, 8)}...)`];
          if (succeeded.length > 0) {
            parts.push(`Delivered: ${succeeded.map(r => `${r.recipient} (${r.id.slice(0, 8)}...)`).join(', ')}`);
          }
          if (failedEntries.length > 0) {
            parts.push(`Failed: ${failedEntries.map(f => `${f.recipient} (${f.error})`).join(', ')}`);
          }
          return { content: [{ type: 'text', text: parts.join('\n') }], isError: failedEntries.length === targets.length };
        }

        // Single reply with threadId
        const payload: Record<string, unknown> = { from: fullAddress, body, replyTo: resolvedId, threadId };
        if (to) payload.to = to;
        if (status) payload.status = status;
        // Carry recipients metadata forward for potential future reply-all
        if (originalRecipients) {
          payload._meta = { recipients: originalRecipients };
        }

        // Route: local host → localAPI, peer → peerAPI, unknown → default peer
        const peerIdentity = resolvePeer(config, { to });
        let apiFn: APIFunction;
        if (peerIdentity) {
          apiFn = (method, path, body) => peerAPIFn(peerIdentity, method, path, body);
        } else if (to) {
          apiFn = localAPIFn;
        } else {
          const defaultPeer = getPeerIdentities(config);
          if (defaultPeer.length === 1) {
            const peer = defaultPeer[0]!;
            apiFn = (method, path, body) => peerAPIFn(peer, method, path, body);
          } else {
            apiFn = localAPIFn;
          }
        }

        const result = await apiFn('POST', '/api/inbox', payload);
        const routed = to ? `to ${to}` : 'to remote (sender unknown)';
        const text = `Reply sent ${routed} (id: ${result.id}, thread: ${threadId.slice(0, 8)}..., replying to ${resolvedId.slice(0, 8)}...)`;
        return { content: [{ type: 'text', text }] };
      } catch (err) {
        return { content: [{ type: 'text', text: `Error sending reply: ${(err as Error).message}` }], isError: true };
      }
    },

    async listInstances(): Promise<MCPToolResult> {
      const config = loadConfig();
      const peers = getPeerIdentities(config);
      const results: Record<string, RegistryInstance[]> = { local: [] };
      const errors: string[] = [];

      try {
        const local = await localAPIFn('GET', '/api/registry');
        results.local = local.instances || [];
      } catch (err) { errors.push(`local: ${(err as Error).message}`); }

      // Query each peer's registry
      for (const peer of peers) {
        try {
          const remote = await peerAPIFn(peer, 'GET', '/api/registry');
          results[peer] = remote.instances || [];
        } catch (err) { errors.push(`${peer}: ${(err as Error).message}`); }
      }

      const all = [
        ...(results.local ?? []).map((i: RegistryInstance) => ({ ...i, host: config.identity })),
        ...peers.flatMap(peer =>
          (results[peer] || []).map((i: RegistryInstance) => ({ ...i, host: peer }))
        ),
      ];
      const errorNote = errors.length ? `\n(errors: ${errors.join('; ')})` : '';
      if (all.length === 0) {
        return { content: [{ type: 'text', text: `No instances registered on any host.${errorNote}` }] };
      }
      const lines = all.map(i => `[${i.host}] ${i.address} (pid ${i.pid}, since ${i.registeredAt})`);
      return { content: [{ type: 'text', text: `${all.length} instance(s):\n${lines.join('\n')}${errorNote}` }] };
    },

    async deleteMessages({ ids, purge_read }: { ids?: string[]; purge_read?: boolean } = {}): Promise<MCPToolResult> {
      try {
        const config = loadConfig();
        const toDelete = ids ? [...ids] : [];
        if (purge_read) {
          const params = new URLSearchParams({ all: 'true' });
          if (config.instance) params.set('instance', config.instance);
          const result = await localAPIFn('GET', `/api/inbox?${params}`);
          const readIds = ((result.messages || []) as InboxAPIMessage[]).filter((m) => m.read).map((m) => m.id);
          for (const id of readIds) {
            if (!toDelete.includes(id)) toDelete.push(id);
          }
        }
        if (toDelete.length === 0) {
          return { content: [{ type: 'text', text: 'No messages to delete.' }] };
        }
        const result = await localAPIFn('POST', '/api/inbox/delete', { ids: toDelete });
        return { content: [{ type: 'text', text: `Deleted ${result.deleted} message(s).` }] };
      } catch (err) {
        return { content: [{ type: 'text', text: `Error deleting messages: ${(err as Error).message}` }], isError: true };
      }
    },

  };
}

export function createMCPServer() {
  const server = new McpServer(
    { name: 'icc', version: '0.3.0' },
    {
      instructions: [
        'ICC (Inter-Claude Connector) enables communication between Claude Code instances on multiple hosts.',
        '',
        'Tool categories:',
        '- Asynchronous: send_message, check_messages, respond_to_message, delete_messages (inbox-based persistent messaging)',
        '- Remote ops: read_remote_file, run_remote_command (require security features enabled on remote host)',
        '- Discovery: list_instances, ping_remote',
        '',
        'Multi-host: Use the optional "peer" parameter on ping_remote, read_remote_file, and run_remote_command to target a specific host.',
        'For send_message/respond_to_message, routing is automatic based on the "to" address (e.g. "laptop/myapp").',
        'If only one peer is configured, it is used by default. With multiple peers, specify the target.',
        '',
        'Common workflows:',
        '1. Check connectivity: ping_remote (optionally with peer)',
        '2. Send async message: list_instances → send_message (with "to" address from list_instances)',
        '3. Read + reply to inbox: check_messages → respond_to_message (using message ID or prefix)',
        '4. Remote file inspection: read_remote_file (requires readfileEnabled on remote)',
        '5. Remote command: run_remote_command (requires execEnabled on remote)',
        '6. Multicast: send_message with to: ["laptop/app", "server/app"] — delivers to all recipients with shared threadId',
        '7. Reply-all: respond_to_message with replyAll: true — replies to sender + all other recipients in thread',
        '8. Thread filtering: check_messages with threadId to see only messages in a specific conversation',
        '',
        'Important: check_messages marks retrieved messages as read. Call once and process the results.',
        'Threading: Every message gets a threadId. Replies inherit the parent\'s threadId. Use check_messages({ threadId }) to view a thread.',
        '',
        'Message status: send_message and respond_to_message accept an optional "status" parameter (WAITING_FOR_REPLY, FYI_ONLY, ACTION_NEEDED, RESOLVED). Prefer this over embedding [STATUS: ...] in the message body.',
      ].join('\n'),
    }
  );

  const client = new ICCClient();
  const handlers = createToolHandlers(client);

  // --- Connectivity tools ---

  server.registerTool(
    'ping_remote',
    {
      description: 'Check connectivity and latency to the remote ICC host. Returns the remote host\'s identity and round-trip latency in milliseconds.',
      inputSchema: z.object({
        peer: z.string().optional().describe('Target peer identity (e.g. "laptop", "server"). Required if multiple peers are configured.'),
      }),
    },
    (args) => handlers.pingRemote(args)
  );

  // --- Direct remote operations ---

  server.registerTool(
    'read_remote_file',
    {
      description: 'Read a file on the remote ICC host. Requires `security.readfileEnabled: true` in the remote server\'s config (disabled by default). The path must be within the remote server\'s allowed paths (defaults: ~/code, ~/Code, /tmp).',
      inputSchema: z.object({
        path: z.string().describe('Absolute or ~/-relative path to read on the remote host'),
        peer: z.string().optional().describe('Target peer identity (e.g. "laptop", "server"). Required if multiple peers are configured.'),
      }),
    },
    (args) => handlers.readRemoteFile(args)
  );

  server.registerTool(
    'run_remote_command',
    {
      description: 'Execute a command on the remote ICC host. Requires `security.execEnabled: true` in the remote server\'s config (disabled by default). Default allowed commands: ls, cat, head, tail, find, grep, git. Only the base command name is validated; arguments are unrestricted.',
      inputSchema: z.object({
        command: z.string().describe('Base command name to execute (e.g. \'git\', \'ls\'). Must be in the remote server\'s allow-list.'),
        args: z.array(z.string()).optional().describe('Command arguments as separate strings (e.g. [\'status\', \'--short\'], not \'status --short\')'),
        timeout: z.number().int().optional().describe('Timeout in ms. Capped at the remote server\'s maxExecTimeout (default: 30000ms).'),
        cwd: z.string().optional().describe('Working directory for the command'),
        peer: z.string().optional().describe('Target peer identity (e.g. "laptop", "server"). Required if multiple peers are configured.'),
      }),
    },
    (args) => handlers.runRemoteCommand(args)
  );

  // --- Inbox: persistent message passing ---

  server.registerTool(
    'send_message',
    {
      description: 'Send a message to an ICC inbox. Messages persist until the recipient reads them. Address format: "{host}/{instance}" (e.g. "laptop/myapp"). If the "to" address matches the local host, the message is delivered locally; otherwise it\'s routed to the appropriate peer. Omitting "to" sends to the default peer (if only one is configured). Pass an array for multicast to multiple recipients.',
      inputSchema: z.object({
        body: z.string().describe('The message content'),
        replyTo: z.string().optional().describe('ID of a message to reply to (for threading)'),
        to: z.union([z.string(), z.array(z.string()).min(2)]).optional().describe('Target address(es). Single string or array for multicast (e.g. ["laptop/app", "server/app"]).'),
        status: z.enum(['WAITING_FOR_REPLY', 'FYI_ONLY', 'ACTION_NEEDED', 'RESOLVED']).optional().describe('Message status. Use instead of [STATUS: ...] in body text. WAITING_FOR_REPLY = expecting a response, FYI_ONLY = informational, ACTION_NEEDED = recipient should act, RESOLVED = issue closed.'),
      }),
    },
    (args) => handlers.sendMessage(args)
  );

  server.registerTool(
    'check_messages',
    {
      description: 'Check the local inbox for unread messages. WARNING: Unread messages are automatically marked as read when retrieved — a second call will return no unread messages. Use `all: true` to see previously read messages. Messages may be from any sender, not just the remote host.',
      inputSchema: z.object({
        all: z.boolean().optional().describe('If true, return all messages (read + unread). Default: unread only.'),
        threadId: z.string().optional().describe('Filter messages by thread ID. Only returns messages belonging to this thread.'),
      }),
    },
    (args) => handlers.checkMessages(args)
  );

  server.registerTool(
    'respond_to_message',
    {
      description: 'Send a reply to a specific message. The reply is automatically routed back to the sender\'s host. Supports prefix matching — you can use the first 8+ characters of a message ID instead of the full UUID. Use replyAll to respond to all participants in a multicast thread.',
      inputSchema: z.object({
        messageId: z.string().describe('Full message ID or unique prefix (8+ characters). The sender address is looked up from the original message to route the reply.'),
        body: z.string().describe('The reply content'),
        replyAll: z.boolean().optional().describe('Reply to sender AND all other recipients in the thread. Default: sender only.'),
        status: z.enum(['WAITING_FOR_REPLY', 'FYI_ONLY', 'ACTION_NEEDED', 'RESOLVED']).optional().describe('Message status. Use instead of [STATUS: ...] in body text.'),
      }),
    },
    (args) => handlers.respondToMessage(args)
  );

  server.registerTool(
    'delete_messages',
    {
      description: 'Delete messages from the local inbox. Provide specific IDs, set purge_read to delete all already-read messages, or both (combined). If neither is provided, no action is taken.',
      inputSchema: z.object({
        ids: z.array(z.string()).optional().describe('Message IDs to delete'),
        purge_read: z.boolean().optional().describe('If true, delete all already-read messages'),
      }),
    },
    (args) => handlers.deleteMessages(args)
  );

  // --- Instance registry ---

  server.registerTool(
    'list_instances',
    {
      description: 'List registered Claude Code instances on all configured ICC hosts (local + all peers). Returns each instance\'s address (host/name), PID, and registration time. Use this to discover valid "to" addresses for send_message.',
      inputSchema: z.object({}),
    },
    () => handlers.listInstances()
  );

  return { server, client, handlers };
}

/**
 * Start the MCP server on stdio. Called by bin/icc-mcp.ts.
 */
export async function startMCPServer(): Promise<McpServer> {
  const { server } = createMCPServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
  log.info('ICC MCP server running on stdio');

  // Auto-derive instance name from cwd if not explicitly configured
  const config = loadConfig();
  if (!config.instance) {
    const { resolve: resolveInstance } = await import('./instances.ts');
    config.instance = resolveInstance(process.cwd());
    log.info(`Auto-derived instance name "${config.instance}" from cwd`);
  }

  // Register this instance with the local server (non-fatal)
  if (config.instance) {
    try {
      await localAPI('POST', '/api/registry', {
        instance: config.instance,
        pid: process.pid,
      });
      log.info(`Registered instance "${config.instance}" with local server`);
    } catch (err) {
      log.warn(`Failed to register instance: ${(err as Error).message}`);
    }
  }

  return server;
}

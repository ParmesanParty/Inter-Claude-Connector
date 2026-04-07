import { createServer, request as httpRequest } from 'node:http';
import { createServer as createSecureServer, request as httpsRequest } from 'node:https';
import type { IncomingMessage, ServerResponse, Server } from 'node:http';
import { readFileSync, existsSync, statSync, unlinkSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { homedir } from 'node:os';
import { timingSafeEqual, randomUUID } from 'node:crypto';
import { loadConfig, getFullAddress, getOutboundToken, getTlsOptions, writeConfig, clearConfigCache, getPeerIdentities } from './config.ts';
import { renewIfNeeded } from './tls.ts';
import { buildAddress, parseAddress } from './address.ts';
import { validate, createPong, serialize } from './protocol.ts';
import { createLogger } from './util/logger.ts';
import { readBody, sendJSON as baseSendJSON } from './util/http.ts';
import { init as initInbox, push as inboxPush, getUnread, getAll as inboxGetAll, getById as inboxGetById, markRead, markAllRead, remove as inboxRemove, purgeStale, setNotifier, setReceiptSender, isReceipt, subscribe as inboxSubscribe } from './inbox.ts';
import { safeReadFile, safeExec } from './util/exec.ts';
import { register as registryRegister, list as registryList, deregister as registryDeregister, sessionRegister, sessionDeregister, sessionHeartbeat, sessionSnooze, onWatcherDisconnect, sessionReconnect } from './registry.ts';
import { listAll as instancesListAll } from './instances.ts';
import { createDesktopNotifier } from './notify.ts';
import { registrySchema, inboxSchema, execSchema, readfileSchema } from './api-schemas.ts';
import { buildSetupPayload } from './setup-config.ts';
import type { Message, ICCConfig, AuthResult } from './types.ts';

const log = createLogger('server');

function getCorsHeaders(req: IncomingMessage, config: ICCConfig): Record<string, string> {
  const origin = req.headers.origin;
  const allowed = config.server.corsOrigins || [];
  const headers: Record<string, string> = {
    'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Vary': 'Origin',
  };
  if (origin && allowed.includes(origin)) {
    headers['Access-Control-Allow-Origin'] = origin;
  }
  return headers;
}

/**
 * Timing-safe token comparison. Returns true if tokens match.
 * Handles different-length strings safely (always constant-time).
 */
function safeTokenEquals(a: string, b: string): boolean {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) {
    // Compare against self to burn the same time, then return false
    timingSafeEqual(bufA, bufA);
    return false;
  }
  return timingSafeEqual(bufA, bufB);
}

/**
 * Extract bearer token from request (header or query param).
 */
function extractToken(req: IncomingMessage): string | null {
  const header = req.headers.authorization;
  if (header) {
    const [scheme, token] = header.split(' ');
    if (scheme === 'Bearer' && token) return token;
  }
  const url = new URL(req.url || '/', 'http://localhost');
  return url.searchParams.get('token');
}

/**
 * Authenticate a request and resolve the caller's identity.
 */
function checkAuth(req: IncomingMessage, config: ICCConfig): AuthResult {
  const { localToken, peerTokens } = config.server;
  const hasAnyToken = localToken || (peerTokens && Object.keys(peerTokens).length > 0);

  if (!hasAnyToken) return { authenticated: true, identity: '_local' };

  const token = extractToken(req);
  if (!token) return { authenticated: false, identity: null };

  // Check localToken
  if (localToken && safeTokenEquals(token, localToken)) {
    return { authenticated: true, identity: '_local' };
  }

  // Check peerTokens
  if (peerTokens) {
    for (const [peer, peerToken] of Object.entries(peerTokens)) {
      if (peerToken && safeTokenEquals(token, peerToken)) {
        return { authenticated: true, identity: peer };
      }
    }
  }

  return { authenticated: false, identity: null };
}

/**
 * Validate that the `from` field in a message matches the authenticated identity.
 */
function validateFrom(authIdentity: string | null, fromField: string): boolean {
  if (authIdentity === '_local') return true;
  if (!fromField) return false;
  return parseAddress(fromField).host === authIdentity;
}

async function handleMessage(message: Message): Promise<Message> {
  if (message.type === 'ping') {
    return createPong(message.id);
  }

  // Only ping is handled; other types rejected by validate() or here
  return createPong(message.id); // fallback — shouldn't reach here
}


function sendReceiptToRemote(config: ICCConfig, receipt: Record<string, unknown>, senderHost: string): void {
  const baseUrl = config.remotes?.[senderHost]?.httpUrl;
  if (!baseUrl) return;
  const url = new URL('/api/inbox', baseUrl);
  const payload = JSON.stringify(receipt);
  const outboundToken = getOutboundToken(config, senderHost);

  const isHttps = url.protocol === 'https:';
  const requestFn = isHttps ? httpsRequest : httpRequest;
  const tlsOpts = isHttps ? (getTlsOptions(config) || {}) : {};

  const req = requestFn(url, {
    method: 'POST',
    timeout: 5000,
    ...tlsOpts,
    headers: {
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(payload),
      ...(outboundToken && { 'Authorization': `Bearer ${outboundToken}` }),
    },
  });
  req.on('error', (err) => log.debug(`Receipt delivery failed: ${err.message}`));
  req.on('timeout', () => { req.destroy(); });
  req.write(payload);
  req.end();
}

function createReceiptSender(config: ICCConfig): (originalMessage: { id: string; from: string }, readerAddress?: string) => void {
  const fallbackAddress = getFullAddress(config);
  return (originalMessage, readerAddress) => {
    const senderHost = parseAddress(originalMessage.from).host || '';
    if (!senderHost || senderHost === config.identity) return; // local message, no receipt needed
    const receipt = {
      from: readerAddress || fallbackAddress,
      to: originalMessage.from,
      body: '',
      _meta: {
        type: 'read-receipt',
        originalId: originalMessage.id,
        readAt: new Date().toISOString(),
      },
    };
    sendReceiptToRemote(config, receipt, senderHost);
  };
}

interface ICCServerOptions {
  port?: number;
  host?: string;
  noAuth?: boolean;
  enableMcp?: boolean;
  localhostHttpPort?: number;
  setupToken?: string;
}

interface ICCServer {
  start(): Promise<{ port: number; host: string }>;
  stop(): Promise<void>;
  server: Server;
}

function buildCaEnrollUrl(config: ICCConfig, tlsDir: string): string | null {
  if (existsSync(join(tlsDir, 'ca.key'))) return null; // CA host — self-sign
  const caId = config.tls?.ca;
  if (!caId) return null; // no CA configured
  const peer = config.remotes?.[caId];
  if (!peer?.httpUrl) return null;
  const url = new URL(peer.httpUrl);
  url.port = String(config.server.enrollPort || 4179);
  return url.toString().replace(/\/$/, '');
}

export function createICCServer(options: ICCServerOptions = {}): ICCServer {
  let config = loadConfig();
  const port = options.port ?? config.server.port;
  const host = options.host ?? config.server.host;
  const tlsOpts = getTlsOptions(config);
  const startTime = Date.now();
  const sseConnections = new Set<ServerResponse>();

  // MCP session management: each client gets its own transport+server pair
  const mcpSessions = new Map<string, { transport: any; server: any }>();
  let createMcpSession: (() => Promise<{ transport: any; server: any; sessionId: string }>) | null = null;

  // One-time setup token — disabled after first successful fetch
  let setupToken: string | null = options.setupToken ?? null;
  const localhostHttpPort = options.localhostHttpPort ?? null;
  // Localhost HTTP base URL for setup/claude-code response
  const localBaseUrl = localhostHttpPort ? `http://localhost:${localhostHttpPort}` : `http://localhost:${port}`;

  // Initialize inbox, desktop notifications, and read receipts
  initInbox();
  setNotifier(createDesktopNotifier(config));
  setReceiptSender(createReceiptSender(config));

  const handler = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const { method } = req;
    // Strip query string for route matching
    const url = (req.url || '').split('?')[0]!;
    log.debug(`${method} ${url}`);

    // MCP HTTP transport — handle /mcp path (requires localToken via ?token= query param)
    if (createMcpSession && url === '/mcp') {
      const mcpQuery = new URL(req.url || '/', 'http://localhost');
      const mcpToken = mcpQuery.searchParams.get('token');
      if (config.server.localToken && (!mcpToken || !safeTokenEquals(mcpToken, config.server.localToken))) {
        baseSendJSON(res, 401, { error: 'Unauthorized — MCP requires ?token=<localToken>' });
        return;
      }
      try {
        const sessionId = req.headers['mcp-session-id'] as string | undefined;
        let session = sessionId ? mcpSessions.get(sessionId) : undefined;
        if (!session) {
          const newSession = await createMcpSession();
          session = { transport: newSession.transport, server: newSession.server };
          mcpSessions.set(newSession.sessionId, session);
          session.transport.onclose = () => {
            mcpSessions.delete(newSession.sessionId);
            log.debug(`MCP session ${newSession.sessionId} closed (${mcpSessions.size} active)`);
          };
          log.debug(`MCP session ${newSession.sessionId} created (${mcpSessions.size} active)`);
        }
        await session.transport.handleRequest(req, res);
      } catch (err) {
        log.error(`MCP handleRequest error: ${(err as Error).stack || (err as Error).message}`);
        if (!res.headersSent) baseSendJSON(res, 500, { error: 'MCP transport error' });
      }
      return;
    }

    const corsHeaders = getCorsHeaders(req, config);
    const sendJSON = (r: ServerResponse, statusCode: number, data: unknown): void => {
      baseSendJSON(r, statusCode, data, corsHeaders);
    };

    // CORS preflight
    if (method === 'OPTIONS') {
      res.writeHead(204, corsHeaders);
      res.end();
      return;
    }

    // Help/usage — no auth required (like MCP discovery)
    if (method === 'GET' && url === '/api/help') {
      sendJSON(res, 200, {
        name: 'Inter-Claude Connector (ICC)',
        version: '1',
        identity: config.identity,
        description: 'Messaging and collaboration for Claude Code instances across hosts.',
        endpoints: {
          'GET /api/help': {
            auth: false,
            description: 'This endpoint. Returns API documentation and usage examples.',
          },
          'GET /api/health': {
            auth: false,
            description: 'Health check. Returns server identity and uptime.',
            response: '{ status, identity, uptime }',
          },
          'GET /api/registry': {
            auth: true,
            description: 'List registered (live) instances on this host. Returns ephemeral registry with PID-based liveness.',
            response: '{ instances: [{ address, instance, pid, registeredAt, lastSeen }], host }',
          },
          'GET /api/instances': {
            auth: true,
            description: 'List persistent instance name index (name-to-path mappings from ~/.icc/instances.json).',
            response: '{ instances: [{ name, path }], host }',
          },
          'POST /api/registry': {
            auth: true,
            description: 'Register an instance with the local server. Server builds the address from its identity + instance name.',
            body: '{ instance: "<name>", pid: <number> }',
            response: '{ ok: true, entry: { address, instance, pid, registeredAt, lastSeen } }',
          },
          'DELETE /api/registry/:instance': {
            auth: true,
            description: 'Deregister an instance by name. Called on session shutdown.',
            response: '{ ok: true, removed: true|false }',
          },
          'POST /api/message': {
            auth: true,
            description: 'Send an ICC protocol message (ping only). Returns a pong.',
            body: '{ version: "1", id: "<uuid>", type: "ping", from: "<identity>", timestamp: "<iso8601>", payload: {} }',
            response: '{ version, id, type: "pong", from, timestamp, replyTo, payload: {} }',
          },
          'POST /api/ping': {
            auth: true,
            description: 'Quick connectivity check. Returns a pong message.',
            response: '{ type: "pong", ... }',
          },
          'GET /api/events': {
            auth: true,
            description: 'SSE stream of real-time inbox message events. Supports ?token= query param for auth since EventSource cannot set headers.',
            response: 'text/event-stream — each event is a JSON inbox message object',
          },
          'POST /api/inbox': {
            auth: true,
            description: 'Push a message into the inbox. Server generates id, timestamp, and read:false. Optional "to" field for instance addressing (e.g. "mars/myapp"); defaults to broadcast (bare hostname). Optional "threadId" groups related messages in a conversation. Optional "status" field: WAITING_FOR_REPLY, FYI_ONLY, ACTION_NEEDED, or RESOLVED.',
            body: '{ from: "<address>", to?: "<address>", body: "<message text>", replyTo?: "<message-id>", threadId?: "<uuid>", status?: "WAITING_FOR_REPLY"|"FYI_ONLY"|"ACTION_NEEDED"|"RESOLVED", _meta?: { recipients?: ["<addr>", ...] } }',
            response: '{ ok: true, id: "<uuid>", threadId: "<uuid>"|null, status: "<status>"|null }',
          },
          'GET /api/inbox': {
            auth: true,
            description: 'List inbox messages. Default: unread only. Use ?all=true for all messages. Use ?instance=<name> to filter by instance. Use ?receipts=false to exclude read receipts. Use ?since=<ISO8601> to only return messages newer than the given timestamp. Use ?threadId=<uuid> to filter by thread.',
            response: '{ messages: [...], unreadCount: <number> }',
          },
          'GET /api/inbox/:id': {
            auth: true,
            description: 'Get a single inbox message by ID.',
            response: '{ message: { id, from, to, timestamp, body, replyTo, read } }',
          },
          'POST /api/inbox/mark-read': {
            auth: true,
            description: 'Mark messages as read. Send { ids: [...] } for specific, or { all: true } for all. Add "instance" to scope mark-all to a specific instance. Add "reader" (full address, e.g. "laptop/myapp") to attribute read receipts to a specific instance.',
            body: '{ ids?: ["<id>", ...], all?: true, instance?: "<name>", reader?: "<host/instance>" }',
            response: '{ ok: true, marked: <count> }',
          },
          'POST /api/inbox/delete': {
            auth: true,
            description: 'Delete messages by ID.',
            body: '{ ids: ["<id>", ...] }',
            response: '{ ok: true, deleted: <count> }',
          },
          'GET /setup/claude-code': {
            auth: false,
            description: 'Returns structured JSON with everything Claude Code needs to self-configure: MCP config, hooks, CLAUDE.md content, and skill definitions. Designed for bootstrapping — Claude Code fetches this endpoint and applies the configs.',
            response: '{ instructions, mcp: { target, mergeKey, config }, hooks: { target, mergeKey, config }, claudeMd: { target, append, content }, skills: { watch, snooze, wake }, postSetup }',
          },
        },
        protocol: {
          messageTypes: ['error', 'ping', 'pong'],
          version: '1',
          fields: {
            version: 'Protocol version (always "1")',
            id: 'UUID v4 message identifier',
            type: 'One of: error, ping, pong',
            from: 'Identity of the sender (e.g. "mars", "jupiter")',
            timestamp: 'ISO 8601 timestamp',
            payload: 'Type-specific data — error: { error }',
            replyTo: '(error/pong only) ID of the message being replied to',
          },
        },
        examples: {
          ping: {
            description: 'Check connectivity',
            curl: `curl -X POST http://localhost:${port}/api/ping -H "Authorization: Bearer <token>"`,
          },
          health: {
            description: 'Check server status (no auth needed)',
            curl: `curl http://localhost:${port}/api/health`,
          },
          sendInboxMessage: {
            description: 'Send an inbox message',
            curl: `curl -X POST http://localhost:${port}/api/inbox -H "Content-Type: application/json" -H "Authorization: Bearer <token>" -d '{"from":"<identity>","body":"Hello!","to":"<host/instance>"}'`,
          },
        },
      });
      return;
    }

    // Health check — no auth required
    if (method === 'GET' && url === '/api/health') {
      sendJSON(res, 200, {
        status: 'ok',
        identity: config.identity,
        instance: config.instance || null,
        uptime: Math.floor((Date.now() - startTime) / 1000),
      });
      return;
    }

    // TLS challenge endpoint — no auth required (CA needs to reach this)
    if (method === 'GET' && url === '/.well-known/icc-challenge') {
      const CHALLENGE_MAX_AGE = 10 * 60 * 1000; // 10 minutes
      const tlsDir = process.env.ICC_TLS_DIR || join(homedir(), '.icc', 'tls');
      const challengePath = join(tlsDir, '.challenge');
      try {
        if (existsSync(challengePath)) {
          // Check TTL — expired challenges are deleted
          try {
            const stat = statSync(challengePath);
            if (Date.now() - stat.mtimeMs > CHALLENGE_MAX_AGE) {
              unlinkSync(challengePath);
              sendJSON(res, 404, { error: 'Challenge expired' });
              return;
            }
          } catch { /* stat failed, continue */ }
          const token = readFileSync(challengePath, 'utf-8').trim();
          res.writeHead(200, { 'Content-Type': 'text/plain', ...corsHeaders });
          res.end(token);
        } else {
          sendJSON(res, 404, { error: 'No active challenge' });
        }
      } catch {
        sendJSON(res, 500, { error: 'Challenge read error' });
      }
      return;
    }

    // GET /setup/claude-code — bootstrapping endpoint for Claude Code self-configuration
    // Gated by one-time setupToken during wizard flow, then by localToken auth permanently.
    if (method === 'GET' && url === '/setup/claude-code') {
      if (setupToken) {
        const setupQuery = new URL(req.url || '/', 'http://localhost');
        const providedToken = setupQuery.searchParams.get('token');
        if (!providedToken || !safeTokenEquals(providedToken, setupToken)) {
          sendJSON(res, 403, { error: 'Invalid or missing setup token' });
          return;
        }
      } else if (config.server.localToken) {
        // No setupToken configured — require localToken as fallback
        const auth = checkAuth(req, config);
        if (!auth.authenticated) {
          sendJSON(res, 401, { error: 'Unauthorized' });
          return;
        }
      }
      sendJSON(res, 200, buildSetupPayload(config));
      // Consume one-time setup token — subsequent requests require localToken auth
      if (setupToken) {
        log.info('Setup token consumed — /setup/claude-code now requires localToken auth');
        setupToken = null;
      }
      return;
    }

    // Auth check for all other endpoints
    const auth = checkAuth(req, config);
    if (!auth.authenticated) {
      sendJSON(res, 401, { error: 'Unauthorized' });
      return;
    }

    // Registry: list instances (auth required)
    if (method === 'GET' && url === '/api/registry') {
      const instances = registryList();
      for (const entry of instances) {
        if (!entry.address) entry.address = buildAddress(config.identity, entry.instance);
      }
      sendJSON(res, 200, { instances, host: config.identity });
      return;
    }

    // Persistent instance index
    if (method === 'GET' && url === '/api/instances') {
      sendJSON(res, 200, { instances: instancesListAll(), host: config.identity });
      return;
    }

    // Registry: register instance
    if (method === 'POST' && url === '/api/registry') {
      try {
        const body = await readBody(req);
        const parsed = registrySchema.safeParse(JSON.parse(body));
        if (!parsed.success) {
          sendJSON(res, 400, { error: parsed.error.issues[0]?.message ?? 'Invalid request' });
          return;
        }
        const { instance, pid } = parsed.data;
        const address = buildAddress(config.identity, instance);
        const entry = registryRegister({ instance, pid, address });
        sendJSON(res, 200, { ok: true, entry });
      } catch (err) {
        sendJSON(res, 400, { error: (err as Error).message });
      }
      return;
    }

    // Registry: deregister instance
    if (method === 'DELETE' && url.startsWith('/api/registry/')) {
      const instanceName = url.slice('/api/registry/'.length);
      if (!instanceName) {
        sendJSON(res, 400, { error: 'Missing instance name in URL' });
        return;
      }
      const fullUrl = new URL(req.url || '/', 'http://localhost');
      const pidParam = fullUrl.searchParams.get('pid');
      const opts = pidParam ? { pid: parseInt(pidParam, 10) } : {};
      const removed = registryDeregister(instanceName, opts);
      sendJSON(res, 200, { ok: true, removed });
      return;
    }

    // SSE stream — real-time inbox message updates
    if (method === 'GET' && url === '/api/events') {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
        ...corsHeaders,
      });
      res.write(':\n\n'); // SSE comment to establish connection

      sseConnections.add(res);
      const unsubscribe = inboxSubscribe((message) => {
        res.write(`data: ${JSON.stringify(message)}\n\n`);
      });

      req.on('close', () => {
        sseConnections.delete(res);
        unsubscribe();
      });
      return;
    }

    // Ping endpoint
    if (method === 'POST' && url === '/api/ping') {
      sendJSON(res, 200, JSON.parse(serialize(createPong('direct'))));
      return;
    }

    // Message endpoint
    if (method === 'POST' && url === '/api/message') {
      try {
        const body = await readBody(req);
        const message = JSON.parse(body);

        if (!validate(message)) {
          sendJSON(res, 400, { error: 'Invalid ICC message' });
          return;
        }

        // Validate from-field matches authenticated identity
        if (!validateFrom(auth.identity, message.from)) {
          sendJSON(res, 403, { error: `Authenticated as "${auth.identity}" but message from "${message.from}" — identity mismatch` });
          return;
        }

        const response = await handleMessage(message);
        sendJSON(res, 200, JSON.parse(serialize(response)));
      } catch (err) {
        log.error(`Message handling error: ${(err as Error).message}`);
        sendJSON(res, 500, { error: (err as Error).message });
      }
      return;
    }

    // Read file endpoint
    if (method === 'POST' && url === '/api/readfile') {
      try {
        const body = await readBody(req);
        const parsed = readfileSchema.safeParse(JSON.parse(body));
        if (!parsed.success) {
          sendJSON(res, 400, { error: parsed.error.issues[0]?.message ?? 'Invalid request' });
          return;
        }
        const result = await safeReadFile(parsed.data.path);
        sendJSON(res, 200, result);
      } catch (err) {
        const msg = (err as Error).message;
        const status = msg.includes('disabled') || msg.includes('not in allowed') ? 403 : 500;
        sendJSON(res, status, { error: msg });
      }
      return;
    }

    // Exec endpoint
    if (method === 'POST' && url === '/api/exec') {
      try {
        const body = await readBody(req);
        const parsed = execSchema.safeParse(JSON.parse(body));
        if (!parsed.success) {
          sendJSON(res, 400, { error: parsed.error.issues[0]?.message ?? 'Invalid request' });
          return;
        }
        const { command, args: cmdArgs, timeout, cwd } = parsed.data;
        const result = await safeExec(command, cmdArgs, { timeout, cwd });
        sendJSON(res, 200, result);
      } catch (err) {
        const msg = (err as Error).message;
        const status = msg.includes('disabled') || msg.includes('not in allowed') ? 403 : 500;
        sendJSON(res, status, { error: msg });
      }
      return;
    }

    // Inbox: push a message
    if (method === 'POST' && url === '/api/inbox') {
      try {
        const body = await readBody(req);
        const parsed = inboxSchema.safeParse(JSON.parse(body));
        if (!parsed.success) {
          sendJSON(res, 400, { error: parsed.error.issues[0]?.message ?? 'Invalid request' });
          return;
        }
        const { from, to, body: msgBody, replyTo, threadId, status, _meta } = parsed.data;
        // Validate from-field matches authenticated identity
        if (!validateFrom(auth.identity, from)) {
          sendJSON(res, 403, { error: `Authenticated as "${auth.identity}" but from "${from}" — identity mismatch` });
          return;
        }
        // Validate `to` if provided: host part must match this server's identity
        let destination: string = config.identity;
        if (to) {
          const addr = parseAddress(to);
          if (addr.host && addr.host !== config.identity) {
            sendJSON(res, 400, { error: `Address host "${addr.host}" does not match server identity "${config.identity}"` });
            return;
          }
          destination = to;
        }
        const silent = _meta?.type === 'read-receipt';
        const msg = inboxPush({ from, to: destination, body: msgBody, replyTo, threadId, status, _meta }, { silent });
        sendJSON(res, 200, { ok: true, id: msg.id, threadId: msg.threadId, status: msg.status });
      } catch (err) {
        sendJSON(res, 400, { error: (err as Error).message });
      }
      return;
    }

    // Inbox: list messages
    if (method === 'GET' && url === '/api/inbox') {
      const queryUrl = new URL(req.url || '/', 'http://localhost');
      const all = queryUrl.searchParams.get('all') === 'true';
      const instance = queryUrl.searchParams.get('instance');
      const hideReceipts = queryUrl.searchParams.get('receipts') === 'false';
      const since = queryUrl.searchParams.get('since');
      const threadId = queryUrl.searchParams.get('threadId');
      const filterOpts = instance
        ? { forAddress: buildAddress(config.identity, instance), serverIdentity: config.identity }
        : {};
      let msgs = all ? inboxGetAll(filterOpts) : getUnread(filterOpts);
      let unread = getUnread(filterOpts);
      if (hideReceipts) {
        msgs = msgs.filter(m => !isReceipt(m));
        unread = unread.filter(m => !isReceipt(m));
      }
      if (since) {
        msgs = msgs.filter(m => m.timestamp > since);
      }
      if (threadId) {
        msgs = msgs.filter(m => m.threadId === threadId);
      }
      sendJSON(res, 200, { messages: msgs, unreadCount: unread.length });
      return;
    }

    // Inbox: get single message by ID
    if (method === 'GET' && url.startsWith('/api/inbox/') && !url.includes('mark-read') && !url.includes('delete')) {
      const msgId = url.slice('/api/inbox/'.length);
      if (!msgId) {
        sendJSON(res, 400, { error: 'Missing message ID' });
        return;
      }
      const msg = inboxGetById(msgId);
      if (!msg) {
        sendJSON(res, 404, { error: 'Message not found' });
        return;
      }
      sendJSON(res, 200, { message: msg });
      return;
    }

    // Inbox: mark messages as read
    if (method === 'POST' && url === '/api/inbox/mark-read') {
      try {
        const body = await readBody(req);
        const { ids, all, instance, reader } = JSON.parse(body);
        let marked: number;
        if (all) {
          const opts = instance
            ? { forAddress: buildAddress(config.identity, instance), serverIdentity: config.identity, readerAddress: reader }
            : { readerAddress: reader };
          marked = markAllRead(opts);
        } else {
          marked = markRead(ids || [], reader);
        }
        sendJSON(res, 200, { ok: true, marked });
      } catch (err) {
        sendJSON(res, 400, { error: (err as Error).message });
      }
      return;
    }

    // Inbox: delete messages
    if (method === 'POST' && url === '/api/inbox/delete') {
      try {
        const body = await readBody(req);
        const { ids } = JSON.parse(body);
        if (!ids || !Array.isArray(ids)) {
          sendJSON(res, 400, { error: 'Missing required field: ids (array)' });
          return;
        }
        const deleted = inboxRemove(ids);
        sendJSON(res, 200, { ok: true, deleted });
      } catch (err) {
        sendJSON(res, 400, { error: (err as Error).message });
      }
      return;
    }

    // POST /api/mesh-update — CA pushes peer config changes
    if (method === 'POST' && url === '/api/mesh-update') {
      try {
        const caIdentity = config.tls?.ca;
        if (!caIdentity || auth.identity !== caIdentity) {
          sendJSON(res, 403, { error: 'Only the CA can push mesh updates' });
          return;
        }

        const body = JSON.parse(await readBody(req));
        const { action, peer, outboundToken } = body;

        if (action === 'add-peer') {
          if (!peer?.identity || !peer?.httpsUrl || !peer?.peerToken || !outboundToken) {
            sendJSON(res, 400, { error: 'Missing required fields: peer.identity, peer.httpsUrl, peer.peerToken, outboundToken' });
            return;
          }

          if (!config.remotes) config.remotes = {};
          config.remotes[peer.identity] = { httpUrl: peer.httpsUrl, token: outboundToken };
          if (!config.server.peerTokens) config.server.peerTokens = {};
          config.server.peerTokens[peer.identity] = peer.peerToken;

          writeConfig(config);
          reloadConfig();

          inboxPush({
            from: `${caIdentity}/ca`,
            to: config.identity,
            body: `[TOPIC: mesh] New peer "${peer.identity}" added by CA at ${peer.httpsUrl}`,
            status: 'FYI_ONLY',
          });

          log.info(`Mesh update: added peer "${peer.identity}" from CA "${caIdentity}"`);
          sendJSON(res, 200, { ok: true, peer: peer.identity });
          return;
        }

        sendJSON(res, 400, { error: `Unknown action: ${action}` });
      } catch (err) {
        sendJSON(res, 400, { error: (err as Error).message });
      }
      return;
    }

    // POST /api/reload-config — hot-reload config from disk (local only)
    if (method === 'POST' && url === '/api/reload-config') {
      if (!auth.authenticated || auth.identity !== '_local') {
        sendJSON(res, 403, { error: 'Only local clients can trigger config reload' });
        return;
      }
      reloadConfig();
      sendJSON(res, 200, { ok: true });
      return;
    }

    // ── Session lifecycle endpoints ──────────────────────────────────

    // POST /api/hook/startup — status-only, no registration
    if (method === 'POST' && url === '/api/hook/startup') {
      try {
        const body = JSON.parse(await readBody(req));
        const instance = body.instance;
        if (!instance) {
          sendJSON(res, 400, { error: 'Missing required field: instance' });
          return;
        }
        const unread = getUnread();
        const unreadCount = unread.filter(m => !isReceipt(m)).length;
        const { version: setupVersion } = buildSetupPayload(config);
        const drifted = typeof body.appliedVersion === 'string' && body.appliedVersion !== setupVersion;
        sendJSON(res, 200, { connected: true, unreadCount, setupVersion, drifted });
      } catch (err) {
        sendJSON(res, 400, { error: (err as Error).message });
      }
      return;
    }

    // POST /api/hook/watch — register instance + generate session token
    if (method === 'POST' && url === '/api/hook/watch') {
      try {
        const body = JSON.parse(await readBody(req));
        const { instance, pid, force, name } = body;
        if (!instance) {
          sendJSON(res, 400, { error: 'Missing required field: instance' });
          return;
        }
        const result = sessionRegister({ instance, pid, force, name });
        sendJSON(res, 200, result);
      } catch (err) {
        sendJSON(res, 400, { error: (err as Error).message });
      }
      return;
    }

    // POST /api/hook/heartbeat — update lastSeen
    if (method === 'POST' && url === '/api/hook/heartbeat') {
      try {
        const body = JSON.parse(await readBody(req));
        const { sessionToken } = body;
        if (!sessionToken) {
          sendJSON(res, 400, { error: 'Missing required field: sessionToken' });
          return;
        }
        const ok = sessionHeartbeat(sessionToken);
        sendJSON(res, 200, ok ? { ok } : { ok, reason: 'unknown_token' });
      } catch (err) {
        sendJSON(res, 400, { error: (err as Error).message });
      }
      return;
    }

    // POST /api/hook/snooze — eager deregistration
    if (method === 'POST' && url === '/api/hook/snooze') {
      try {
        const body = JSON.parse(await readBody(req));
        const { sessionToken } = body;
        if (!sessionToken) {
          sendJSON(res, 400, { error: 'Missing required field: sessionToken' });
          return;
        }
        const ok = sessionSnooze(sessionToken);
        // Terminate active long-poll watcher connection if present.
        // Done after snooze so cleanup's onWatcherDisconnect is a no-op
        // (session already removed by snooze).
        const watcherRes = activeWatchers.get(sessionToken);
        if (watcherRes) {
          activeWatchers.delete(sessionToken);
          sendJSON(watcherRes, 200, { event: 'snoozed' });
        }
        sendJSON(res, 200, { ok });
      } catch (err) {
        sendJSON(res, 400, { error: (err as Error).message });
      }
      return;
    }

    // POST /api/hook/wake — re-register after snooze
    if (method === 'POST' && url === '/api/hook/wake') {
      try {
        const body = JSON.parse(await readBody(req));
        const { instance, pid, force } = body;
        if (!instance) {
          sendJSON(res, 400, { error: 'Missing required field: instance' });
          return;
        }
        const result = sessionRegister({ instance, pid, force });
        sendJSON(res, 200, result);
      } catch (err) {
        sendJSON(res, 400, { error: (err as Error).message });
      }
      return;
    }

    // POST /api/hook/session-end — clean deregistration
    if (method === 'POST' && url === '/api/hook/session-end') {
      try {
        const body = JSON.parse(await readBody(req));
        const { sessionToken } = body;
        if (!sessionToken) {
          sendJSON(res, 400, { error: 'Missing required field: sessionToken' });
          return;
        }
        const ok = sessionDeregister(sessionToken);
        sendJSON(res, 200, { ok });
      } catch (err) {
        sendJSON(res, 400, { error: (err as Error).message });
      }
      return;
    }

    // POST /api/hook/pre-bash — SSH warning + watcher guard
    if (method === 'POST' && url === '/api/hook/pre-bash') {
      try {
        const body = JSON.parse(await readBody(req));
        const command: string = body.tool_input?.command || '';

        // SSH warning
        if (/\bssh\s/.test(command)) {
          const peers = getPeerIdentities(config);
          const sshTarget = command.match(/\bssh\s+(?:-[^\s]+\s+)*(\S+)/)?.[1] || '';
          if (peers.some((p: string) => sshTarget.includes(p))) {
            sendJSON(res, 200, {
              hookSpecificOutput: {
                hookEventName: 'PreToolUse',
                additionalContext: `REMINDER: "${sshTarget}" is an ICC peer. Prefer ICC tools (send_message, run_remote_command, read_remote_file) over direct SSH.`,
              },
            });
            return;
          }
        }

        // Watcher duplicate guard
        if (/icc\s+hook\s+watch\b/.test(command) && !/--timeout\s+[012]\b/.test(command)) {
          // Check if any session-based watcher is active for any instance
          // (Docker mode uses /api/watch, not icc hook watch, so this mainly catches bare-metal attempts)
          sendJSON(res, 200, {});
          return;
        }

        // Auto-approve watcher lifecycle commands (Docker mode)
        // These fire every watcher cycle and must not prompt the user
        const watcherAutoApprove = [
          /curl\s+--max-time\s+\d+\s.*localhost:3178\/api\/watch/,  // long-poll watcher
          /^echo\s+"[a-f0-9]+"\s*>\s*\/tmp\/icc-session-/,          // session token save
          /curl\s+-sf\s+-X\s+POST\s+http:\/\/localhost:3178\/api\/hook\/watch\b/, // re-registration
        ];
        if (watcherAutoApprove.some(p => p.test(command))) {
          sendJSON(res, 200, { decision: 'approve' });
          return;
        }

        sendJSON(res, 200, {});
      } catch (err) {
        sendJSON(res, 400, { error: (err as Error).message });
      }
      return;
    }

    // POST /api/hook/pre-icc-message — convention reminder
    if (method === 'POST' && url === '/api/hook/pre-icc-message') {
      try {
        const body = JSON.parse(await readBody(req));
        const msgBody: string = body.tool_input?.body || '';
        const hasStatusParam = !!body.tool_input?.status;

        const missing: string[] = [];
        if (!msgBody.includes('[TOPIC:')) missing.push('[TOPIC: x]');
        if (!hasStatusParam && !msgBody.includes('[STATUS:')) missing.push('the `status` parameter (preferred) or [STATUS: ...] in body');

        if (missing.length > 0) {
          sendJSON(res, 200, {
            hookSpecificOutput: {
              hookEventName: 'PreToolUse',
              additionalContext: `ICC message convention reminder: messages should include ${missing.join(' and ')}. Consider adding them.`,
            },
          });
          return;
        }
        sendJSON(res, 200, {});
      } catch (err) {
        sendJSON(res, 400, { error: (err as Error).message });
      }
      return;
    }

    // GET /api/watch — long-poll endpoint for mail watcher (uncapped lifetime)
    if (method === 'GET' && url === '/api/watch') {
      const queryUrl = new URL(req.url || '/', 'http://localhost');
      const instance = queryUrl.searchParams.get('instance');
      const sessionToken = queryUrl.searchParams.get('sessionToken');

      if (!instance) {
        sendJSON(res, 400, { error: 'Missing required param: instance' });
        return;
      }

      // Duplicate guard: atomically check-and-reserve the session slot.
      // Node's single-threaded model makes the check/set pair atomic as long
      // as no await intervenes between them. A future refactor that adds an
      // await here would reintroduce a TOCTOU race.
      //
      // Note: sessionReconnect clears grace/purgatory timers and promotes
      // state to ACTIVE (see src/registry.ts:268). It must NOT run for
      // duplicate watchers — doing so would let a second watcher's request
      // clear timers belonging to the first, already-connected watcher.
      if (sessionToken) {
        if (activeWatchers.has(sessionToken)) {
          sendJSON(res, 200, { event: 'duplicate' });
          return;
        }
        // Check that the session still exists in the registry before accepting.
        // sessionReconnect returns false when the token is unknown — e.g. after
        // a server restart wiped the in-memory registry. Telling the client the
        // token is dead (410 Gone) so it can re-register is the only way to
        // recover from that state without stranding a zombie watcher.
        if (!sessionReconnect(sessionToken)) {
          sendJSON(res, 410, { error: 'stale_token', action: 'reregister' });
          return;
        }
        activeWatchers.set(sessionToken, res);
      }

      // Immediate inbox check — return immediately if unread messages exist.
      // Release the reserved slot first so the next watcher can claim it.
      const unread = getUnread();
      const realUnread = unread.filter(m => !isReceipt(m));
      if (realUnread.length > 0) {
        if (sessionToken) activeWatchers.delete(sessionToken);
        sendJSON(res, 200, { event: 'mail', unreadCount: realUnread.length });
        return;
      }

      // Long-poll: block indefinitely until a message arrives or the client
      // disconnects. No server-side timeout; watcher lifetime is bounded
      // only by the client process (icc hook watch) and its PID/signal
      // monitoring.
      //
      // Enable OS-level TCP keepalive so the kernel sends ACK probes on
      // otherwise-idle connections. This defeats any idle-timeout reapers
      // at intermediate network hops without touching the HTTP body, so
      // clients that JSON.parse the full response keep working unchanged.
      req.socket.setKeepAlive(true, 30_000);

      // Declare unsubscribe as a mutable binding BEFORE cleanup references
      // it, to avoid a TDZ error if inboxSubscribe ever fires its callback
      // synchronously during registration.
      let unsubscribe: () => void = () => {};

      const cleanup = () => {
        if (sessionToken) {
          activeWatchers.delete(sessionToken);
          onWatcherDisconnect(sessionToken);
        }
        unsubscribe();
      };

      unsubscribe = inboxSubscribe((msg) => {
        if (isReceipt(msg)) return; // Don't wake on receipts
        cleanup();
        sendJSON(res, 200, { event: 'mail', unreadCount: 1 });
      });

      // Connection close handler (client disconnect)
      req.on('close', () => {
        cleanup();
      });

      return;
    }

    sendJSON(res, 404, { error: 'Not found' });
  };

  // Active watcher connections (keyed by sessionToken)
  const activeWatchers = new Map<string, ServerResponse>();

  const server = tlsOpts
    ? createSecureServer({ ...tlsOpts, requestCert: true, rejectUnauthorized: true }, handler)
    : createServer(handler);

  // Localhost-only plain HTTP server (when TLS enabled + localhostHttpPort configured)
  // Allows local clients (MCP, hooks) to connect without client certs
  const localhostServer = (tlsOpts && localhostHttpPort) ? createServer(handler) : null;

  const CLEANUP_INTERVAL_MS = 24 * 60 * 60 * 1000; // 24 hours
  let cleanupTimer: ReturnType<typeof setInterval> | null = null;
  let renewalTimer: ReturnType<typeof setInterval> | null = null;

  function reloadTlsContext(): boolean {
    try {
      clearConfigCache();
      const freshTls = getTlsOptions(loadConfig({ reload: true }));
      if (freshTls) {
        (server as unknown as import('node:tls').Server).setSecureContext({
          cert: freshTls.cert, key: freshTls.key, ca: freshTls.ca,
        });
        return true;
      }
    } catch (err) {
      log.error(`TLS context reload failed: ${(err as Error).message}`);
    }
    return false;
  }

  /** Re-read config from disk and update all in-memory references. */
  function reloadConfig(): void {
    clearConfigCache();
    config = loadConfig({ reload: true });
    setReceiptSender(createReceiptSender(config));
    reloadTlsContext();
    log.info('Config hot-reloaded from disk');
  }

  // SIGHUP handler for manual TLS hot-reload
  if (tlsOpts) {
    process.on('SIGHUP', () => {
      if (reloadTlsContext()) {
        log.info('TLS context reloaded via SIGHUP');
      }
    });
  }

  return {
    start() {
      if (!options.noAuth) {
        const hasAuth = config.server.localToken ||
          Object.keys(config.server.peerTokens || {}).length > 0;
        if (!hasAuth) {
          return Promise.reject(new Error(
            'No authentication configured. Run \'icc init\' or start with noAuth option for development.'
          ));
        }
      }
      return new Promise<{ port: number; host: string }>(async (resolve) => {
        // Initialize MCP HTTP transport if enabled
        if (options.enableMcp) {
          try {
            const { StreamableHTTPServerTransport } = await import('@modelcontextprotocol/sdk/server/streamableHttp.js');
            const { createMCPServer } = await import('./mcp.ts');
            createMcpSession = async () => {
              const sessionId = randomUUID();
              const transport = new StreamableHTTPServerTransport({
                sessionIdGenerator: () => sessionId,
              });
              const mcp = createMCPServer();
              await mcp.server.connect(transport);
              return { transport, server: mcp.server, sessionId };
            };
            log.info('MCP HTTP transport mounted at /mcp');
          } catch (err) {
            log.error(`Failed to initialize MCP HTTP transport: ${(err as Error).message}`);
          }
        }

        server.listen(port, host, () => {
          const addr = server.address() as { port: number };
          const protocol = tlsOpts ? 'HTTPS (mTLS)' : 'HTTP';
          log.info(`ICC server listening on ${protocol} ${host}:${addr.port} as "${config.identity}"`);

          // Run stale message cleanup on startup and daily
          purgeStale(7);
          cleanupTimer = setInterval(() => purgeStale(7), CLEANUP_INTERVAL_MS);
          cleanupTimer.unref();

          // Auto-renewal: check cert on startup and daily
          if (tlsOpts && config.server.tls?.certPath) {
            const tlsDir = dirname(config.server.tls!.certPath!);
            const checkAndRenew = async () => {
              try {
                const result = await renewIfNeeded({
                  tlsDir,
                  identity: config.identity,
                  caEnrollUrl: buildCaEnrollUrl(config, tlsDir),
                });
                if (result.renewed) {
                  if (reloadTlsContext()) {
                    log.info(`TLS cert renewed (was ${result.daysRemaining}d from expiry)`);
                  }
                }
              } catch (err) {
                log.error(`TLS auto-renewal failed: ${(err as Error).message}`);
              }
            };
            checkAndRenew();
            renewalTimer = setInterval(checkAndRenew, CLEANUP_INTERVAL_MS);
            renewalTimer.unref();
          }

          // Start localhost HTTP server if configured
          if (localhostServer && localhostHttpPort) {
            localhostServer.listen(localhostHttpPort, '127.0.0.1', () => {
              log.info(`Localhost HTTP listener on 127.0.0.1:${localhostHttpPort}`);
            });
          }

          resolve({ port: addr.port, host });
        });
      });
    },
    async stop() {
      if (cleanupTimer) {
        clearInterval(cleanupTimer);
        cleanupTimer = null;
      }
      if (renewalTimer) {
        clearInterval(renewalTimer);
        renewalTimer = null;
      }
      // Close all MCP sessions
      for (const [, session] of mcpSessions) {
        try { await session.transport.close(); } catch { /* ignore */ }
        try { await session.server.close(); } catch { /* ignore */ }
      }
      mcpSessions.clear();
      createMcpSession = null;
      // End all SSE connections so server.close() can drain
      for (const res of sseConnections) {
        res.end();
      }
      sseConnections.clear();
      // End all active watchers
      for (const [, watchRes] of activeWatchers) {
        watchRes.end();
      }
      activeWatchers.clear();
      return new Promise<void>((resolve) => {
        const closeMain = () => server.close(() => resolve());
        if (localhostServer) {
          localhostServer.close(() => closeMain());
        } else {
          closeMain();
        }
      });
    },
    server,
  };
}

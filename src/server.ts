import { createServer, request as httpRequest } from 'node:http';
import { createServer as createSecureServer, request as httpsRequest } from 'node:https';
import type { IncomingMessage, ServerResponse, Server } from 'node:http';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { timingSafeEqual } from 'node:crypto';
import { loadConfig, getFullAddress, getOutboundToken, getTlsOptions } from './config.ts';
import { buildAddress, parseAddress } from './address.ts';
import { validate, createResponse, createError, createPong, serialize } from './protocol.ts';
import { invokeClaudeCLI } from './claude.ts';
import { createLogger } from './util/logger.ts';
import { readBody, sendJSON as baseSendJSON } from './util/http.ts';
import { init as initLog, record, getAll, remove as logRemove, subscribe } from './log.ts';
import { init as initInbox, push as inboxPush, getUnread, getAll as inboxGetAll, getById as inboxGetById, markRead, markAllRead, remove as inboxRemove, purgeStale, setNotifier, setReceiptSender, isReceipt } from './inbox.ts';
import { safeReadFile, safeExec } from './util/exec.ts';
import { register as registryRegister, list as registryList, deregister as registryDeregister } from './registry.ts';
import { listAll as instancesListAll } from './instances.ts';
import { createDesktopNotifier } from './notify.ts';
import { registrySchema, inboxSchema, execSchema, readfileSchema } from './api-schemas.ts';
import type { Message, ICCConfig, AuthResult } from './types.ts';

const log = createLogger('server');

const CORS_SEND_HEADERS: Record<string, string> = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
};

function sendJSON(res: ServerResponse, statusCode: number, data: unknown): void {
  baseSendJSON(res, statusCode, data, CORS_SEND_HEADERS);
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
  const { localToken, peerTokens, authToken } = config.server;
  const hasAnyToken = localToken || authToken || (peerTokens && Object.keys(peerTokens).length > 0);

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

  // Check legacy authToken
  if (authToken && safeTokenEquals(token, authToken)) {
    log.warn('Authentication via legacy authToken — migrate to per-peer tokens');
    return { authenticated: true, identity: '_legacy' };
  }

  return { authenticated: false, identity: null };
}

/**
 * Validate that the `from` field in a message matches the authenticated identity.
 */
function validateFrom(authIdentity: string | null, fromField: string): boolean {
  if (authIdentity === '_local' || authIdentity === '_legacy') return true;
  if (!fromField) return false;
  return parseAddress(fromField).host === authIdentity;
}

async function handleMessage(message: Message): Promise<Message> {
  if (message.type === 'ping') {
    return createPong(message.id);
  }

  if (message.type === 'request') {
    // Log the incoming request
    record(message);

    const prompt = 'prompt' in message.payload ? (message.payload.prompt as string) : undefined;
    if (!prompt) {
      return createError(message.id, 'Missing prompt in request');
    }

    try {
      log.info(`Processing request ${message.id} from ${message.from}`);
      const result = await invokeClaudeCLI(prompt);
      const response = createResponse(message.id, result);
      record(response);
      return response;
    } catch (err) {
      log.error(`Claude invocation failed: ${(err as Error).message}`);
      const errMsg = createError(message.id, (err as Error).message);
      record(errMsg);
      return errMsg;
    }
  }

  return createError(message.id, `Unsupported message type: ${message.type}`);
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
}

interface ICCServer {
  start(): Promise<{ port: number; host: string }>;
  stop(): Promise<void>;
  server: Server;
}

export function createICCServer(options: ICCServerOptions = {}): ICCServer {
  const config = loadConfig();
  const port = options.port ?? config.server.port;
  const host = options.host ?? config.server.host;
  const tlsOpts = getTlsOptions(config);
  const startTime = Date.now();
  const sseConnections = new Set<ServerResponse>();

  // Initialize message log, inbox, desktop notifications, and read receipts
  initLog();
  initInbox();
  setNotifier(createDesktopNotifier(config));
  setReceiptSender(createReceiptSender(config));

  const handler = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const { method } = req;
    // Strip query string for route matching
    const url = (req.url || '').split('?')[0]!;
    log.debug(`${method} ${url}`);

    // CORS preflight
    if (method === 'OPTIONS') {
      res.writeHead(204, CORS_SEND_HEADERS);
      res.end();
      return;
    }

    // Help/usage — no auth required (like MCP discovery)
    if (method === 'GET' && url === '/api/help') {
      sendJSON(res, 200, {
        name: 'Inter-Claude Connector (ICC)',
        version: '1',
        identity: config.identity,
        description: 'Bidirectional communication between Claude Code instances. Send prompts to a remote Claude and receive responses.',
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
            description: 'Send an ICC protocol message. The server validates the message, and if it is a request, invokes Claude CLI with the prompt and returns the response.',
            body: '{ version: "1", id: "<uuid>", type: "request"|"ping", from: "<identity>", timestamp: "<iso8601>", payload: { prompt: "<text>", context?: {} } }',
            response: '{ version, id, type: "response"|"pong"|"error", from, timestamp, replyTo, payload: { result } }',
          },
          'POST /api/ping': {
            auth: true,
            description: 'Quick connectivity check. Returns a pong message.',
            response: '{ type: "pong", ... }',
          },
          'POST /api/record': {
            auth: true,
            description: 'Push a message into the server log and SSE stream without processing it. Used by the web UI to record outgoing messages.',
            body: '<any JSON object>',
          },
          'GET /api/log': {
            auth: true,
            description: 'Retrieve message history (in-memory ring buffer, up to 1000 messages).',
            response: '[...messages]',
          },
          'POST /api/log/delete': {
            auth: true,
            description: 'Delete protocol messages by ID.',
            body: '{ ids: ["<id>", ...] }',
            response: '{ ok: true, deleted: <count> }',
          },
          'GET /api/events': {
            auth: true,
            description: 'SSE stream of real-time message events. Supports ?token= query param for auth since EventSource cannot set headers.',
            response: 'text/event-stream — each event is a JSON message object',
          },
          'POST /api/inbox': {
            auth: true,
            description: 'Push a message into the inbox. Server generates id, timestamp, and read:false. Optional "to" field for instance addressing (e.g. "mars/myapp"); defaults to broadcast (bare hostname). Optional "threadId" groups related messages in a conversation.',
            body: '{ from: "<address>", to?: "<address>", body: "<message text>", replyTo?: "<message-id>", threadId?: "<uuid>", _meta?: { recipients?: ["<addr>", ...] } }',
            response: '{ ok: true, id: "<uuid>", threadId: "<uuid>"|null }',
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
        },
        protocol: {
          messageTypes: ['request', 'response', 'error', 'ping', 'pong'],
          version: '1',
          fields: {
            version: 'Protocol version (always "1")',
            id: 'UUID v4 message identifier',
            type: 'One of: request, response, error, ping, pong',
            from: 'Identity of the sender (e.g. "mars", "jupiter")',
            timestamp: 'ISO 8601 timestamp',
            payload: 'Type-specific data — request: { prompt, context? }, response: { result }, error: { error }',
            replyTo: '(response/error/pong only) ID of the message being replied to',
          },
        },
        examples: {
          sendRequest: {
            description: 'Send a prompt to the remote Claude',
            curl: `curl -X POST http://localhost:${port}/api/message -H "Content-Type: application/json" -H "Authorization: Bearer <token>" -d '{"version":"1","id":"<uuid>","type":"request","from":"<identity>","timestamp":"<iso8601>","payload":{"prompt":"Hello, what is 2+2?"}}'`,
          },
          ping: {
            description: 'Check connectivity',
            curl: `curl -X POST http://localhost:${port}/api/ping -H "Authorization: Bearer <token>"`,
          },
          health: {
            description: 'Check server status (no auth needed)',
            curl: `curl http://localhost:${port}/api/health`,
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
      const tlsDir = process.env.ICC_TLS_DIR || join(homedir(), '.icc', 'tls');
      const challengePath = join(tlsDir, '.challenge');
      try {
        if (existsSync(challengePath)) {
          const token = readFileSync(challengePath, 'utf-8').trim();
          res.writeHead(200, { 'Content-Type': 'text/plain', ...CORS_SEND_HEADERS });
          res.end(token);
        } else {
          sendJSON(res, 404, { error: 'No active challenge' });
        }
      } catch {
        sendJSON(res, 500, { error: 'Challenge read error' });
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
      sendJSON(res, 200, { instances: registryList(), host: config.identity });
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

    // Message log — return history
    if (method === 'GET' && url === '/api/log') {
      sendJSON(res, 200, getAll());
      return;
    }

    // Message log — delete by IDs
    if (method === 'POST' && url === '/api/log/delete') {
      try {
        const body = await readBody(req);
        const { ids } = JSON.parse(body);
        if (!ids || !Array.isArray(ids)) {
          sendJSON(res, 400, { error: 'Missing required field: ids (array)' });
          return;
        }
        const deleted = logRemove(ids);
        sendJSON(res, 200, { ok: true, deleted });
      } catch (err) {
        sendJSON(res, 400, { error: (err as Error).message });
      }
      return;
    }

    // SSE stream — real-time message updates
    if (method === 'GET' && url === '/api/events') {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
        ...CORS_SEND_HEADERS,
      });
      res.write(':\n\n'); // SSE comment to establish connection

      sseConnections.add(res);
      const unsubscribe = subscribe((message) => {
        res.write(`data: ${JSON.stringify(message)}\n\n`);
      });

      req.on('close', () => {
        sseConnections.delete(res);
        unsubscribe();
      });
      return;
    }

    // Record endpoint — external processes push messages into the server's log
    if (method === 'POST' && url === '/api/record') {
      try {
        const body = await readBody(req);
        const message = JSON.parse(body);
        if (!validate(message)) {
          sendJSON(res, 400, { error: 'Invalid message format' });
          return;
        }
        record(message);
        sendJSON(res, 200, { ok: true });
      } catch (err) {
        sendJSON(res, 400, { error: (err as Error).message });
      }
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
        const { from, to, body: msgBody, replyTo, threadId, _meta } = parsed.data;
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
        const msg = inboxPush({ from, to: destination, body: msgBody, replyTo, threadId, _meta }, { silent });
        sendJSON(res, 200, { ok: true, id: msg.id, threadId: msg.threadId });
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

    sendJSON(res, 404, { error: 'Not found' });
  };

  const server = tlsOpts
    ? createSecureServer({ ...tlsOpts, requestCert: true, rejectUnauthorized: true }, handler)
    : createServer(handler);

  const CLEANUP_INTERVAL_MS = 24 * 60 * 60 * 1000; // 24 hours
  let cleanupTimer: ReturnType<typeof setInterval> | null = null;

  return {
    start() {
      return new Promise<{ port: number; host: string }>((resolve) => {
        server.listen(port, host, () => {
          const addr = server.address() as { port: number };
          const protocol = tlsOpts ? 'HTTPS (mTLS)' : 'HTTP';
          log.info(`ICC server listening on ${protocol} ${host}:${addr.port} as "${config.identity}"`);

          // Run stale message cleanup on startup and daily
          purgeStale(7);
          cleanupTimer = setInterval(() => purgeStale(7), CLEANUP_INTERVAL_MS);
          cleanupTimer.unref(); // Don't keep process alive just for cleanup

          resolve({ port: addr.port, host });
        });
      });
    },
    stop() {
      if (cleanupTimer) {
        clearInterval(cleanupTimer);
        cleanupTimer = null;
      }
      // End all SSE connections so server.close() can drain
      for (const res of sseConnections) {
        res.end();
      }
      sseConnections.clear();
      return new Promise<void>((resolve) => {
        server.close(() => resolve());
      });
    },
    server,
  };
}

import { createServer, request as httpRequest } from 'node:http';
import type { IncomingMessage, ServerResponse, Server } from 'node:http';
import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { signCSR } from './tls.ts';
import { createLogger } from './util/logger.ts';
import { readBody, sendJSON } from './util/http.ts';

const log = createLogger('enroll');

interface EnrollmentOptions {
  caDir: string;
  peerConfigs: Record<string, { httpUrl: string }>;
  host?: string;
  port?: number;
  challengeTTL?: number;
  certDays?: number;
  reloadToken?: string;
}

interface EnrollmentEntry {
  identity: string;
  challenge: string;
  caAddress: string | null;
  expiresAt: number;
}

interface EnrollmentServer {
  _server: Server;
  start(): Promise<{ port: number; host: string }>;
  stop(): Promise<void>;
}

interface JoinEntry {
  identity: string;
  joinToken: string;
  ip: string;
  port: number;
  expiresAt: number;
}

export function createEnrollmentServer(options: EnrollmentOptions): EnrollmentServer {
  const {
    caDir,
    host = '0.0.0.0',
    port = 4179,
    challengeTTL = 300_000,
    certDays = 365,
    reloadToken,
  } = options;

  let peerConfigs = { ...options.peerConfigs };
  const enrollments = new Map<string, EnrollmentEntry>();
  const joinTokens = new Map<string, JoinEntry>();
  const rateLimits = new Map<string, { count: number; resetAt: number }>();
  const RATE_LIMIT = 3;
  const RATE_WINDOW = 15 * 60 * 1000; // 15 minutes

  function checkRateLimit(identity: string): boolean {
    const now = Date.now();
    const entry = rateLimits.get(identity);
    if (!entry || now >= entry.resetAt) {
      rateLimits.set(identity, { count: 1, resetAt: now + RATE_WINDOW });
      return true;
    }
    if (entry.count >= RATE_LIMIT) return false;
    entry.count++;
    return true;
  }

  function verifyChallenge(peerHttpUrl: string, expectedToken: string): Promise<boolean> {
    return new Promise((resolve) => {
      const url = new URL('/.well-known/icc-challenge', peerHttpUrl);
      const req = httpRequest(url, { method: 'GET', timeout: 10000 }, (res) => {
        let data = '';
        res.on('data', (chunk: Buffer) => { data += chunk; });
        res.on('end', () => {
          resolve(data.trim() === expectedToken);
        });
      });
      req.on('error', () => resolve(false));
      req.on('timeout', () => { req.destroy(); resolve(false); });
      req.end();
    });
  }

  function purgeExpired(): void {
    const now = Date.now();
    for (const [id, enrollment] of enrollments) {
      if (enrollment.expiresAt < now) enrollments.delete(id);
    }
  }

  function pushMeshUpdate(config: { remotes: Record<string, { httpUrl?: string; token?: string }> }, peerIdentity: string, payload: unknown): void {
    const peer = config.remotes[peerIdentity];
    if (!peer?.httpUrl) return;
    const token = peer.token || '';
    const url = new URL('/api/mesh-update', peer.httpUrl);
    const data = JSON.stringify(payload);
    const isHttps = url.protocol === 'https:';
    const reqFn = isHttps ? (import('node:https').then(m => m.request)) : Promise.resolve(httpRequest);
    reqFn.then(requestFn => {
      const req = requestFn(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': String(Buffer.byteLength(data)),
          'Authorization': `Bearer ${token}`,
        },
        timeout: 10000,
      });
      req.on('error', (err: Error) => log.warn(`mesh-update push to ${peerIdentity} failed: ${err.message}`));
      req.on('timeout', () => { req.destroy(); });
      req.write(data);
      req.end();
    }).catch((err: Error) => log.warn(`mesh-update push to ${peerIdentity} failed: ${err.message}`));
  }

  const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    const { method } = req;
    const url = (req.url || '').split('?')[0];

    if (method === 'POST' && url === '/enroll') {
      try {
        const body = JSON.parse(await readBody(req));
        const { identity } = body;

        if (!identity) {
          sendJSON(res, 400, { error: 'Missing identity field' });
          return;
        }

        if (!peerConfigs[identity]) {
          log.warn(`Enrollment rejected: unknown peer "${identity}"`);
          sendJSON(res, 403, { error: `Unknown peer: "${identity}". Must be in CA remotes config.` });
          return;
        }

        if (!checkRateLimit(identity)) {
          const retryAfter = Math.ceil(RATE_WINDOW / 1000);
          res.writeHead(429, { 'Retry-After': String(retryAfter), 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Rate limit exceeded' }));
          return;
        }

        purgeExpired();
        for (const [id, enrollment] of enrollments) {
          if (enrollment.identity === identity) {
            enrollments.delete(id);
            log.info(`Replaced existing enrollment for "${identity}"`);
          }
        }

        const enrollmentId = randomBytes(16).toString('hex');
        const challenge = randomBytes(32).toString('hex');

        enrollments.set(enrollmentId, {
          identity,
          challenge,
          caAddress: null,
          expiresAt: Date.now() + challengeTTL,
        });

        log.info(`Enrollment started for "${identity}" (id: ${enrollmentId.slice(0, 8)}...)`);
        sendJSON(res, 200, { enrollmentId, challenge });
      } catch (err) {
        sendJSON(res, 400, { error: (err as Error).message });
      }
      return;
    }

    if (method === 'POST' && url === '/enroll/csr') {
      try {
        const body = JSON.parse(await readBody(req));
        const { enrollmentId, csr } = body;

        if (!enrollmentId || !csr) {
          sendJSON(res, 400, { error: 'Missing enrollmentId or csr' });
          return;
        }

        purgeExpired();
        const enrollment = enrollments.get(enrollmentId);
        if (!enrollment) {
          sendJSON(res, 400, { error: 'Invalid or expired enrollmentId' });
          return;
        }

        const { identity, challenge } = enrollment;
        const peerConfig = peerConfigs[identity];

        log.info(`Verifying challenge for "${identity}" at ${peerConfig!.httpUrl}`);
        const verified = await verifyChallenge(peerConfig!.httpUrl, challenge);

        if (!verified) {
          enrollments.delete(enrollmentId);
          log.warn(`Challenge verification failed for "${identity}"`);
          sendJSON(res, 403, { error: 'Challenge verification failed' });
          return;
        }

        log.info(`Challenge verified for "${identity}", signing CSR`);
        const cert = signCSR(caDir, csr, identity, certDays);
        const caCert = readFileSync(join(caDir, 'ca.crt'), 'utf-8');

        enrollments.delete(enrollmentId);

        log.info(`Certificate issued for "${identity}"`);
        sendJSON(res, 200, { cert, caCert });
      } catch (err) {
        log.error(`CSR signing error: ${(err as Error).message}`);
        sendJSON(res, 500, { error: (err as Error).message });
      }
      return;
    }

    // POST /enroll/reload — re-read config for updated peer list
    if (method === 'POST' && url === '/enroll/reload') {
      try {
        const authHeader = req.headers.authorization;
        if (!reloadToken || authHeader !== `Bearer ${reloadToken}`) {
          sendJSON(res, 401, { error: 'Unauthorized' });
          return;
        }
        const { clearConfigCache, loadConfig } = await import('./config.ts');
        clearConfigCache();
        const config = loadConfig();
        peerConfigs = {};
        for (const [id, peer] of Object.entries(config.remotes || {})) {
          if (peer.httpUrl) peerConfigs[id] = { httpUrl: peer.httpUrl };
        }
        peerConfigs[config.identity] = { httpUrl: `http://127.0.0.1:${config.server.port}` };
        log.info(`Enrollment config reloaded: ${Object.keys(peerConfigs).join(', ')}`);
        sendJSON(res, 200, { ok: true, peers: Object.keys(peerConfigs) });
      } catch (err) {
        sendJSON(res, 500, { error: (err as Error).message });
      }
      return;
    }

    // POST /enroll/register-invite — store a join token for a pending invite
    if (method === 'POST' && url === '/enroll/register-invite') {
      try {
        const authHeader = req.headers.authorization;
        if (!reloadToken || authHeader !== `Bearer ${reloadToken}`) {
          sendJSON(res, 401, { error: 'Unauthorized' });
          return;
        }
        const body = JSON.parse(await readBody(req));
        const { identity, joinToken, ip, port: joinPort } = body;
        if (!identity || !joinToken) {
          sendJSON(res, 400, { error: 'Missing identity or joinToken' });
          return;
        }
        joinTokens.set(identity, {
          identity,
          joinToken,
          ip: ip || '0.0.0.0',
          port: joinPort || 3179,
          expiresAt: Date.now() + 15 * 60 * 1000,
        });
        log.info(`Join token registered for "${identity}" (expires in 15min)`);
        sendJSON(res, 200, { ok: true });
      } catch (err) {
        sendJSON(res, 400, { error: (err as Error).message });
      }
      return;
    }

    // POST /enroll/join — new host authenticates with a join token
    if (method === 'POST' && url === '/enroll/join') {
      try {
        const body = JSON.parse(await readBody(req));
        const { identity, joinToken, httpUrl, caAddress } = body;

        if (!identity || !joinToken) {
          sendJSON(res, 400, { error: 'Missing identity or joinToken' });
          return;
        }

        const invite = joinTokens.get(identity);
        if (!invite || invite.joinToken !== joinToken) {
          sendJSON(res, 403, { error: 'Invalid or expired join token' });
          return;
        }
        if (Date.now() > invite.expiresAt) {
          joinTokens.delete(identity);
          sendJSON(res, 403, { error: 'Join token expired' });
          return;
        }

        if (!checkRateLimit(identity)) {
          const retryAfter = Math.ceil(RATE_WINDOW / 1000);
          res.writeHead(429, { 'Retry-After': String(retryAfter), 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Rate limit exceeded' }));
          return;
        }

        // Update peerConfigs with the joining host's URL
        if (httpUrl) peerConfigs[identity] = { httpUrl };

        // Generate enrollment challenge (reuse existing mechanism)
        const challenge = randomBytes(32).toString('hex');
        const enrollmentId = randomBytes(16).toString('hex');
        enrollments.set(enrollmentId, {
          identity,
          challenge,
          caAddress: caAddress || null,
          expiresAt: Date.now() + challengeTTL,
        });

        log.info(`Join started for "${identity}" (enrollment ${enrollmentId.slice(0, 8)}...)`);
        sendJSON(res, 200, { enrollmentId, challenge });
      } catch (err) {
        sendJSON(res, 400, { error: (err as Error).message });
      }
      return;
    }

    // POST /enroll/join/complete — verify challenge, sign CSR, return cert + peer list
    if (method === 'POST' && url === '/enroll/join/complete') {
      try {
        const body = JSON.parse(await readBody(req));
        const { enrollmentId, csr } = body;

        if (!enrollmentId || !csr) {
          sendJSON(res, 400, { error: 'Missing enrollmentId or csr' });
          return;
        }

        purgeExpired();
        const entry = enrollments.get(enrollmentId);
        if (!entry) {
          sendJSON(res, 400, { error: 'Invalid or expired enrollmentId' });
          return;
        }

        const peerConfig = peerConfigs[entry.identity];
        if (!peerConfig) {
          sendJSON(res, 400, { error: `No config for "${entry.identity}"` });
          return;
        }

        log.info(`Verifying challenge for join: "${entry.identity}" at ${peerConfig.httpUrl}`);
        const verified = await verifyChallenge(peerConfig.httpUrl, entry.challenge);

        if (!verified) {
          enrollments.delete(enrollmentId);
          log.warn(`Join challenge verification failed for "${entry.identity}"`);
          sendJSON(res, 403, { error: 'Challenge verification failed' });
          return;
        }

        // Sign CSR
        log.info(`Challenge verified for "${entry.identity}", signing CSR`);
        const cert = signCSR(caDir, csr, entry.identity, certDays);
        const caCert = readFileSync(join(caDir, 'ca.crt'), 'utf-8');
        enrollments.delete(enrollmentId);

        // Build peer list with bidirectional tokens for existing peers
        const { loadConfig, writeConfig } = await import('./config.ts');
        const config = loadConfig({ reload: true });
        const peers: { identity: string; httpsUrl: string; outboundToken: string; inboundToken: string }[] = [];

        for (const [peerIdentity, peerRemote] of Object.entries(config.remotes || {})) {
          if (peerIdentity === entry.identity) continue;
          if (!peerRemote.httpUrl) continue;

          const tokenForNewHost = randomBytes(32).toString('hex');
          const tokenFromNewHost = randomBytes(32).toString('hex');

          peers.push({
            identity: peerIdentity,
            httpsUrl: peerRemote.httpUrl,
            outboundToken: tokenForNewHost,
            inboundToken: tokenFromNewHost,
          });

          // Push mesh-update to existing peer (best-effort)
          const invite = joinTokens.get(entry.identity);
          const httpsUrl = invite ? `https://${invite.ip}:${invite.port}` : '';
          pushMeshUpdate(config, peerIdentity, {
            action: 'add-peer',
            peer: {
              identity: entry.identity,
              httpsUrl,
              peerToken: tokenFromNewHost,
            },
            outboundToken: tokenForNewHost,
          });
        }

        // Include CA itself as a peer for the joining host
        if (entry.caAddress && config.server.port) {
          const caOutbound = randomBytes(32).toString('hex');  // CA → new host
          const caInbound = randomBytes(32).toString('hex');    // new host → CA

          peers.push({
            identity: config.identity,
            httpsUrl: `https://${entry.caAddress}:${config.server.port}`,
            outboundToken: caInbound,   // new host uses this to talk TO CA
            inboundToken: caOutbound,   // new host accepts this FROM CA
          });

          // Update CA's own config for this peer
          if (!config.server.peerTokens) config.server.peerTokens = {};
          config.server.peerTokens[entry.identity] = caInbound;  // accept from new host
          if (config.remotes[entry.identity]) {
            config.remotes[entry.identity]!.token = caOutbound;   // send to new host
          }
        }

        // Update CA config: set new peer's URL to https
        const invite = joinTokens.get(entry.identity);
        if (invite && config.remotes[entry.identity]) {
          config.remotes[entry.identity]!.httpUrl = `https://${invite.ip}:${invite.port}`;
        }
        writeConfig(config);
        joinTokens.delete(entry.identity);

        log.info(`Join complete for "${entry.identity}" — ${peers.length} peers configured`);
        sendJSON(res, 200, { cert, caCert, peers });
      } catch (err) {
        log.error(`Join complete error: ${(err as Error).message}`);
        sendJSON(res, 500, { error: (err as Error).message });
      }
      return;
    }

    sendJSON(res, 404, { error: 'Not found' });
  });

  return {
    _server: server,
    start() {
      return new Promise<{ port: number; host: string }>((resolve) => {
        server.listen(port, host, () => {
          const addr = server.address() as { port: number };
          log.info(`Enrollment server listening on ${host}:${addr.port}`);
          resolve({ port: addr.port, host });
        });
      });
    },
    stop() {
      return new Promise<void>((resolve) => {
        server.close(() => resolve());
      });
    },
  };
}

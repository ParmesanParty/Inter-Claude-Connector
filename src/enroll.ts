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
}

interface EnrollmentEntry {
  identity: string;
  challenge: string;
  expiresAt: number;
}

interface EnrollmentServer {
  _server: Server;
  start(): Promise<{ port: number; host: string }>;
  stop(): Promise<void>;
}

export function createEnrollmentServer(options: EnrollmentOptions): EnrollmentServer {
  const {
    caDir,
    peerConfigs,
    host = '0.0.0.0',
    port = 4179,
    challengeTTL = 300_000,
    certDays = 365,
  } = options;

  const enrollments = new Map<string, EnrollmentEntry>();
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

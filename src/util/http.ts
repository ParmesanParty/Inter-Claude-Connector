import type { IncomingMessage, ServerResponse } from 'node:http';
import { request } from 'node:http';

const DEFAULT_MAX_BODY_SIZE = 1_048_576; // 1MB

export function readBody(req: IncomingMessage, maxSize = DEFAULT_MAX_BODY_SIZE): Promise<string> {
  return new Promise((resolve, reject) => {
    let body = '';
    let size = 0;
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > maxSize) {
        reject(new Error('Request body too large'));
        req.destroy();
        return;
      }
      body += chunk;
    });
    req.on('end', () => resolve(body));
    req.on('error', reject);
  });
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function httpJSON(url: string, method: string, body: unknown, token?: string | null): Promise<any> {
  return new Promise((resolve, reject) => {
    const urlObj = new URL(url);
    const payload = JSON.stringify(body);
    const req = request(urlObj, {
      method,
      timeout: 30000,
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(payload),
        ...(token && { 'Authorization': `Bearer ${token}` }),
      },
    }, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        try { resolve(JSON.parse(data)); } catch { resolve({ error: data }); }
      });
    });
    req.on('error', (err) => reject(new Error(`Connection failed: ${err.message}`)));
    req.on('timeout', () => { req.destroy(); reject(new Error('Request timed out')); });
    req.write(payload);
    req.end();
  });
}

export function sendJSON(res: ServerResponse, statusCode: number, data: unknown, extraHeaders: Record<string, string> = {}): void {
  const body = JSON.stringify(data);
  res.writeHead(statusCode, {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(body),
    ...extraHeaders,
  });
  res.end(body);
}

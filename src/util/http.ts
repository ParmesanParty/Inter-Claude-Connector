import type { IncomingMessage, ServerResponse } from 'node:http';

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

export function sendJSON(res: ServerResponse, statusCode: number, data: unknown, extraHeaders: Record<string, string> = {}): void {
  const body = JSON.stringify(data);
  res.writeHead(statusCode, {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(body),
    ...extraHeaders,
  });
  res.end(body);
}

import { request } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { loadConfig } from '../config.ts';
import { serialize, deserialize } from '../protocol.ts';
import { createLogger } from '../util/logger.ts';
import type { Message, Transport } from '../types.ts';
import type { TlsConnectionOptions } from '../config.ts';

const log = createLogger('http');

interface HTTPTransportOptions {
  baseUrl?: string | null;
  authToken?: string | null;
  timeout?: number;
  tlsOptions?: TlsConnectionOptions | null;
}

export class HTTPTransport implements Transport {
  baseUrl: string | null;
  authToken: string | null;
  timeout: number;
  tlsOptions: HTTPTransportOptions['tlsOptions'];

  constructor(options: HTTPTransportOptions = {}) {
    const config = loadConfig();
    this.baseUrl = options.baseUrl ?? null;
    this.authToken = options.authToken ?? null;
    this.timeout = options.timeout ?? config.transport.httpTimeout;
    this.tlsOptions = options.tlsOptions ?? null;
  }

  _request(method: string, path: string, body: unknown = null): Promise<unknown> {
    if (!this.baseUrl) return Promise.reject(new Error('HTTP URL not configured'));

    const url = new URL(path, this.baseUrl);

    return new Promise((resolve, reject) => {
      const payload = body ? JSON.stringify(body) : null;

      const isHttps = url.protocol === 'https:';
      const requestFn = isHttps ? httpsRequest : request;

      const req = requestFn(url, {
        method,
        timeout: this.timeout,
        ...(isHttps && this.tlsOptions ? this.tlsOptions : {}),
        headers: {
          ...(payload && {
            'Content-Type': 'application/json',
            'Content-Length': Buffer.byteLength(payload),
          }),
          ...(this.authToken && {
            'Authorization': `Bearer ${this.authToken}`,
          }),
        },
      } as Parameters<typeof requestFn>[1], (res) => {
        let data = '';
        res.on('data', (chunk: string) => { data += chunk; });
        res.on('end', () => {
          if (res.statusCode! >= 400) {
            reject(new Error(`HTTP ${res.statusCode}: ${data}`));
            return;
          }
          try {
            resolve(JSON.parse(data));
          } catch {
            resolve(data);
          }
        });
      });

      req.on('timeout', () => {
        req.destroy();
        reject(new Error(`HTTP request timed out after ${this.timeout}ms`));
      });

      req.on('error', (err: Error) => {
        reject(new Error(`HTTP transport error: ${err.message}`));
      });

      if (payload) req.write(payload);
      req.end();
    });
  }

  async send(message: Message): Promise<Message> {
    log.info(`Sending via HTTP to ${this.baseUrl}`);
    const body = JSON.parse(serialize(message));
    const responseData = await this._request('POST', '/api/message', body);
    const response = typeof responseData === 'string'
      ? deserialize(responseData)
      : responseData as Message;
    if ((response as Message).version) {
      // It's a protocol message — validate
      return deserialize(serialize(response as Message));
    }
    return response as Message;
  }

  async isAvailable(): Promise<boolean> {
    if (!this.baseUrl) return false;
    try {
      const result = await this._request('GET', '/api/health') as Record<string, unknown>;
      const available = result && result.status === 'ok';
      log.debug(`HTTP availability: ${available}`);
      return !!available;
    } catch (err) {
      log.debug(`HTTP not available: ${(err as Error).message}`);
      return false;
    }
  }
}

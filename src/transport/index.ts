import { HTTPTransport } from './http.ts';
import { loadConfig, getTlsOptions, createIdentityVerifier, type TlsConnectionOptions } from '../config.ts';
import { createLogger } from '../util/logger.ts';
import type { Message, RemoteConfig } from '../types.ts';

const log = createLogger('transport');

export class TransportManager {
  private _http: HTTPTransport;

  constructor(peerConfig: RemoteConfig = {}, peerIdentity: string | null = null) {
    const config = loadConfig();

    let tlsOptions: TlsConnectionOptions | null = null;
    if ((peerConfig.httpUrl || '').startsWith('https://')) {
      const opts = getTlsOptions(config);
      if (opts) {
        tlsOptions = { ...opts, rejectUnauthorized: true };
        if (peerIdentity) tlsOptions.checkServerIdentity = createIdentityVerifier(peerIdentity);
      }
    }

    this._http = new HTTPTransport({
      baseUrl: peerConfig.httpUrl,
      authToken: peerConfig.token || config.server.authToken,
      timeout: config.transport.httpTimeout,
      tlsOptions,
    });
  }

  async send(message: Message): Promise<Message> {
    log.info('Sending via HTTP transport');
    message.transport = 'http';
    return this._http.send(message);
  }

  async checkConnectivity(): Promise<Record<string, { available: boolean; latencyMs: number | null }>> {
    const start = Date.now();
    const available = await this._http.isAvailable();
    return {
      http: {
        available,
        latencyMs: available ? Date.now() - start : null,
      },
    };
  }
}

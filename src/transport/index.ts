import { SSHTransport } from './ssh.ts';
import { HTTPTransport } from './http.ts';
import { loadConfig, getTlsOptions, createIdentityVerifier, type TlsConnectionOptions } from '../config.ts';
import { sendWoL } from '../util/wol.ts';
import { createLogger } from '../util/logger.ts';
import type { Message, Transport, TransportName, ConnectivityResults, RemoteConfig } from '../types.ts';

const log = createLogger('transport');

export class TransportManager {
  order: TransportName[];
  wolMac: string | null;
  private _transports: Record<string, Transport>;
  private _lastWorking: string | null;

  constructor(peerConfig: RemoteConfig = {}, peerIdentity: string | null = null) {
    const config = loadConfig();
    this.order = config.transport.order;
    this.wolMac = peerConfig.wolMac ?? null;
    this._transports = {};
    this._lastWorking = null;

    for (const name of this.order) {
      if (name === 'http') {
        let tlsOptions: TlsConnectionOptions | null = null;
        if ((peerConfig.httpUrl || '').startsWith('https://')) {
          const opts = getTlsOptions(config);
          if (opts) {
            tlsOptions = { ...opts, rejectUnauthorized: true };
            if (peerIdentity) tlsOptions.checkServerIdentity = createIdentityVerifier(peerIdentity);
          }
        }
        this._transports[name] = new HTTPTransport({
          baseUrl: peerConfig.httpUrl,
          authToken: peerConfig.token || config.server.authToken,
          timeout: config.transport.httpTimeout,
          tlsOptions,
        });
      } else if (name === 'ssh') {
        this._transports[name] = new SSHTransport({
          host: peerConfig.sshHost,
          projectDir: peerConfig.projectDir,
          timeout: config.transport.sshTimeout,
        });
      }
    }
  }

  async send(message: Message): Promise<Message> {
    const errors: { transport: string; error: string }[] = [];

    // Try last working transport first for speed
    const tryOrder = this._lastWorking
      ? [this._lastWorking, ...this.order.filter(t => t !== this._lastWorking)]
      : [...this.order];

    for (const name of tryOrder) {
      const transport = this._transports[name];
      if (!transport) continue;

      try {
        log.info(`Trying ${name} transport`);
        const response = await transport.send(message);
        this._lastWorking = name;
        message.transport = name;
        return response;
      } catch (err) {
        log.warn(`${name} transport failed: ${(err as Error).message}`);
        errors.push({ transport: name, error: (err as Error).message });

        // If SSH failed and we have WoL config, try waking the remote
        if (name === 'ssh' && this.wolMac) {
          try {
            log.info('Sending WoL packet to wake remote');
            await sendWoL(this.wolMac);
          } catch (wolErr) {
            log.warn(`WoL failed: ${(wolErr as Error).message}`);
          }
        }
      }
    }

    throw new Error(
      `All transports failed:\n${errors.map(e => `  ${e.transport}: ${e.error}`).join('\n')}`
    );
  }

  async checkConnectivity(): Promise<ConnectivityResults> {
    const results: ConnectivityResults = {};
    const checks = Object.entries(this._transports).map(async ([name, transport]) => {
      const start = Date.now();
      const available = await transport.isAvailable();
      results[name] = {
        available,
        latencyMs: available ? Date.now() - start : null,
      };
    });
    await Promise.all(checks);
    return results;
  }

  async sendVia(transportName: string, message: Message): Promise<Message> {
    const transport = this._transports[transportName];
    if (!transport) throw new Error(`Unknown transport: ${transportName}`);
    message.transport = transportName;
    return transport.send(message);
  }
}

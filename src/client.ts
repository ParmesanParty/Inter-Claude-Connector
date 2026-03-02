import { PeerRouter } from './peers.ts';
import { createRequest, createPing, validate } from './protocol.ts';
import { createLogger } from './util/logger.ts';
import { record } from './log.ts';
import type { Message } from './types.ts';

const log = createLogger('client');

interface SendOptions {
  peer?: string;
  context?: Record<string, unknown>;
}

interface PingOptions {
  peer?: string;
}

interface PingResult {
  pong: boolean;
  from: string;
  latencyMs: number;
}

export class ICCClient {
  router: PeerRouter;

  constructor() {
    this.router = new PeerRouter();
  }

  _resolvePeer(peer?: string): string {
    if (peer) return peer;
    const defaultPeer = this.router.getDefaultPeer();
    if (defaultPeer) return defaultPeer;
    throw new Error(
      `Multiple peers configured (${this.router.listPeers().join(', ')}). ` +
      'Specify which peer with the "peer" option.'
    );
  }

  async send(prompt: string, options: SendOptions = {}): Promise<Message & { _request?: Message }> {
    const peerIdentity = this._resolvePeer(options.peer);
    const message = createRequest(prompt, options.context || {});
    log.info(`Sending request ${message.id} to peer "${peerIdentity}"`);
    record(message);

    const response = await this.router.send(peerIdentity, message);

    if (!validate(response)) {
      throw new Error('Received invalid response from remote');
    }

    record(response);

    if (response.type === 'error') {
      throw new Error(`Remote error: ${'error' in response.payload ? response.payload.error : 'Unknown error'}`);
    }

    (response as Message & { _request?: Message })._request = message;
    return response;
  }

  async ping(options: PingOptions = {}): Promise<PingResult> {
    const peerIdentity = this._resolvePeer(options.peer);
    const message = createPing();
    const start = Date.now();

    const response = await this.router.send(peerIdentity, message);

    return {
      pong: response.type === 'pong',
      from: response.from,
      latencyMs: Date.now() - start,
    };
  }

  async status(): Promise<Record<string, Record<string, { available: boolean; latencyMs: number | null }>>> {
    return this.router.checkAllConnectivity();
  }
}

import { PeerRouter } from './peers.ts';
import { createPing } from './protocol.ts';

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

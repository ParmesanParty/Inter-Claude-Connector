import { TransportManager } from './transport/index.ts';
import { loadConfig, getPeerIdentities } from './config.ts';
import { parseAddress } from './address.ts';
import { createLogger } from './util/logger.ts';
import type { Message } from './types.ts';

const log = createLogger('peers');

export class PeerRouter {
  private _peers: Map<string, TransportManager>;

  constructor() {
    const config = loadConfig();
    this._peers = new Map();

    for (const identity of getPeerIdentities(config)) {
      const peerConfig = config.remotes[identity];
      log.info(`Initializing transport for peer "${identity}"`);
      this._peers.set(identity, new TransportManager(peerConfig, identity));
    }
  }

  getTransport(peerIdentity: string): TransportManager {
    const tm = this._peers.get(peerIdentity);
    if (!tm) {
      throw new Error(`Unknown peer: "${peerIdentity}". Known peers: ${this.listPeers().join(', ') || '(none)'}`);
    }
    return tm;
  }

  resolveTarget(toAddress: string): string | null {
    if (!toAddress) return null;
    const { host } = parseAddress(toAddress);
    const config = loadConfig();
    if (host === config.identity) return null; // local
    return host;
  }

  async send(peerIdentity: string, message: Message): Promise<Message> {
    const tm = this.getTransport(peerIdentity);
    return tm.send(message);
  }

  async checkAllConnectivity(): Promise<Record<string, Record<string, { available: boolean; latencyMs: number | null }>>> {
    const results: Record<string, Record<string, { available: boolean; latencyMs: number | null }>> = {};
    const checks = [...this._peers.entries()].map(async ([identity, tm]) => {
      results[identity] = await tm.checkConnectivity();
    });
    await Promise.all(checks);
    return results;
  }

  getDefaultPeer(): string | null {
    const peers = this.listPeers();
    return peers.length === 1 ? peers[0]! : null;
  }

  listPeers(): string[] {
    return [...this._peers.keys()];
  }
}

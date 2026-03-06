import { TransportManager } from './transport/index.ts';
import { loadConfig, clearConfigCache, getPeerIdentities } from './config.ts';
import { parseAddress } from './address.ts';
import { createLogger } from './util/logger.ts';
import type { Message, RemoteConfig } from './types.ts';

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

  addPeer(identity: string, peerConfig: RemoteConfig): void {
    log.info(`Adding peer "${identity}" dynamically`);
    this._peers.set(identity, new TransportManager(peerConfig, identity));
  }

  getTransport(peerIdentity: string): TransportManager {
    let tm = this._peers.get(peerIdentity);
    if (!tm) {
      // Lazy refresh: re-read config in case a new peer was added at runtime
      clearConfigCache();
      const config = loadConfig({ reload: true });
      for (const identity of getPeerIdentities(config)) {
        if (!this._peers.has(identity)) {
          this.addPeer(identity, config.remotes[identity]!);
        }
      }
      tm = this._peers.get(peerIdentity);
    }
    if (!tm) {
      throw new Error(`Unknown peer: "${peerIdentity}". Known peers: ${this.listPeers().join(', ') || '(none)'}`);
    }

    // Config refresh: rebuild transport if URL or token changed (re-read from disk)
    clearConfigCache();
    const config = loadConfig();
    const peerConfig = config.remotes?.[peerIdentity];
    if (peerConfig && tm.baseUrl !== peerConfig.httpUrl) {
      log.info(`Peer "${peerIdentity}" URL changed (${tm.baseUrl} → ${peerConfig.httpUrl}), rebuilding transport`);
      this.addPeer(peerIdentity, peerConfig);
      tm = this._peers.get(peerIdentity)!;
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

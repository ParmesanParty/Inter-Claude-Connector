import { createSocket } from 'node:dgram';
import { createLogger } from './logger.ts';

const log = createLogger('wol');

interface WoLOptions {
  port?: number;
  broadcastAddr?: string;
}

export function sendWoL(macAddress: string, { port = 9, broadcastAddr = '255.255.255.255' }: WoLOptions = {}): Promise<void> {
  return new Promise((resolve, reject) => {
    if (!macAddress) {
      reject(new Error('No MAC address provided'));
      return;
    }

    // Parse MAC address (accepts AA:BB:CC:DD:EE:FF or AA-BB-CC-DD-EE-FF)
    const macBytes = Buffer.from(
      macAddress.replace(/[:-]/g, ''),
      'hex'
    );

    if (macBytes.length !== 6) {
      reject(new Error(`Invalid MAC address: ${macAddress}`));
      return;
    }

    // Magic packet: 6 bytes of 0xFF followed by MAC address repeated 16 times
    const magic = Buffer.alloc(6 + 6 * 16);
    magic.fill(0xff, 0, 6);
    for (let i = 0; i < 16; i++) {
      macBytes.copy(magic, 6 + i * 6);
    }

    const socket = createSocket('udp4');

    socket.once('error', (err) => {
      socket.close();
      reject(err);
    });

    socket.bind(() => {
      socket.setBroadcast(true);
      socket.send(magic, 0, magic.length, port, broadcastAddr, (err) => {
        socket.close();
        if (err) {
          log.error(`WoL send failed: ${err.message}`);
          reject(err);
        } else {
          log.info(`WoL packet sent to ${macAddress}`);
          resolve();
        }
      });
    });
  });
}

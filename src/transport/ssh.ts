import { execFile } from 'node:child_process';
import { loadConfig } from '../config.ts';
import { serialize, deserialize } from '../protocol.ts';
import { createLogger } from '../util/logger.ts';
import type { Message, Transport } from '../types.ts';

const log = createLogger('ssh');

interface SSHTransportOptions {
  host?: string | null;
  projectDir?: string;
  timeout?: number;
}

export class SSHTransport implements Transport {
  host: string | null;
  projectDir: string;
  timeout: number;

  constructor(options: SSHTransportOptions = {}) {
    const config = loadConfig();
    this.host = options.host ?? null;
    this.projectDir = options.projectDir ?? '~/code/inter-claude-connector';
    this.timeout = options.timeout ?? config.transport.sshTimeout;
  }

  async send(message: Message): Promise<Message> {
    if (!this.host) throw new Error('SSH host not configured');

    const encoded = Buffer.from(serialize(message)).toString('base64');
    const remoteCmd = `cd ${this.projectDir} && node bin/icc.ts handle --message ${encoded}`;

    log.info(`Sending via SSH to ${this.host}`);

    return new Promise((resolve, reject) => {
      const args = [
        '-o', 'ConnectTimeout=10',
        '-o', 'BatchMode=yes',
        '-o', 'ControlMaster=auto',
        '-o', 'ControlPath=~/.ssh/icc-%r@%h:%p',
        '-o', 'ControlPersist=300',
        this.host!,
        remoteCmd,
      ];

      execFile('ssh', args, { timeout: this.timeout }, (err, stdout, stderr) => {
        if (err) {
          log.error(`SSH transport failed: ${err.message}`);
          reject(new Error(`SSH transport failed: ${err.message}`));
          return;
        }
        if (stderr) {
          log.debug('SSH stderr', stderr.trim());
        }
        try {
          const response = deserialize(stdout.trim());
          log.info('SSH transport received response');
          resolve(response);
        } catch (parseErr) {
          log.error('Failed to parse SSH response', stdout.trim());
          reject(new Error(`Failed to parse SSH response: ${(parseErr as Error).message}`));
        }
      });
    });
  }

  async isAvailable(): Promise<boolean> {
    if (!this.host) return false;

    return new Promise((resolve) => {
      execFile('ssh', [
        '-o', 'ConnectTimeout=5',
        '-o', 'BatchMode=yes',
        this.host!,
        'echo ok',
      ], { timeout: 10_000 }, (err, stdout) => {
        const available = !err && stdout.trim() === 'ok';
        log.debug(`SSH availability: ${available}`);
        resolve(available);
      });
    });
  }
}

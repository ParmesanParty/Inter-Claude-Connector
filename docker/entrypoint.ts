#!/usr/bin/env node

/**
 * Docker entrypoint for ICC.
 *
 * - No config → starts setup wizard on :3179
 * - Has config → starts ICC server (+ optional web UI and enrollment server)
 * - Wizard completion transitions to normal mode in-process
 */

import { existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { createLogger } from '../src/util/logger.ts';

const log = createLogger('docker');

const iccDir = join(homedir(), '.icc');

async function isConfigured(): Promise<boolean> {
  const configPath = join(iccDir, 'config.json');
  if (!existsSync(configPath)) return false;
  try {
    const { loadConfig } = await import('../src/config.ts');
    const config = loadConfig();
    return config.identity !== 'unnamed' && config.identity !== '';
  } catch {
    return false;
  }
}

const LOCALHOST_HTTP_PORT = parseInt(process.env.ICC_LOCALHOST_HTTP_PORT || '3178', 10);

async function startServices(setupToken?: string): Promise<void> {
  // Clear config cache to pick up any wizard-written config
  const { clearConfigCache } = await import('../src/config.ts');
  clearConfigCache();

  const { createICCServer } = await import('../src/server.ts');

  const server = createICCServer({
    host: '0.0.0.0',
    enableMcp: true,
    localhostHttpPort: LOCALHOST_HTTP_PORT,
    setupToken,
  });

  const { port, host } = await server.start();
  log.info(`ICC server running on ${host}:${port}`);

  // Optional: Web UI
  if (process.env.ICC_WEB_ENABLED === 'true') {
    try {
      const { createWebServer } = await import('../src/web.ts');
      const webServer = createWebServer({ host: '0.0.0.0' });
      await webServer.start();
      log.info('Web UI started');
    } catch (err) {
      log.error(`Failed to start web UI: ${(err as Error).message}`);
    }
  }

  // Optional: Enrollment server (requires CA keys)
  if (process.env.ICC_ENROLL_ENABLED === 'true') {
    try {
      const { loadConfig: loadCfg } = await import('../src/config.ts');
      const cfg = loadCfg();
      const tlsDir = join(homedir(), '.icc', 'tls');
      const peerConfigs: Record<string, { httpUrl: string }> = {};
      for (const [id, remote] of Object.entries(cfg.remotes || {})) {
        if (remote.httpUrl) peerConfigs[id] = { httpUrl: remote.httpUrl };
      }
      const { createEnrollmentServer } = await import('../src/enroll.ts');
      const enrollServer = createEnrollmentServer({
        caDir: tlsDir,
        peerConfigs,
        host: '0.0.0.0',
      });
      const enrollAddr = await enrollServer.start();
      log.info(`Enrollment server running on ${enrollAddr.host}:${enrollAddr.port}`);
    } catch (err) {
      log.error(`Failed to start enrollment server: ${(err as Error).message}`);
    }
  }
}

async function main(): Promise<void> {
  // Ensure ~/.icc exists
  mkdirSync(iccDir, { recursive: true });

  if (await isConfigured()) {
    log.info('Config found — starting services');
    await startServices();
  } else {
    log.info('No config found — starting setup wizard');
    const { startSetupWizard } = await import('./wizard.ts');
    await startSetupWizard({
      host: '0.0.0.0',
      port: 3179,
      localhostHttpPort: LOCALHOST_HTTP_PORT,
      onComplete: async (setupToken: string) => {
        log.info('Wizard complete — transitioning to normal mode');
        await startServices(setupToken);
      },
    });
    log.info('Setup wizard available at http://0.0.0.0:3179');
  }
}

// Graceful shutdown
const shutdown = () => {
  log.info('Shutting down...');
  process.exit(0);
};
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

main().catch((err) => {
  log.error(`Fatal: ${(err as Error).message}`);
  process.exit(1);
});

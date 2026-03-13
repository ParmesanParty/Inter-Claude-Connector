#!/usr/bin/env node

/**
 * Docker entrypoint for ICC.
 *
 * - No config → starts setup wizard on :3179
 * - Has config → starts ICC server (+ optional web UI and enrollment server)
 * - Wizard completion transitions to normal mode in-process
 */

import { existsSync, mkdirSync, accessSync, writeFileSync, unlinkSync, constants } from 'node:fs';
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

// Module-level service references for graceful shutdown
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let iccServer: any = null;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let webServer: any = null;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let enrollServer: any = null;

function preflight(config: { server: { tls: { enabled: boolean; certPath: string | null; keyPath: string | null; caPath: string | null } } }): void {
  // Check data dir is writable
  const testFile = join(iccDir, '.preflight-test');
  try {
    writeFileSync(testFile, 'test');
    unlinkSync(testFile);
  } catch (err) {
    log.error(`Data directory ${iccDir} is not writable: ${(err as Error).message}`);
    process.exit(1);
  }

  // Check TLS certs exist if TLS is enabled
  if (config.server.tls.enabled) {
    for (const [label, path] of Object.entries({
      cert: config.server.tls.certPath,
      key: config.server.tls.keyPath,
      ca: config.server.tls.caPath,
    })) {
      if (!path) {
        log.error(`TLS is enabled but ${label} path is not configured`);
        process.exit(1);
      }
      try {
        accessSync(path, constants.R_OK);
      } catch {
        log.error(`TLS ${label} file not readable: ${path}`);
        process.exit(1);
      }
    }
  }
}

async function startServices(setupToken?: string): Promise<void> {
  // Clear config cache to pick up any wizard-written config
  const { clearConfigCache, loadConfig } = await import('../src/config.ts');
  clearConfigCache();

  const config = loadConfig();
  preflight(config);

  const { createICCServer } = await import('../src/server.ts');

  iccServer = createICCServer({
    host: '0.0.0.0',
    enableMcp: true,
    localhostHttpPort: LOCALHOST_HTTP_PORT,
    setupToken,
  });

  const { port, host } = await iccServer.start();
  log.info(`ICC server running on ${host}:${port}`);

  // Optional: Web UI
  if (process.env.ICC_WEB_ENABLED === 'true') {
    try {
      const { createWebServer } = await import('../src/web.ts');
      webServer = createWebServer({ host: '0.0.0.0' });
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
      enrollServer = createEnrollmentServer({
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

// Graceful shutdown — stop all services before exiting
let shuttingDown = false;
const shutdown = async () => {
  if (shuttingDown) return;
  shuttingDown = true;
  log.info('Shutting down...');
  const timeout = setTimeout(() => { log.warn('Shutdown timeout — forcing exit'); process.exit(1); }, 10_000);
  const stops = [iccServer, webServer, enrollServer]
    .filter(Boolean)
    .map(s => s!.stop().catch((err: Error) => log.warn(`Stop error: ${err.message}`)));
  await Promise.allSettled(stops);
  clearTimeout(timeout);
  process.exit(0);
};
process.on('SIGTERM', () => { shutdown(); });
process.on('SIGINT', () => { shutdown(); });

main().catch((err) => {
  log.error(`Fatal: ${(err as Error).message}`);
  process.exit(1);
});

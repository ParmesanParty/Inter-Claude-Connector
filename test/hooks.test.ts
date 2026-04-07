import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { runHook, createTmpHome } from './helpers.ts';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

// We can't use the in-process withServer + runHook together: runHook uses
// execFileSync, which blocks the parent event loop and starves any in-process
// HTTP server. So for the positive case we spawn a standalone HTTP server in a
// CHILD node process that just answers /api/health and /api/hook/startup, then
// point the hook subprocess at that port.
async function withStandaloneHealthServer(fn: (port: number) => Promise<void>): Promise<void> {
  const script = `
    const http = require('http');
    const s = http.createServer((req, res) => {
      if (req.url === '/api/health') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ status: 'ok' }));
        return;
      }
      if (req.url === '/api/hook/startup') {
        let body = '';
        req.on('data', c => body += c);
        req.on('end', () => {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ connected: true, unreadCount: 0 }));
        });
        return;
      }
      res.writeHead(404); res.end();
    });
    s.listen(0, '127.0.0.1', () => {
      process.stdout.write('PORT=' + s.address().port + '\\n');
    });
  `;
  const child = spawn('node', ['-e', script], { stdio: ['ignore', 'pipe', 'inherit'] });
  const port = await new Promise<number>((resolve, reject) => {
    let buf = '';
    const onData = (chunk: Buffer) => {
      buf += chunk.toString();
      const m = buf.match(/PORT=(\d+)/);
      if (m) {
        child.stdout!.off('data', onData);
        resolve(parseInt(m[1]!, 10));
      }
    };
    child.stdout!.on('data', onData);
    child.on('error', reject);
    setTimeout(() => reject(new Error('child server start timeout')), 5000);
  });
  try {
    await fn(port);
  } finally {
    child.kill('SIGTERM');
  }
}

// NOTE: This test asserts the EXACT wording of the unreachable hint and the
// connected hint. These strings are user-facing and also referenced verbatim by
// Task 4's Docker hook template test. Any wording change must update:
//   1. bin/icc.ts `case 'startup':` (both the pre-check fallback and the
//      server-not-reachable branch of the hookRequest path)
//   2. src/server.ts Docker SessionStart startup/resume/clear command templates
//   3. This test AND the test in Task 4
// All in the same commit. Do not introduce wording drift across the two paths.
const UNREACHABLE_HINT = 'ICC: server not reachable. Run /mcp to reconnect, then /watch to activate.';

describe('hook startup MCP health pre-check', () => {
  it('emits unreachable hint and skips registration when server is down', async () => {
    const { tmpHome, cleanup } = createTmpHome();
    after(cleanup);
    // No server running on this port — hook should fail health check.
    const stdout = runHook('startup', { HOME: tmpHome, ICC_PORT: '39999' });
    assert.ok(
      stdout.includes(UNREACHABLE_HINT),
      `stdout must contain the exact unreachable hint; got: ${JSON.stringify(stdout)}`
    );
  });

  // (drift tests below use a sibling helper)
  it('proceeds with normal registration when server responds to /api/health', async () => {
    const { tmpHome, cleanup } = createTmpHome();
    after(cleanup);
    await withStandaloneHealthServer(async (port) => {
      const stdout = runHook('startup', {
        HOME: tmpHome,
        ICC_PORT: String(port),
      });
      assert.match(stdout, /^ICC: connected, \d+ unread\. Run \/watch to activate\.$/m);
      assert.ok(!stdout.includes(UNREACHABLE_HINT), 'must not emit unreachable hint on healthy server');
    });
  });
});

// Sibling helper for B9 drift tests: captures the POST body to a tmp file and
// returns a configurable response. Same subprocess pattern as
// withStandaloneHealthServer (in-process server starves under execFileSync).
async function withDriftServer(
  opts: { drifted: boolean; setupVersion: string; bodyOutPath: string },
  fn: (port: number) => Promise<void>,
): Promise<void> {
  const script = `
    const http = require('http');
    const fs = require('fs');
    const DRIFTED = ${JSON.stringify(opts.drifted)};
    const SETUP_VERSION = ${JSON.stringify(opts.setupVersion)};
    const BODY_OUT = ${JSON.stringify(opts.bodyOutPath)};
    const s = http.createServer((req, res) => {
      if (req.url === '/api/health') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ status: 'ok' }));
        return;
      }
      if (req.url === '/api/hook/startup') {
        let body = '';
        req.on('data', c => body += c);
        req.on('end', () => {
          try { fs.writeFileSync(BODY_OUT, body); } catch {}
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ connected: true, unreadCount: 0, drifted: DRIFTED, setupVersion: SETUP_VERSION }));
        });
        return;
      }
      res.writeHead(404); res.end();
    });
    s.listen(0, '127.0.0.1', () => {
      process.stdout.write('PORT=' + s.address().port + '\\n');
    });
  `;
  const child = spawn('node', ['-e', script], { stdio: ['ignore', 'pipe', 'inherit'] });
  const port = await new Promise<number>((resolve, reject) => {
    let buf = '';
    const onData = (chunk: Buffer) => {
      buf += chunk.toString();
      const m = buf.match(/PORT=(\d+)/);
      if (m) {
        child.stdout!.off('data', onData);
        resolve(parseInt(m[1]!, 10));
      }
    };
    child.stdout!.on('data', onData);
    child.on('error', reject);
    setTimeout(() => reject(new Error('child server start timeout')), 5000);
  });
  try {
    await fn(port);
  } finally {
    child.kill('SIGTERM');
  }
}

function writeManifestFile(tmpHome: string, version: string | null): string {
  const dir = join(tmpHome, '.icc');
  mkdirSync(dir, { recursive: true });
  // identity defaults to 'test-host' in runHook
  const path = join(dir, 'applied-config-manifest.test-host.json');
  writeFileSync(
    path,
    JSON.stringify({ version, appliedAt: new Date().toISOString(), files: {} }, null, 2),
  );
  return path;
}

describe('hook startup manifest drift detection', () => {
  it('sends appliedVersion read from manifest in POST body', async () => {
    const { tmpHome, cleanup } = createTmpHome();
    after(cleanup);
    writeManifestFile(tmpHome, 'abc123');
    const bodyOut = join(tmpHome, 'body.json');
    await withDriftServer({ drifted: false, setupVersion: 'abc123', bodyOutPath: bodyOut }, async (port) => {
      runHook('startup', { HOME: tmpHome, ICC_PORT: String(port) });
      // Give the child a moment to flush body file
      const { readFileSync, existsSync } = await import('node:fs');
      assert.ok(existsSync(bodyOut), 'server should have recorded the POST body');
      const body = JSON.parse(readFileSync(bodyOut, 'utf8'));
      assert.equal(body.appliedVersion, 'abc123');
      assert.ok(typeof body.instance === 'string' && body.instance.length > 0);
    });
  });

  it('emits drift hint when drifted=true in response', async () => {
    const { tmpHome, cleanup } = createTmpHome();
    after(cleanup);
    writeManifestFile(tmpHome, 'oldver');
    const bodyOut = join(tmpHome, 'body.json');
    await withDriftServer({ drifted: true, setupVersion: 'newver123', bodyOutPath: bodyOut }, async (port) => {
      const stdout = runHook('startup', { HOME: tmpHome, ICC_PORT: String(port) });
      assert.ok(
        stdout.includes('[ICC] Config drifted. Run /sync to update.'),
        `expected drift hint, got: ${JSON.stringify(stdout)}`,
      );
      assert.ok(!stdout.includes('not yet synced'), 'must not emit not-yet-synced when manifest exists');
    });
  });

  it('emits "not yet synced" hint when manifest is absent', async () => {
    const { tmpHome, cleanup } = createTmpHome();
    after(cleanup);
    // No manifest written
    const bodyOut = join(tmpHome, 'body.json');
    await withDriftServer({ drifted: false, setupVersion: 'anyver', bodyOutPath: bodyOut }, async (port) => {
      const stdout = runHook('startup', { HOME: tmpHome, ICC_PORT: String(port) });
      assert.ok(
        stdout.includes('[ICC] Config not yet synced — run /sync to apply.'),
        `expected not-yet-synced hint, got: ${JSON.stringify(stdout)}`,
      );
      assert.ok(!stdout.includes('Config drifted'), 'must not emit drift hint when manifest absent');
    });
  });

  it('emits no drift or not-yet-synced hint when drifted=false and manifest present', async () => {
    const { tmpHome, cleanup } = createTmpHome();
    after(cleanup);
    writeManifestFile(tmpHome, 'current');
    const bodyOut = join(tmpHome, 'body.json');
    await withDriftServer({ drifted: false, setupVersion: 'current', bodyOutPath: bodyOut }, async (port) => {
      const stdout = runHook('startup', { HOME: tmpHome, ICC_PORT: String(port) });
      assert.ok(!stdout.includes('Config drifted'), `unexpected drift hint: ${JSON.stringify(stdout)}`);
      assert.ok(!stdout.includes('not yet synced'), `unexpected not-yet-synced hint: ${JSON.stringify(stdout)}`);
      assert.match(stdout, /^ICC: connected, \d+ unread\. Run \/watch to activate\.$/m);
    });
  });
});

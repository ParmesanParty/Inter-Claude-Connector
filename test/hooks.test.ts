import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { runHook, createTmpHome } from './helpers.ts';

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

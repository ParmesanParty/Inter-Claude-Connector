# Test Infrastructure Refactor — Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Eliminate duplicated test boilerplate by extracting shared helpers, standardize config isolation to prevent live config leakage, and clean up environment variable management across all 19 test files.

**Architecture:** Create `test/helpers.ts` with 7 shared utilities (`createTestEnv`, `isolateConfig`, `withServer`, `httpJSON`, `httpRaw`, `withEnv`, `runHook`). Then systematically rewrite each test file to use these helpers, working from low-risk pure-unit tests up to complex server-integration tests. Every file must pass individually and collectively after refactoring.

**Tech Stack:** Node.js test runner (`node:test`), `node:http` for test requests, `node:crypto` for nothing new — just restructuring existing code.

---

## Task 1: Create `test/helpers.ts`

**Files:**
- Create: `test/helpers.ts`

**Step 1: Write the helpers module**

```typescript
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { request, type IncomingMessage, type IncomingHttpHeaders } from 'node:http';
import { execFileSync } from 'node:child_process';
import { clearConfigCache, loadConfig } from '../src/config.ts';
import { createICCServer } from '../src/server.ts';
import { reset as resetLog } from '../src/log.ts';
import { reset as resetInbox, init as initInbox } from '../src/inbox.ts';
import type { TlsConfig, ICCConfig } from '../src/types.ts';

// ── Test Environment ────────────────────────────────────────────────

export interface TestEnv {
  dir: string;
  cleanup(): void;
}

/**
 * Create an isolated temp directory and redirect log + inbox storage there.
 * Call once at module level in any test file that uses the server, inbox, or log.
 */
export function createTestEnv(prefix = 'icc-test'): TestEnv {
  const dir = mkdtempSync(join(tmpdir(), `${prefix}-`));
  resetLog(dir);
  resetInbox(dir);
  initInbox();
  return {
    dir,
    cleanup() { try { rmSync(dir, { recursive: true, force: true }); } catch {} },
  };
}

// ── Config Isolation ────────────────────────────────────────────────

export interface ConfigOverrides {
  identity?: string;
  localToken?: string | null;
  peerTokens?: Record<string, string>;
  remotes?: ICCConfig['remotes'];
  corsOrigins?: string[];
  tls?: { ca?: string | null };
}

/**
 * Load a fully isolated config. Always zeros remotes, TLS, and tokens
 * so live ~/.icc/config.json cannot leak into tests.
 * Call in beforeEach or at the start of each test.
 */
export function isolateConfig(overrides: ConfigOverrides = {}): ICCConfig {
  process.env.ICC_IDENTITY = overrides.identity ?? 'test-host';
  clearConfigCache();
  const config = loadConfig();
  config.remotes = overrides.remotes ?? {};
  config.server.tls = { enabled: false } as TlsConfig;
  config.server.localToken = overrides.localToken ?? null;
  config.server.peerTokens = overrides.peerTokens ?? {};
  if (overrides.corsOrigins) config.server.corsOrigins = overrides.corsOrigins;
  if (overrides.tls) {
    if (overrides.tls.ca !== undefined) config.tls = { ca: overrides.tls.ca };
  }
  return config;
}

// ── Server Lifecycle ────────────────────────────────────────────────

interface ServerOptions extends ConfigOverrides {
  noAuth?: boolean;
}

/**
 * Create an ICC server with isolated config, run `fn`, then always stop.
 * Guaranteed cleanup even if assertions throw.
 */
export async function withServer(
  opts: ServerOptions,
  fn: (port: number, config: ICCConfig) => Promise<void>,
): Promise<void> {
  const config = isolateConfig(opts);
  const s = createICCServer({ host: '127.0.0.1', port: 0, noAuth: opts.noAuth ?? true });
  const info = await s.start();
  try {
    await fn(info.port, config);
  } finally {
    await s.stop();
  }
}

// ── HTTP Helpers ────────────────────────────────────────────────────

/**
 * Make an HTTP request and parse the JSON response.
 * This is the canonical helper — replaces 7 per-file definitions.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function httpJSON(
  port: number,
  method: string,
  path: string,
  body: unknown = null,
  token: string | null = null,
): Promise<{ status: number | undefined; data: any }> {
  return new Promise((resolve, reject) => {
    const payload = body ? JSON.stringify(body) : null;
    const req = request(`http://127.0.0.1:${port}${path}`, {
      method,
      headers: {
        ...(payload && { 'Content-Type': 'application/json' }),
        ...(token && { 'Authorization': `Bearer ${token}` }),
      },
    }, (res: IncomingMessage) => {
      let data = '';
      res.on('data', (chunk: Buffer) => { data += chunk; });
      res.on('end', () => {
        try { resolve({ status: res.statusCode, data: data ? JSON.parse(data) : null }); }
        catch { resolve({ status: res.statusCode, data }); }
      });
    });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

/**
 * Make an HTTP request and return the raw response body + headers.
 * For CORS tests, web-auth tests, challenge endpoint, and any test
 * that needs headers or non-JSON bodies.
 */
export function httpRaw(
  port: number,
  method: string,
  path: string,
  opts: { body?: string; headers?: Record<string, string>; token?: string | null } = {},
): Promise<{ status: number | undefined; body: string; headers: IncomingHttpHeaders }> {
  return new Promise((resolve, reject) => {
    const reqHeaders: Record<string, string> = { ...opts.headers };
    if (opts.token) reqHeaders['Authorization'] = `Bearer ${opts.token}`;
    const req = request({
      hostname: '127.0.0.1',
      port,
      method,
      path,
      headers: reqHeaders,
    }, (res: IncomingMessage) => {
      let data = '';
      res.on('data', (chunk: Buffer) => { data += chunk; });
      res.on('end', () => resolve({ status: res.statusCode, body: data, headers: res.headers }));
    });
    req.on('error', reject);
    if (opts.body) {
      if (!reqHeaders['Content-Type']) {
        req.setHeader('Content-Type', 'application/x-www-form-urlencoded');
      }
      req.setHeader('Content-Length', Buffer.byteLength(opts.body));
      req.write(opts.body);
    }
    req.end();
  });
}

// ── Environment Variable Scoping ────────────────────────────────────

/**
 * Temporarily set environment variables, run fn, then restore originals.
 * Prevents env var leakage between tests.
 */
export async function withEnv<T>(
  vars: Record<string, string>,
  fn: () => T | Promise<T>,
): Promise<T> {
  const saved: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(vars)) {
    saved[k] = process.env[k];
    process.env[k] = v;
  }
  try {
    return await fn();
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

// ── Hook Test Helpers ───────────────────────────────────────────────

const iccBin = join(import.meta.dirname, '..', 'bin', 'icc.ts');

/**
 * Run `icc hook <subcmd>` as a subprocess with isolated env.
 * Shared between hook-heartbeat.test.ts and hook-session.test.ts.
 */
export function runHook(subcmd: string, env: Record<string, string> = {}, extraArgs: string[] = []): string {
  return execFileSync('node', [iccBin, 'hook', subcmd, ...extraArgs], {
    env: {
      ...process.env,
      HOME: env.HOME || process.env.HOME,
      ICC_IDENTITY: 'test-host',
      ICC_REMOTE_SSH: '',
      ICC_REMOTE_HTTP: '',
      ...env,
    },
    timeout: 10000,
    encoding: 'utf-8',
    stdio: ['pipe', 'pipe', 'pipe'],
  });
}

/**
 * Create a temporary HOME directory with ~/.icc/ for hook tests.
 * Returns tmpHome path and a cleanup function.
 */
export function createTmpHome(prefix = 'icc-hook-test'): { tmpHome: string; cleanup(): void } {
  const tmpHome = mkdtempSync(join(tmpdir(), `${prefix}-`));
  mkdirSync(join(tmpHome, '.icc'), { recursive: true });
  return {
    tmpHome,
    cleanup() { try { rmSync(tmpHome, { recursive: true, force: true }); } catch {} },
  };
}
```

**Step 2: Verify the module loads**

Run: `node -e "import('./test/helpers.ts')"`
Expected: No errors (the imports resolve)

**Step 3: Commit**

```bash
git add test/helpers.ts
git commit -m "test: add shared test helpers module"
```

---

## Task 2: Refactor `config.test.ts`, `protocol.test.ts`, `transport.test.ts`

Minimal-risk files that just need `withEnv()` for env var safety.

**Files:**
- Modify: `test/config.test.ts`
- Modify: `test/protocol.test.ts`
- Modify: `test/transport.test.ts`

**Step 1: Refactor `config.test.ts`**

Add import: `import { withEnv } from './helpers.ts';`

Wrap each env-var test in `withEnv()`. For example, the identity override test becomes:

```typescript
it('ICC_IDENTITY overrides config identity', async () => {
  await withEnv({ ICC_IDENTITY: 'override-host' }, () => {
    clearConfigCache();
    const config = loadConfig();
    assert.equal(config.identity, 'override-host');
  });
});
```

Apply this pattern to all 6 tests that set/delete env vars. Remove inline `delete process.env.*` cleanup lines — `withEnv` handles restoration.

**Step 2: Refactor `protocol.test.ts`**

Replace module-level `process.env.ICC_IDENTITY = 'test-host'` with:

```typescript
import { withEnv } from './helpers.ts';
```

In `beforeEach`:
```typescript
beforeEach(() => {
  process.env.ICC_IDENTITY = 'test-host';
  clearConfigCache();
});
```

(Keep it simple — protocol tests just need identity set, not full isolation.)

**Step 3: Refactor `transport.test.ts`**

Same as protocol — replace module-level env set with `beforeEach` that sets `ICC_IDENTITY`. Add `import { createTestEnv } from './helpers.ts';` and replace the 4-line init block if present.

**Step 4: Run tests**

Run: `node --test test/config.test.ts test/protocol.test.ts test/transport.test.ts`
Expected: All tests pass with same counts (6 + 9 + 4 = 19)

**Step 5: Commit**

```bash
git add test/config.test.ts test/protocol.test.ts test/transport.test.ts
git commit -m "test: use withEnv for env var isolation in config/protocol/transport tests"
```

---

## Task 3: Refactor `peers.test.ts` and `mcp.test.ts`

Replace inline `loadIsolatedConfig()` helpers and module-level env sets.

**Files:**
- Modify: `test/peers.test.ts`
- Modify: `test/mcp.test.ts`

**Step 1: Refactor `peers.test.ts`**

Replace the module-level 4-line init block with `createTestEnv()`.
Delete `loadIsolatedConfig()` inline helper — replace calls with `isolateConfig()`.

Before:
```typescript
const testDir = mkdtempSync(join(tmpdir(), 'icc-peers-test-'));
resetLog(testDir);
resetInbox(testDir);
initInbox();
```

After:
```typescript
import { createTestEnv, isolateConfig } from './helpers.ts';
createTestEnv('icc-peers-test');
```

Replace each `loadIsolatedConfig()` call with `isolateConfig()`.

Remove imports that are now unused: `mkdtempSync`, `join`, `tmpdir`, `resetLog`, `resetInbox`, `initInbox`, `clearConfigCache`, `loadConfig`.

**Step 2: Refactor `mcp.test.ts`**

Replace module-level env sets with `createTestEnv()`. In `beforeEach`, replace `clearConfigCache()` + `loadConfig()` + `config.remotes = {}` with `isolateConfig()`.

Remove unused imports as they're replaced by helpers.

**Step 3: Run tests**

Run: `node --test test/peers.test.ts test/mcp.test.ts`
Expected: All tests pass (12 + 45 = 57)

**Step 4: Commit**

```bash
git add test/peers.test.ts test/mcp.test.ts
git commit -m "test: use isolateConfig/createTestEnv in peers and mcp tests"
```

---

## Task 4: Refactor `integration.test.ts`

Major file — delete both `startServer()` copies, delete `httpRequest`, delete `httpRequestRaw`.

**Files:**
- Modify: `test/integration.test.ts`

**Step 1: Replace boilerplate**

Replace module-level section (lines 1-25) with:

```typescript
import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createPing, serialize } from '../src/protocol.ts';
import { loadConfig } from '../src/config.ts';
import { createTestEnv, isolateConfig, withServer, httpJSON, httpRaw } from './helpers.ts';

createTestEnv('icc-integration-test');
```

Delete: `httpRequest` (lines 38-61), `httpRequestRaw` (lines 63-84), both `startServer()` helpers (lines 88-98 and the duplicate around line 209).

Delete: module-level `process.env.ICC_IDENTITY`, `ICC_AUTH_TOKEN`, `ICC_PORT` sets.

Delete: file-level `beforeEach(() => { clearConfigCache(); })` (isolateConfig handles this).

**Step 2: Rewrite each test to use `withServer`**

Example — `GET /api/health` test becomes:

```typescript
it('GET /api/health returns ok', async () => {
  await withServer({}, async (port) => {
    const res = await httpJSON(port, 'GET', '/api/health');
    assert.equal(res.status, 200);
    assert.equal(res.data.status, 'ok');
  });
});
```

For the challenge endpoint test that needs raw response, use `httpRaw`:

```typescript
it('GET /.well-known/icc-challenge returns challenge', async () => {
  await withServer({}, async (port, config) => {
    // Write challenge file...
    const res = await httpRaw(port, 'GET', '/.well-known/icc-challenge');
    assert.equal(res.status, 200);
    assert.equal(res.body.trim(), 'test-challenge-token');
  });
});
```

For tests that need auth tokens, pass them in opts:

```typescript
it('POST /api/message with valid token', async () => {
  await withServer({ localToken: 'test-tok' }, async (port) => {
    const res = await httpJSON(port, 'POST', '/api/message', payload, 'test-tok');
    assert.equal(res.status, 200);
  });
});
```

Apply this pattern to all ~14 tests in the file. Every `try/finally` block
gets replaced by `withServer`.

**Step 3: Run tests**

Run: `node --test test/integration.test.ts`
Expected: 14 tests pass

**Step 4: Commit**

```bash
git add test/integration.test.ts
git commit -m "test: refactor integration tests to use shared helpers"
```

---

## Task 5: Refactor `auth.test.ts`

Delete all 4 `withServer` copies, delete `httpRequest`.

**Files:**
- Modify: `test/auth.test.ts`

**Step 1: Replace boilerplate**

Replace module-level init with:

```typescript
import { createTestEnv, isolateConfig, withServer, httpJSON } from './helpers.ts';
import { clearConfigCache, loadConfig, getOutboundToken, getLocalToken } from '../src/config.ts';
import type { ICCConfig } from '../src/types.ts';

createTestEnv('icc-auth-test');
```

Delete: `httpRequest` definition (lines 24-47).
Delete: all 4 `withServer` definitions (the local ones in each describe group).
Delete: module-level `TlsConfig` import (no longer needed directly).

**Step 2: Rewrite server tests to use shared `withServer`**

Each test that used the local `withServer(tokenConfig, fn)` now uses:

```typescript
it('accepts request with valid localToken', async () => {
  await withServer({ localToken: 'local-tok' }, async (port) => {
    const res = await httpJSON(port, 'GET', '/api/health', null, 'local-tok');
    assert.equal(res.status, 200);
  });
});
```

The pure config helper tests (`getOutboundToken`, `getLocalToken`, etc.) that
don't need a server just use `isolateConfig()` directly:

```typescript
it('getOutboundToken returns remote token', () => {
  const config = isolateConfig({
    remotes: { 'peer-a': { httpUrl: 'https://a:3179', token: 'secret-a' } } as ICCConfig['remotes'],
  });
  assert.equal(getOutboundToken(config, 'peer-a'), 'secret-a');
});
```

The "auth-required startup" tests (at the end of the file) that test server
rejection when no auth is configured should NOT use `withServer` — they test
the server failing to start. Use `isolateConfig` + `createICCServer` + `assert.rejects` directly.

**Step 3: Run tests**

Run: `node --test test/auth.test.ts`
Expected: 27 tests pass (including the 2 auth-required startup tests)

**Step 4: Commit**

```bash
git add test/auth.test.ts
git commit -m "test: consolidate auth tests to use shared withServer/isolateConfig"
```

---

## Task 6: Refactor `inbox.test.ts`

The most repetitive file. ~12 duplicate beforeEach blocks collapse.

**Files:**
- Modify: `test/inbox.test.ts`

**Step 1: Replace boilerplate**

Replace module-level section with:

```typescript
import { createTestEnv, isolateConfig, withServer, httpJSON } from './helpers.ts';
import {
  init, push, getUnread, getAll, getById, markRead, markAllRead,
  remove, purgeStale, subscribe, reset, getSignalPath, setNotifier,
  setReceiptSender, isReceipt, getInboxDir,
} from '../src/inbox.ts';
import { createToolHandlers } from '../src/mcp.ts';
import type { InboxMessage } from '../src/types.ts';
```

Delete: `freshInboxDir()` helper, `httpRequest` definition, all `process.env` sets.

**Step 2: Create file-level test env and beforeEach**

At file level:

```typescript
let env: ReturnType<typeof createTestEnv>;

beforeEach(() => {
  env = createTestEnv('icc-inbox-test');
  isolateConfig();
});
```

This single beforeEach replaces all ~12 duplicate copies. The `createTestEnv`
call gives each test a fresh inbox directory (replacing `freshInboxDir()`).

**Step 3: Replace per-describe beforeEach blocks**

Delete every `beforeEach(() => { freshInboxDir(); clearConfigCache(); ... })` block.
They're all handled by the file-level beforeEach.

For describe groups that need specific token configs (server integration tests),
the tests themselves call `withServer` with overrides:

```typescript
it('POST /api/inbox pushes message', async () => {
  await withServer({ localToken: 'tok' }, async (port) => {
    const res = await httpJSON(port, 'POST', '/api/inbox', {
      from: 'saturn', to: 'test-host', body: 'hello',
    }, 'tok');
    assert.equal(res.status, 200);
  });
});
```

**Step 4: Delete mid-file `httpRequest`**

The file defines its own `httpRequest` around the middle. Delete it — all HTTP
tests now use `httpJSON` from helpers.

**Step 5: Run tests**

Run: `node --test test/inbox.test.ts`
Expected: ~60 tests pass

**Step 6: Commit**

```bash
git add test/inbox.test.ts
git commit -m "test: collapse inbox test duplication with shared helpers"
```

---

## Task 7: Refactor `registry.test.ts`

**Files:**
- Modify: `test/registry.test.ts`

**Step 1: Replace boilerplate**

Delete: `freshState()`, `httpRequest`, `HttpResponse` interface, module-level env sets.

```typescript
import { createTestEnv, isolateConfig, withServer, httpJSON } from './helpers.ts';
import { register, list, prune, reset, deregister } from '../src/registry.ts';
import { reset as resetInstances, resolve as resolveInstance } from '../src/instances.ts';
import { createToolHandlers } from '../src/mcp.ts';
import type { ICCClient } from '../src/client.ts';

createTestEnv('icc-registry-test');
```

Replace `beforeEach(freshState)` with:

```typescript
beforeEach(() => {
  reset();  // reset registry
  isolateConfig();
});
```

Note: `reset()` is from `../src/registry.ts`, not helpers. Keep that import.
The `resetInstances` call may also be needed in some describe groups — check
the existing tests.

**Step 2: Rewrite server tests to use `withServer` + `httpJSON`**

Replace all try/finally blocks. Server tests that need specific tokens:

```typescript
it('returns registered instances', async () => {
  await withServer({ localToken: 'tok' }, async (port) => {
    register('test/session', 12345);
    const res = await httpJSON(port, 'GET', '/api/registry', null, 'tok');
    assert.equal(res.status, 200);
  });
});
```

**Step 3: Run tests**

Run: `node --test test/registry.test.ts`
Expected: ~18 tests pass

**Step 4: Commit**

```bash
git add test/registry.test.ts
git commit -m "test: refactor registry tests to use shared helpers"
```

---

## Task 8: Refactor `security.test.ts`

**Files:**
- Modify: `test/security.test.ts`

**Step 1: Replace boilerplate**

Delete: `httpRequest`, module-level env sets.

```typescript
import { createTestEnv, isolateConfig, withServer, httpJSON, withEnv } from './helpers.ts';
import { isPathAllowed, isCommandAllowed, isSubcommandAllowed, safeReadFile, safeExec } from '../src/util/exec.ts';
import { loadConfig } from '../src/config.ts';

createTestEnv('icc-security-test');
```

**Step 2: Wrap env-dependent tests in `withEnv`**

Tests that enable `ICC_EXEC_ENABLED` or `ICC_READFILE_ENABLED`:

```typescript
it('safeExec runs allowed command when enabled', async () => {
  await withEnv({ ICC_EXEC_ENABLED: 'true' }, async () => {
    const config = isolateConfig();
    const result = await safeExec(config, 'ls', ['/tmp']);
    assert.ok(result.stdout !== undefined);
  });
});
```

This replaces the current pattern of inline `process.env.ICC_EXEC_ENABLED = 'true'` / `= 'false'` toggles.

**Step 3: Rewrite server tests to use `withServer` + `httpJSON`**

Same pattern as other files — replace try/finally with `withServer`.

**Step 4: Run tests**

Run: `node --test test/security.test.ts`
Expected: ~14 tests pass

**Step 5: Commit**

```bash
git add test/security.test.ts
git commit -m "test: refactor security tests with withEnv and shared helpers"
```

---

## Task 9: Refactor `cors.test.ts`, `mesh-update.test.ts`, `web-auth.test.ts`

Three small files that are straightforward to convert.

**Files:**
- Modify: `test/cors.test.ts`
- Modify: `test/mesh-update.test.ts`
- Modify: `test/web-auth.test.ts`

**Step 1: Refactor `cors.test.ts`**

Delete: custom `httpRequest` (returns headers). Use `httpRaw` from helpers.

```typescript
import { createTestEnv, withServer, httpRaw } from './helpers.ts';

createTestEnv('icc-cors-test');

describe('CORS', () => {
  it('should reflect allowed origin', async () => {
    await withServer({ corsOrigins: ['http://localhost:3180'] }, async (port) => {
      const res = await httpRaw(port, 'OPTIONS', '/api/health', {
        headers: { Origin: 'http://localhost:3180' },
      });
      assert.equal(res.headers['access-control-allow-origin'], 'http://localhost:3180');
    });
  });
  // ... same for other 2 tests
});
```

This collapses 3 test bodies from 15 lines each to ~5 lines each. The 7-line
config isolation block repeated 3 times disappears entirely.

**Step 2: Refactor `mesh-update.test.ts`**

Delete: `httpRequest`, `beforeEach` server lifecycle.

```typescript
import { createTestEnv, withServer, httpJSON } from './helpers.ts';

createTestEnv('icc-mesh-update-test');

describe('/api/mesh-update', () => {
  it('accepts add-peer from CA identity', async () => {
    await withServer({
      localToken: 'local-tok',
      peerTokens: { 'ca-host': 'ca-secret' },
      tls: { ca: 'ca-host' },
    }, async (port) => {
      const res = await httpJSON(port, 'POST', '/api/mesh-update', {
        action: 'add-peer',
        peer: { identity: 'new-peer', httpsUrl: 'https://192.168.1.100:3179', peerToken: 'inbound-from-new' },
        outboundToken: 'outbound-to-new',
      }, 'ca-secret');
      assert.equal(res.status, 200);
    });
  });
  // ... same for other 4 tests
});
```

**Step 3: Refactor `web-auth.test.ts`**

This file tests `createWebServer`, not `createICCServer`. It can't use
`withServer()` directly. Instead:

- Delete custom `httpRequest` — use `httpRaw` from helpers.
- Replace `beforeEach` server lifecycle with a local `withWebServer` helper
  that follows the same pattern:

```typescript
import { createTestEnv, isolateConfig, httpRaw } from './helpers.ts';
import { createWebServer } from '../src/web.ts';

createTestEnv('icc-web-auth-test');

async function withWebServer(
  fn: (port: number) => Promise<void>,
): Promise<void> {
  isolateConfig({ identity: 'web-test', localToken: 'test-web-token' });
  const ws = createWebServer({ host: '127.0.0.1', port: 0 });
  const info = await ws.start() as { port: number; host: string };
  try { await fn(info.port); }
  finally { await ws.stop(); }
}
```

Then each test becomes:

```typescript
it('GET / without session returns login page', async () => {
  await withWebServer(async (port) => {
    const res = await httpRaw(port, 'GET', '/');
    assert.equal(res.status, 200);
    assert.ok(res.body.includes('form'));
  });
});
```

**Step 4: Run tests**

Run: `node --test test/cors.test.ts test/mesh-update.test.ts test/web-auth.test.ts`
Expected: 3 + 5 + 4 = 12 tests pass

**Step 5: Commit**

```bash
git add test/cors.test.ts test/mesh-update.test.ts test/web-auth.test.ts
git commit -m "test: refactor cors, mesh-update, web-auth tests to use shared helpers"
```

---

## Task 10: Refactor `hook-heartbeat.test.ts` and `hook-session.test.ts`

**Files:**
- Modify: `test/hook-heartbeat.test.ts`
- Modify: `test/hook-session.test.ts`

**Step 1: Refactor both files**

In both files:
- Delete the local `runHook` definition
- Delete all ~5 copies of the `beforeEach/afterEach` tmpHome pair
- Import from helpers:

```typescript
import { runHook, createTmpHome } from './helpers.ts';
```

In each describe group, replace:
```typescript
let tmpHome: string;
beforeEach(() => {
  tmpHome = mkdtempSync(join(tmpdir(), 'icc-hb-test-'));
  mkdirSync(join(tmpHome, '.icc'), { recursive: true });
});
afterEach(() => {
  try { rmSync(tmpHome, { recursive: true, force: true }); } catch {}
});
```

With:
```typescript
let tmpHome: string;
let cleanup: () => void;
beforeEach(() => {
  ({ tmpHome, cleanup } = createTmpHome());
});
afterEach(() => cleanup());
```

Also remove unused imports: `mkdtempSync`, `mkdirSync`, `rmSync`, `tmpdir`,
`join`, `execFileSync` (only if no longer used).

Keep the `sanitize` and `spawn` imports — those are specific to these tests.

**Step 2: Run tests**

Run: `node --test test/hook-heartbeat.test.ts test/hook-session.test.ts`
Expected: 11 + 8 = 19 tests pass

**Step 3: Commit**

```bash
git add test/hook-heartbeat.test.ts test/hook-session.test.ts
git commit -m "test: share runHook and createTmpHome between hook test files"
```

---

## Task 11: Refactor `enroll.test.ts` and `tls.test.ts`

These files have unique patterns (CA init, servers[] tracking, TLS env cleanup).
Lighter touch — mainly replace `httpReq` and add `withEnv`.

**Files:**
- Modify: `test/enroll.test.ts`
- Modify: `test/tls.test.ts`

**Step 1: Refactor `enroll.test.ts`**

Delete `httpReq` — replace with `httpJSON` from helpers. The enrollment server
tests create their own `createEnrollmentServer` (not `createICCServer`), so
they should NOT use `withServer`. Keep the `servers[]` cleanup pattern.

```typescript
import { httpJSON } from './helpers.ts';
```

Replace all `httpReq(port, ...)` calls with `httpJSON(port, ...)`.

**Step 2: Refactor `tls.test.ts`**

Add `withEnv` for the TLS env var cleanup that's currently done in try/finally:

```typescript
import { createTestEnv, withEnv } from './helpers.ts';
```

Replace inline env var set/cleanup blocks with `withEnv`. Keep the CA/TLS
setup that's unique to this file.

**Step 3: Run tests**

Run: `node --test test/enroll.test.ts test/tls.test.ts`
Expected: 4 + 8 = 12 tests pass

**Step 4: Commit**

```bash
git add test/enroll.test.ts test/tls.test.ts
git commit -m "test: use shared httpJSON and withEnv in enroll and tls tests"
```

---

## Task 12: Final verification and cleanup

**Step 1: Run full test suite**

Run: `node --test test/*.test.ts`
Expected: 373 tests, 0 failures

**Step 2: Acid test — verify config isolation**

Temporarily rename `~/.icc/config.json` and run the full suite. If any test
fails, it was leaking live config.

```bash
mv ~/.icc/config.json ~/.icc/config.json.bak
node --test test/*.test.ts
mv ~/.icc/config.json.bak ~/.icc/config.json
```

Expected: 373 tests, 0 failures (no live config dependency)

**Step 3: Remove any remaining `ICC_AUTH_TOKEN` references**

Search: `grep -r 'ICC_AUTH_TOKEN' test/`

Any remaining references to the legacy `ICC_AUTH_TOKEN` env var should be
removed — it was deleted in the security hardening work. Replace with
appropriate `localToken` or `peerTokens` config in `isolateConfig()`.

**Step 4: Final commit if any cleanups needed**

```bash
git add -A test/
git commit -m "test: final cleanup — remove legacy ICC_AUTH_TOKEN, verify isolation"
```

---

## Task 13: Update MEMORY.md

**Files:**
- Modify: `/home/albertnam/.claude/projects/-home-albertnam-code-inter-claude-connector/memory/MEMORY.md`

Update the Testing section:

```markdown
## Testing
- `node --test test/*.test.ts` — 373 tests, all passing
- `test/helpers.ts` — shared utilities: `createTestEnv`, `isolateConfig`, `withServer`, `httpJSON`, `httpRaw`, `withEnv`, `runHook`, `createTmpHome`
- `isolateConfig()` always zeros remotes, TLS, and tokens — prevents live config leakage
- `withServer(opts, fn)` — guaranteed server cleanup, replaces all try/finally patterns
- `withEnv(vars, fn)` — scoped env var sets with automatic restore
- Integration tests use port 0 for random port assignment
- `test/auth.test.ts` — 27 tests for per-peer auth
```

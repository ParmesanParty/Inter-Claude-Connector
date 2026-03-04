# Test Infrastructure Refactor — Design

## Problem

19 test files (373 tests) with no shared utilities. Systematic duplication:

- **`httpRequest` defined 7 times** with 6 different signatures
- **4-line init block** (mkdtempSync + resetLog + resetInbox + initInbox) in 9 files
- **Config isolation block** (5-7 lines) repeated in ~14 describe groups
- **`withServer()` defined 4 times** within auth.test.ts alone
- **`runHook` duplicated** between hook-heartbeat.test.ts and hook-session.test.ts
- **Environment variable pollution** — module-level sets without cleanup guards
- **`inbox.test.ts`** repeats same 6-line beforeEach ~12 times

### Config Leakage Risk

Tests rely on manually zeroing `config.remotes` and `config.server.tls` after
`loadConfig()`. If any test forgets, live `~/.icc/config.json` peer configs and
TLS paths leak into the test, causing failures on machines with real configs
and silent wrong-host connections in CI.

## Approach

Centralized helpers module (`test/helpers.ts`) with systematic rewrite of all
test files. No new abstractions beyond simple functions — no classes, no
framework.

## Design

### 1. `test/helpers.ts` — Shared Utilities

#### `createTestEnv(prefix?): TestEnv`

Replaces the 4-line init block in 9 files.

```typescript
interface TestEnv {
  dir: string;
  cleanup(): void;
}

export function createTestEnv(prefix = 'icc-test'): TestEnv {
  const dir = mkdtempSync(join(tmpdir(), `${prefix}-`));
  resetLog(dir);
  resetInbox(dir);
  initInbox();
  return { dir, cleanup: () => { try { rmSync(dir, { recursive: true, force: true }); } catch {} } };
}
```

#### `isolateConfig(overrides?): ICCConfig`

Replaces the 5-7 line config block in ~14 describe groups. Always zeros
remotes, TLS, and tokens — no path for live config to leak.

```typescript
interface ConfigOverrides {
  identity?: string;
  localToken?: string | null;
  peerTokens?: Record<string, string>;
  remotes?: Record<string, unknown>;
  tls?: Partial<TlsConfig>;
  [key: string]: unknown;
}

export function isolateConfig(overrides: ConfigOverrides = {}): ICCConfig {
  process.env.ICC_IDENTITY = overrides.identity ?? 'test-host';
  clearConfigCache();
  const config = loadConfig();
  // Safety: always zero these regardless of overrides
  config.remotes = {};
  config.server.tls = { enabled: false } as TlsConfig;
  config.server.localToken = overrides.localToken ?? null;
  config.server.peerTokens = overrides.peerTokens ?? {};
  // Apply explicit overrides
  if (overrides.remotes) config.remotes = overrides.remotes as ICCConfig['remotes'];
  if (overrides.tls) Object.assign(config.server.tls, overrides.tls);
  return config;
}
```

#### `withServer(opts, fn)`

Replaces all try/finally server lifecycle blocks and the 4 withServer copies
in auth.test.ts. Guaranteed cleanup even on assertion failure.

```typescript
interface ServerOptions extends ConfigOverrides {
  noAuth?: boolean;
}

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
```

#### `httpJSON(port, method, path, body?, token?)`

The canonical HTTP request helper. Returns `{ status, data }` with parsed JSON.
Replaces 7 per-file definitions (variants A, B, C, F from the analysis).

```typescript
export function httpJSON(
  port: number,
  method: string,
  path: string,
  body: unknown = null,
  token: string | null = null,
): Promise<{ status: number | undefined; data: unknown }> { ... }
```

#### `httpRaw(port, method, path, opts?)`

Returns `{ status, body: string, headers }`. For CORS, web-auth, and challenge
tests that need raw response or custom headers.

```typescript
interface HttpRawOptions {
  body?: string;
  headers?: Record<string, string>;
  token?: string | null;
}

export function httpRaw(
  port: number,
  method: string,
  path: string,
  opts?: HttpRawOptions,
): Promise<{ status: number | undefined; body: string; headers: Record<string, string> }> { ... }
```

#### `withEnv(vars, fn)`

Scoped environment variable setter with automatic restore. Prevents env var
pollution between tests.

```typescript
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
```

#### `runHook(subcmd, env?, extraArgs?)`

Shared execFileSync wrapper for hook subprocess tests. Replaces 2 identical
copies in hook-heartbeat.test.ts and hook-session.test.ts.

```typescript
export function runHook(
  subcmd: string,
  env: Record<string, string> = {},
  extraArgs: string[] = [],
): string {
  const iccBin = join(__dirname, '..', 'bin', 'icc.ts');
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
```

#### `createTmpHome(): { tmpHome: string; cleanup(): void }`

For hook tests that need a fake HOME directory with `~/.icc/`. Replaces the
10 identical beforeEach/afterEach blocks across hook test files.

```typescript
export function createTmpHome() {
  const tmpHome = mkdtempSync(join(tmpdir(), 'icc-hook-test-'));
  mkdirSync(join(tmpHome, '.icc'), { recursive: true });
  return {
    tmpHome,
    cleanup: () => { try { rmSync(tmpHome, { recursive: true, force: true }); } catch {} },
  };
}
```

### 2. File-by-File Changes

#### Pure unit test files (no changes needed)
- `address.test.ts` — no server, no config, no duplication
- `instances.test.ts` — self-contained with its own `reset(dir)` calls

#### Config/protocol/transport tests (minimal changes)
- `config.test.ts` — wrap env var sets in `withEnv()`
- `protocol.test.ts` — replace module-level env set with `withEnv()` in beforeEach
- `transport.test.ts` — replace module-level env set with `withEnv()` in beforeEach

#### Server integration tests (major changes)

**`integration.test.ts`:**
- Delete both copies of `startServer()` (lines 88 and 209)
- Delete `httpRequest` and `httpRequestRaw` definitions
- Import `httpJSON`, `httpRaw`, `withServer`, `createTestEnv` from helpers
- Replace all try/finally blocks with `withServer()` calls
- Module-level env sets → `createTestEnv()` + helpers handle identity

**`auth.test.ts`:**
- Delete all 4 copies of `withServer` (lines 111, 177, 243, 292)
- Delete `httpRequest` definition
- Import `httpJSON`, `withServer`, `createTestEnv` from helpers
- Each describe group: `withServer({ localToken: 'x', peerTokens: {...} }, async (port) => { ... })`

**`inbox.test.ts`:**
- Delete `freshInboxDir()` (lines 25-30)
- Delete `httpRequest` (defined mid-file)
- Delete the ~12 duplicate beforeEach blocks
- File-level beforeEach: `createTestEnv()` + `isolateConfig()`
- Describe groups that need specific token configs use `isolateConfig()` override
- Server integration tests use `withServer()`

**`registry.test.ts`:**
- Delete `freshState()` and `httpRequest`
- Import `createTestEnv`, `httpJSON`, `withServer` from helpers
- Replace try/finally blocks with `withServer()`

**`security.test.ts`:**
- Delete `httpRequest`
- Module-level env sets → `withEnv()` scoping per test
- Replace try/finally blocks with `withServer()`

**`cors.test.ts`:**
- Delete custom `httpRequest` (returns headers)
- Use `httpRaw()` from helpers (also returns headers)
- Replace try/finally blocks with `withServer()`

**`mesh-update.test.ts`:**
- Delete `httpRequest`
- Delete beforeEach server lifecycle
- Import `httpJSON`, `withServer`, `createTestEnv` from helpers
- Each test becomes `withServer({ peerTokens: {...}, tls: { ca: 'ca-host' } }, ...)`

**`web-auth.test.ts`:**
- Delete custom `httpRequest` (form-encoded + cookie support)
- Use `httpRaw()` from helpers for raw body/header access
- Replace beforeEach server lifecycle with `withServer()`

**`mcp.test.ts`:**
- Module-level env sets → `createTestEnv()` + `isolateConfig()` in beforeEach
- Config beforeEach simplifies to `isolateConfig()`

**`enroll.test.ts`:**
- Delete `httpReq`
- Use `httpJSON` from helpers
- Keep the `servers[]` array pattern (enrollment tests create multiple servers)

**`tls.test.ts`:**
- Wrap env var manipulation in `withEnv()`
- Use `createTestEnv()`

#### Hook tests (moderate changes)

**`hook-heartbeat.test.ts`:**
- Delete `runHook` definition
- Delete 5 copies of beforeEach/afterEach tmpHome management
- Import `runHook`, `createTmpHome` from helpers
- Each describe: `const { tmpHome, cleanup } = createTmpHome()` in beforeEach, `cleanup()` in afterEach

**`hook-session.test.ts`:**
- Same as hook-heartbeat.test.ts — delete runHook, use shared helpers

**`peers.test.ts`:**
- Delete `loadIsolatedConfig()` inline helper
- Use `isolateConfig()` from helpers

### 3. Environment Variable Safety

Current state: 6+ files set `process.env.ICC_*` at module level without
cleanup. While Node's `--test` runner uses worker threads per file (preventing
cross-file pollution), within a file tests can leak vars to each other.

After refactor:
- `isolateConfig()` always sets `ICC_IDENTITY` and `clearConfigCache()`
- Tests needing specific env vars use `withEnv()` (auto-restore)
- No module-level `process.env` mutations outside `createTestEnv()` setup
- `ICC_AUTH_TOKEN` references removed (legacy auth token is gone)

### 4. Config Isolation Safety

Current state: tests must manually zero `config.remotes`, `config.server.tls`,
`config.server.localToken`, `config.server.peerTokens` after `loadConfig()`.

After refactor:
- `isolateConfig()` always zeros all four fields
- Live config from `~/.icc/config.json` cannot leak into any test
- Tests that need specific values pass them as overrides (explicit, reviewable)
- `withServer()` calls `isolateConfig()` internally — no way to create a
  server with leaked config

### 5. Verification

After refactoring each file:
- Run `node --test test/<file>.test.ts` — must pass with same count
- Run full suite: `node --test test/*.test.ts` — must match 373 tests
- Temporarily rename `~/.icc/config.json` and re-run — verifies no live config
  dependency (the acid test for isolation)

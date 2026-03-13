# Docker Improvements Phase 1 — Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix 6 Docker infrastructure issues reported by rpi1: graceful shutdown, healthcheck port, reload-config TLS, preflight validation, Dockerfile HEALTHCHECK, and MCP reconnect detection.

**Architecture:** All changes are in the Docker layer (`docker/` files) or server utilities (`src/server.ts`, `bin/icc.ts`). No protocol or transport changes. Each task is independently testable.

**Tech Stack:** Node.js (TypeScript), Docker, existing ICC test helpers

**Spec:** `docs/superpowers/specs/2026-03-13-docker-improvements-phase1-design.md`

---

## Chunk 1: Server-side and Docker infrastructure

### Task 1: Graceful Shutdown

**Files:**
- Modify: `docker/entrypoint.ts:34-121`

The current SIGTERM handler (lines 111-116) calls `process.exit(0)` without stopping services. Services started in `startServices()` are local variables that the shutdown handler can't reach.

- [ ] **Step 1: Lift service references to module level**

Replace the `startServices` function and shutdown handler. Change `docker/entrypoint.ts`:

```typescript
// Add after line 32 (LOCALHOST_HTTP_PORT):
let iccServer: { stop(): Promise<void> } | null = null;
let webServer: { stop(): Promise<void> } | null = null;
let enrollServer: { stop(): Promise<void> } | null = null;
```

In `startServices()`, assign to these module-level vars instead of local `const`:
- Line 41: `const server = createICCServer(...)` → `iccServer = createICCServer(...)`
- Line 48: `const { port, host } = await server.start()` → `const { port, host } = await iccServer.start()`
- Line 55: `const webServer = createWebServer(...)` → `webServer = createWebServer(...)`
- Line 74: `const enrollServer = createEnrollmentServer(...)` → `enrollServer = createEnrollmentServer(...)`

Remove the inner `const` declarations that shadow the module vars.

- [ ] **Step 2: Replace shutdown handler**

Replace lines 110-116 with:

```typescript
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
```

Note: `shuttingDown` guard prevents double-fire if both SIGTERM and SIGINT arrive.

- [ ] **Step 3: Verify TypeScript compiles**

Run: `npx tsc --noEmit`
Expected: No errors

- [ ] **Step 4: Run existing tests**

Run: `node --test test/*.test.ts`
Expected: All 458 tests pass (entrypoint is not unit-tested, but ensures no import breakage)

- [ ] **Step 5: Commit**

```bash
git add docker/entrypoint.ts
git commit -m "fix(docker): graceful shutdown — stop services before exit"
```

---

### Task 2: Reload-Config Includes TLS

**Files:**
- Modify: `src/server.ts:1309-1314` (the `reloadConfig` function)

- [ ] **Step 1: Add `reloadTlsContext()` call to `reloadConfig()`**

In `src/server.ts`, find the `reloadConfig()` function (around line 1309) and add the TLS reload:

```typescript
  function reloadConfig(): void {
    clearConfigCache();
    config = loadConfig({ reload: true });
    setReceiptSender(createReceiptSender(config));
    reloadTlsContext();
    log.info('Config hot-reloaded from disk');
  }
```

The `reloadTlsContext()` function is defined just above `reloadConfig()` in the same scope. It handles errors internally (logs and returns false on failure), so no try/catch needed.

- [ ] **Step 2: Verify TypeScript compiles**

Run: `npx tsc --noEmit`
Expected: No errors

- [ ] **Step 3: Run tests**

Run: `node --test test/*.test.ts`
Expected: All tests pass

- [ ] **Step 4: Commit**

```bash
git add src/server.ts
git commit -m "fix: reload-config endpoint also refreshes TLS context"
```

---

### Task 3: Healthcheck Port Fix

**Files:**
- Modify: `docker/healthcheck.ts:1-34`
- Modify: `Dockerfile:27` (add ENV directive)

- [ ] **Step 1: Rewrite healthcheck to prefer localhost HTTP port**

Replace the entire contents of `docker/healthcheck.ts`:

```typescript
#!/usr/bin/env node

/**
 * Docker healthcheck script.
 * Prefers the localhost HTTP listener (ICC_LOCALHOST_HTTP_PORT) when available.
 * Falls back to TLS-aware probe on :3179 otherwise.
 */

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { get as httpGet } from 'node:http';
import { get as httpsGet } from 'node:https';

const localhostHttpPort = process.env.ICC_LOCALHOST_HTTP_PORT;

if (localhostHttpPort) {
  // Preferred: hit the plain HTTP localhost listener (no TLS needed)
  httpGet(`http://127.0.0.1:${localhostHttpPort}/api/health`, (res) => {
    process.exit(res.statusCode === 200 ? 0 : 1);
  }).on('error', () => process.exit(1));
} else {
  // Fallback: TLS-aware probe on main port
  const tlsDir = join(homedir(), '.icc', 'tls');
  const hasTls = existsSync(join(tlsDir, 'ca.crt'));

  if (hasTls) {
    httpsGet({
      hostname: '127.0.0.1',
      port: 3179,
      path: '/api/health',
      ca: readFileSync(join(tlsDir, 'ca.crt')),
      cert: readFileSync(join(tlsDir, 'server.crt')),
      key: readFileSync(join(tlsDir, 'server.key')),
      rejectUnauthorized: false,
    }, (res) => {
      process.exit(res.statusCode === 200 ? 0 : 1);
    }).on('error', () => process.exit(1));
  } else {
    httpGet('http://127.0.0.1:3179/api/health', (res) => {
      process.exit(res.statusCode === 200 ? 0 : 1);
    }).on('error', () => process.exit(1));
  }
}
```

- [ ] **Step 2: Add ENV to Dockerfile**

In `Dockerfile`, add after line 27 (`EXPOSE 3179 3180 4179`):

```dockerfile
ENV ICC_LOCALHOST_HTTP_PORT=3178
```

This makes the env var visible to the healthcheck subprocess.

- [ ] **Step 3: Verify TypeScript compiles**

Run: `npx tsc --noEmit`
Expected: No errors

- [ ] **Step 4: Commit**

```bash
git add docker/healthcheck.ts Dockerfile
git commit -m "fix(docker): healthcheck uses localhost HTTP port when available"
```

---

### Task 4: Dockerfile HEALTHCHECK Directive

**Files:**
- Modify: `Dockerfile` (add HEALTHCHECK before CMD)

- [ ] **Step 1: Add HEALTHCHECK directive**

In `Dockerfile`, add after the new `ENV ICC_LOCALHOST_HTTP_PORT=3178` line (before `USER icc`):

```dockerfile
HEALTHCHECK --interval=30s --timeout=5s --retries=3 --start-period=10s CMD ["node", "docker/healthcheck.ts"]
```

The full Dockerfile end section should now be:

```dockerfile
EXPOSE 3179 3180 4179

ENV ICC_LOCALHOST_HTTP_PORT=3178

HEALTHCHECK --interval=30s --timeout=5s --retries=3 --start-period=10s CMD ["node", "docker/healthcheck.ts"]

USER icc

ENTRYPOINT ["node", "docker/entrypoint.ts"]
```

- [ ] **Step 2: Commit**

```bash
git add Dockerfile
git commit -m "feat(docker): add HEALTHCHECK directive to Dockerfile"
```

---

### Task 5: Preflight Validation in Entrypoint

**Files:**
- Modify: `docker/entrypoint.ts` (add `preflight()` function, call from `startServices()`)

- [ ] **Step 1: Add preflight function**

In `docker/entrypoint.ts`, update the existing `node:fs` import on line 11 to include the additional functions needed:

```typescript
import { existsSync, mkdirSync, accessSync, writeFileSync, unlinkSync, constants } from 'node:fs';
```

Add the preflight function before `startServices()`:

```typescript
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
```

- [ ] **Step 2: Call preflight from startServices()**

In `startServices()`, after `clearConfigCache()` and before `createICCServer()`, load config and run preflight:

```typescript
async function startServices(setupToken?: string): Promise<void> {
  const { clearConfigCache, loadConfig } = await import('../src/config.ts');
  clearConfigCache();

  const config = loadConfig();
  preflight(config);

  const { createICCServer } = await import('../src/server.ts');
  // ... rest unchanged
```

Note: Update the existing `clearConfigCache` import on line 36 to also import `loadConfig`.

- [ ] **Step 3: Verify TypeScript compiles**

Run: `npx tsc --noEmit`
Expected: No errors

- [ ] **Step 4: Run tests**

Run: `node --test test/*.test.ts`
Expected: All tests pass

- [ ] **Step 5: Commit**

```bash
git add docker/entrypoint.ts
git commit -m "feat(docker): preflight validation for data dir and TLS certs"
```

---

## Chunk 2: MCP Reconnect Detection

### Task 6: MCP Reconnect Detection in Docker Hooks

**Files:**
- Modify: `src/server.ts:464,479` (heartbeat hook commands in `/setup/claude-code` response)

**Spec deviation note:** The spec targets `bin/icc.ts` (hook check handler), but Docker hooks don't use `bin/icc.ts` — they're shell commands generated by the server's `/setup/claude-code` endpoint in `src/server.ts`. This plan targets the actual Docker hook commands.

In Docker mode, hooks are shell commands generated by the `/setup/claude-code` endpoint. The heartbeat hooks (lines 464 and 479) run a curl that fails silently on error (`|| true`).

The fix: modify both hook commands to detect server unreachability and echo a warning. This runs entirely in the shell command — no new server endpoint needed.

- [ ] **Step 1: Update both heartbeat hook commands**

In `src/server.ts`, find the `SessionStart compact` hook (line 464) and `UserPromptSubmit` hook (line 479). Both currently have the same command. Replace both with:

Current (identical on both lines):
```
ST=$(cat /tmp/icc-session-$PPID.token 2>/dev/null); [ -n "$ST" ] && curl -sf -X POST ${localBaseUrl}/api/hook/heartbeat${authHeader} -H 'Content-Type: application/json' -d "{\"sessionToken\":\"$ST\"}" || true
```

New (identical on both lines):
```
ST=$(cat /tmp/icc-session-$PPID.token 2>/dev/null); [ -n "$ST" ] && curl -sf --max-time 1 -X POST ${localBaseUrl}/api/hook/heartbeat${authHeader} -H 'Content-Type: application/json' -d "{\"sessionToken\":\"$ST\"}" || { [ -n "$ST" ] && echo "[ICC] Server unreachable — reconnect MCP with /mcp"; true; }
```

Shell logic: `[ -n "$ST" ] && curl ...` succeeds only if both the token exists AND curl succeeds. On failure, the `||` block fires. The inner `[ -n "$ST" ]` check ensures the warning only appears when we had a session token (meaning we were previously connected, not just uninitialized). The `; true` ensures the hook exits 0.

- [ ] **Step 2: Verify TypeScript compiles**

Run: `npx tsc --noEmit`
Expected: No errors

- [ ] **Step 3: Run tests**

Run: `node --test test/*.test.ts`
Expected: All tests pass

- [ ] **Step 4: Commit**

```bash
git add src/server.ts
git commit -m "feat(docker): surface MCP reconnect hint when server unreachable"
```

---

## Final Steps

- [ ] **Run full test suite one last time**

Run: `node --test test/*.test.ts`
Expected: All tests pass

- [ ] **Push to origin**

```bash
git push
```

- [ ] **Notify rpi1 to pull and rebuild**

Send ICC message to rpi1 with the list of changes and instructions to `git pull && docker compose build && docker compose up -d`.

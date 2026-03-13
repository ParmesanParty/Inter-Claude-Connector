# Docker Improvements — Phase 1 (Code Fixes)

**Date:** 2026-03-13
**Origin:** Feedback from rpi1 (Docker node in mesh) cataloging friction points
**Scope:** 6 code changes to Docker infrastructure; docs deferred to phase 2

## Context

rpi1 is the only Docker-based node in the ICC mesh. It reported 9 friction points prioritized by impact. This spec covers the 6 code changes (items 1, 2, 4, 5, 6, 7). Documentation items (3, 8, 9) are deferred to phase 2.

## 1. Graceful Shutdown

**Problem:** `docker/entrypoint.ts` catches SIGTERM but calls `process.exit(0)` without calling `server.stop()`. This orphans watcher sessions and drops in-flight requests on every container restart.

**Files:** `docker/entrypoint.ts`

**Design:**
- Track started services (ICC server, web server, enrollment server) as module-level references (initially null)
- `startServices()` assigns to these module-level vars after starting each service
- Replace the bare `process.exit(0)` SIGTERM/SIGINT handlers with a `shutdown()` function that:
  1. Calls `.stop()` on each started service (returns a Promise)
  2. Awaits all stop promises with `Promise.allSettled`
  3. Hard-exits after a 10s timeout if services don't stop cleanly
- `shutdown()` is safe to call before `startServices()` completes — `.filter(Boolean)` skips null refs
- The `server.stop()` method already exists on ICCServer — it closes the HTTP listener and drains connections

**Example:**
```typescript
let iccServer: ICCServer | null = null;
let webServer: { stop(): Promise<void> } | null = null;
let enrollServer: { stop(): Promise<void> } | null = null;

async function shutdown() {
  log.info('Shutting down...');
  const timeout = setTimeout(() => process.exit(1), 10_000);
  const stops = [iccServer, webServer, enrollServer]
    .filter(Boolean)
    .map(s => s!.stop().catch(err => log.warn(`Stop error: ${err.message}`)));
  await Promise.allSettled(stops);
  clearTimeout(timeout);
  process.exit(0);
}

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
```

## 2. Healthcheck Port Fix

**Problem:** `docker/healthcheck.ts` hardcodes port 3179. When TLS is enabled, the localhost HTTP listener runs on `ICC_LOCALHOST_HTTP_PORT` (default 3178) — plain HTTP, no client certs. The healthcheck loads TLS client certs unnecessarily.

**Files:** `docker/healthcheck.ts`

**Design:**
- Read `ICC_LOCALHOST_HTTP_PORT` from env
- If set: hit `http://127.0.0.1:{port}/api/health` over plain HTTP (no TLS config needed)
- If not set: fall back to current behavior (port 3179 with TLS-aware logic)
- This simplifies the common Docker path where `ICC_LOCALHOST_HTTP_PORT` is always set by the entrypoint

**Note:** `ICC_LOCALHOST_HTTP_PORT` is set within the entrypoint process. For the healthcheck subprocess to see it, it must be declared in the Dockerfile or docker-compose.yml as an `ENV` directive (default `3178`). Add `ENV ICC_LOCALHOST_HTTP_PORT=3178` to the Dockerfile.

## 3. Reload-Config Includes TLS

**Problem:** `POST /api/reload-config` reloads JSON config but not TLS context. `SIGHUP` does reload TLS, but Docker users won't know to `docker kill -s HUP icc`.

**Files:** `src/server.ts`

**Design:**
- In the `reloadConfig()` function, call `reloadTlsContext()` after reloading the JSON config
- `reloadTlsContext()` already exists and handles errors gracefully (logs and returns false on failure)
- One-liner addition:

```typescript
function reloadConfig(): void {
  clearConfigCache();
  config = loadConfig({ reload: true });
  setReceiptSender(createReceiptSender(config));
  reloadTlsContext();  // ← add this
  log.info('Config hot-reloaded from disk');
}
```

**Note:** `reloadTlsContext()` already calls `clearConfigCache()` + `loadConfig({ reload: true })` internally. Since `reloadConfig()` just set the cache, the second load is a no-op (returns the cached value). No wasted work, but for clarity we could pass the already-loaded config to avoid the redundant call. However, `reloadTlsContext()` is also called standalone from SIGHUP, so keep it self-contained.

## 4. Preflight Validation in Entrypoint

**Problem:** If TLS certs are missing, config is malformed, or the data dir isn't writable, the failure is cryptic. A preflight check with clear error messages would save debugging time.

**Files:** `docker/entrypoint.ts`

**Design:**
- Add a `preflight(config)` function that runs after config load but before `createICCServer()`
- Checks:
  1. **Data dir writable:** Try `writeFileSync` + `unlinkSync` on a temp file in `~/.icc/`
  2. **TLS certs exist** (if `config.server.tls.enabled`): Verify `certPath`, `keyPath`, `caPath` are readable with `accessSync(path, constants.R_OK)`
  3. **Port not in use:** Optional — skip this, let the server's own EADDRINUSE error surface
- On failure: log a clear error message and `process.exit(1)`
- Runs only in `startServices()`, not during setup wizard

## 5. HEALTHCHECK Directive in Dockerfile

**Problem:** Healthcheck is only defined in `docker-compose.yml`. Users running `docker run` directly or deploying to K8s have no built-in healthcheck.

**Files:** `Dockerfile`

**Design:**
- Add a HEALTHCHECK directive matching the compose config:
```dockerfile
HEALTHCHECK --interval=30s --timeout=5s --retries=3 --start-period=10s \
  CMD ["node", "docker/healthcheck.ts"]
```
- Place it after the `EXPOSE` directives, before `CMD`

## 6. MCP Reconnect Detection

**Problem:** Every Docker restart requires the user to manually reconnect MCP. There's no prompt or hint — the session just silently loses its ICC tools.

**Files:** `bin/icc.ts` (hook check handler)

**Design:**
- In the `icc hook check` handler (runs on every `UserPromptSubmit`), add a quick health probe before checking signal files
- Probe: HTTP GET to `http://127.0.0.1:{port}/api/health` with a 500ms timeout (localhost connections either succeed instantly or fail with ECONNREFUSED — no need for 2s)
- If the probe fails (connection refused, timeout), output to stdout:
  `[ICC] Server unreachable — reconnect MCP with /mcp`
- If the probe succeeds, continue with normal signal file checking
- Docker detection: check for `/.dockerenv` file existence (reliable). Do not use `ICC_LOCALHOST_HTTP_PORT` for detection — bare-metal users could set it too
- This fires at most once per prompt submission, so it's not noisy

**Consideration:** On bare-metal hosts, the ICC server is managed by systemd and auto-restarts. The MCP connection is via stdio (not HTTP), so this probe is Docker-specific. Gate it behind `/.dockerenv` to avoid false alarms on bare-metal hosts where the server might be briefly down during a restart.

---

## Out of Scope (Phase 2 — Documentation)

- Item 3: Env var reference documentation
- Item 8: Docker troubleshooting guide
- Item 9: Upgrade path documentation

## Testing

- **Graceful shutdown:** Manual test — `docker stop icc`, verify logs show "Shutting down..." and services stop cleanly
- **Healthcheck:** Run `docker/healthcheck.ts` with and without `ICC_LOCALHOST_HTTP_PORT` set. Also verify behavior during wizard mode (wizard serves on :3179 without TLS, healthcheck should still pass)
- **Reload TLS:** Existing test suite covers `reloadConfig()` — verify TLS reload is called
- **Preflight:** Unit test with missing cert paths, unwritable dir
- **Dockerfile HEALTHCHECK:** `docker inspect` to verify directive present
- **MCP reconnect:** Manual test — restart container, submit a prompt, verify hint appears

## Implementation Order

1. Graceful shutdown (highest impact, enables clean restarts for all other testing)
2. Reload-config TLS (one-liner, already have the endpoint)
3. Healthcheck port fix (small, self-contained)
4. Dockerfile HEALTHCHECK (one line)
5. Preflight validation (new function, moderate scope)
6. MCP reconnect detection (hook change, needs Docker-detection logic)

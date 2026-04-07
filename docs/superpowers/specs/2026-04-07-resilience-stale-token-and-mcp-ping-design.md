# Resilience: Docker Stale-Token Recovery + SessionStart MCP Ping — Design

**Date:** 2026-04-07 (rewritten after code inspection invalidated the original draft)
**Status:** Approved, ready for implementation plan
**Sub-project:** C of 4 (Docker update flow improvements)
**Related:** rpi1 proposal items #5 and #6 in thread `9f20c338`

## Problem

Two friction points. One is Docker-specific; one is general.

### Problem 1 — Stale Docker watcher session tokens after container restart

**Background:** ICC has two completely different watcher implementations.

- **Bare-metal** uses the `icc hook watch` subcommand (`bin/icc.ts:647`). The watcher is a long-lived Node process that polls local signal files (`~/.icc/unread.<instance>`) via `setInterval`. It does not talk to `/api/watch`. Token validation happens once at startup via a heartbeat call; if the token is unknown, the watcher deletes it and re-registers before entering the poll loop. A server restart never breaks the steady-state bare-metal watcher: signal files are written by the local server to the local filesystem, and the poll loop reads them without needing any authenticated server round-trip. **There is no stale-token bug on bare-metal.**

- **Docker** uses a shell-based long-poll. The `/watch` skill (templated by `/setup/claude-code` in the Docker-served response at `src/server.ts:593-606`) instructs the Claude Code model to launch `curl http://localhost:3178/api/watch?instance=X&sessionToken=Y` as a background task. That curl call blocks inside the kernel until either mail arrives or the connection drops. When it returns, the skill's background-task-completion handler parses the body and either calls `check_messages` + relaunches, or silently relaunches on connection drop.

**The bug:** after a `docker compose up -d`, the host's `/tmp/icc-session-$PPID.token` still holds the pre-restart session token. The next curl call replays that token against a container whose in-memory registry was wiped. Today the server accepts the stale token without complaint: `/api/watch` at `src/server.ts:1226-1233` sets the token in `activeWatchers`, calls `sessionReconnect(sessionToken)` which returns `false` for an unknown token, **but the handler ignores the return value** and enters the long-poll normally. The connection blocks forever waiting for mail on a token the registry does not know about. Mail notifications still work (because `inboxSubscribe` is keyed on the connection, not the token), but the session is effectively zombied — heartbeats fail, registry consistency is broken, and the only recovery path is the user noticing something is wrong and running `/watch --force` to evict the ghost and re-register.

rpi1 has a `feedback_docker_restart` memory entry hardcoding this recovery dance. They want the recovery to be automatic so the memory entry can be deleted.

### Problem 2 — Silent MCP unreachability at SessionStart (general)

When the local ICC server is down (container restarting, systemd unit failed, port collision), the existing `icc hook check` heartbeat that runs on `UserPromptSubmit` and `PostToolUse` will detect it on the next prompt and emit a reconnect hint. But there is a window between session-open and the user's first prompt where MCP is broken and the user has no idea — they type a message expecting it to work and only then discover the failure.

This problem is not Docker-specific. Any host whose server is down at session open hits it. Docker hits it more often because `docker compose up -d` takes a few seconds of downtime and the user opening a Claude Code session in that window would see it; bare-metal systemd restarts are subject to the same race.

## Goal

After this work:

- Docker watcher recovery after a container restart is fully automatic and silent. The `/watch` skill's background task sees a clear signal, re-registers with a fresh token, and relaunches without user intervention. rpi1's `feedback_docker_restart` memory entry becomes deletable.
- On every host (Docker and bare-metal), the "MCP unreachable" hint surfaces immediately on SessionStart, not lazily on the next prompt.

## Non-goals

- Persisting the registry across server restarts (a much larger change that would defeat the GRACE/PURGATORY state machine's deliberate ephemerality)
- Auto-running `/mcp` from the unreachable hint (the hint stays advisory; the user remains in control)
- Detecting partial server failures (e.g. server up but inbox DB locked) — `/api/health` is the line we accept
- Cross-host stale-token detection
- Any change to the bare-metal watcher path — `icc hook watch` already handles the equivalent cases correctly at startup, and its steady-state loop does not touch `/api/watch`

## Design

### Component 1: Server-side stale-token detection on `/api/watch`

**File:** `src/server.ts`, the `/api/watch` handler around line 1207.

**Current code (lines 1226-1233):**

```ts
if (sessionToken) {
  if (activeWatchers.has(sessionToken)) {
    sendJSON(res, 200, { event: 'duplicate' });
    return;
  }
  activeWatchers.set(sessionToken, res);
  sessionReconnect(sessionToken);   // return value currently ignored
}
```

**New code:**

```ts
if (sessionToken) {
  if (activeWatchers.has(sessionToken)) {
    sendJSON(res, 200, { event: 'duplicate' });
    return;
  }
  // Check that the session still exists in the registry before accepting.
  // sessionReconnect returns false when the token is unknown — e.g. after a
  // server restart wiped the in-memory registry. In that case we must tell
  // the client the token is dead so it can re-register, rather than silently
  // accepting a zombie connection.
  if (!sessionReconnect(sessionToken)) {
    sendJSON(res, 410, { error: 'stale_token', action: 'reregister' });
    return;
  }
  activeWatchers.set(sessionToken, res);
}
```

Note the reordering: `sessionReconnect` is called *before* `activeWatchers.set`, so an unknown-token connection is never recorded. The `duplicate` check still runs first so a legitimate second watcher still reports duplicate.

**Why HTTP 410 Gone:** semantically the textbook code for "the resource you were tracking no longer exists." Distinguishes cleanly from 401 (meaning `localToken` is wrong, a different failure class) and from 400 (meaning the request is malformed). A future second cause of stale tokens — e.g. admin force-evict via a yet-to-exist DELETE endpoint — will drop into the same code path with no protocol changes.

**Why keep the body as JSON:** although the Docker skill only needs the status code to branch, a human debugging with curl gets an informative body, and the `action: reregister` field reserves the design space for other recovery actions we might add later (e.g. `reregister_with_name`).

### Component 2: Docker `/watch` skill template — stale-token recovery branch

**File:** `src/server.ts`, the `/setup/claude-code` response payload, specifically the `skills.watch.content` template string around lines 593-606.

**Current template step 7 (lines 602-605):**

```
7. When the background task completes later, read its output and handle:
   - If output contains "mail": call check_messages MCP tool, then
     relaunch from step 5
   - Otherwise (connection dropped, process killed): silently relaunch
     from step 5
```

**New template step 7:**

```
7. When the background task completes later, read its output and handle:
   - If output contains "stale_token": the session token was invalidated
     (likely because the ICC container was restarted). Delete the stale
     token file:
       rm -f /tmp/icc-session-$PPID.token
     Then silently re-run this skill from step 3 (re-register) to acquire
     a fresh token and relaunch the watcher. Do not tell the user —
     recovery is automatic.
   - If output contains "mail": call check_messages MCP tool, then
     relaunch from step 5 (the existing token is still valid).
   - Otherwise (connection dropped, process killed): silently relaunch
     from step 5 (the existing token is still valid; the connection just
     dropped transiently).
```

**Why the body-string check:** curl's default behavior on HTTP error responses (with `-sf`) is to exit nonzero and produce no stdout. We need to drop the `-f` for the watch invocation so the server's 410 body reaches the skill. The curl invocation becomes:

```bash
RESULT=$(curl -s -w '\n%{http_code}' "${localBaseUrl}/api/watch?instance=INSTANCE&sessionToken=TOKEN"); echo "$RESULT"
```

The trailing `\n%{http_code}` appends the HTTP status code to the output on its own line, so the skill's string-match logic can see both the JSON body and the status. The existing `"mail"` match is on the body, and the new `"stale_token"` match is also on the body (`{"error":"stale_token",...}`), so either string-match approach works. We'll use body matching for both for consistency.

**Why this is skill-layer, not bin/icc.ts:** the Docker watcher runs as `curl + background bash task`, orchestrated from the skill. There is no Node.js code path to modify for Docker — the entire control flow lives in the templated skill instructions that Claude Code executes. Changing `bin/icc.ts` would have no effect on Docker users because they do not install the `icc` CLI on the host at all.

**Bare-metal `/watch` skill is unchanged.** Bare-metal installs a different skill template (currently defined in `docs/claude-code-setup.md`, not templated through the server), which launches `icc hook watch` as a Bash background task. That path already handles stale tokens at startup via the heartbeat check at `bin/icc.ts:662-668`.

### Component 3: SessionStart MCP health pre-check

**This component has two independent implementations because bare-metal and Docker use different hook runtimes.** Both produce the same user-visible behavior at session start.

#### Component 3a: Bare-metal — `bin/icc.ts` hook startup

**File:** `bin/icc.ts`, `hook startup` subcommand at line 580.

**Behavior, integrated at the very top of the startup handler, *before* any other work:**

1. Issue `GET /api/health` against `http://127.0.0.1:${config.server.port}` using the existing `hookRequest` helper's transport (mTLS on bare-metal, plain HTTP on a noAuth dev config)
2. Use a 1-second timeout — short enough to be imperceptible on a healthy session, long enough to forgive a slow-starting server
3. **If the call fails** (connection refused, timeout, non-2xx):
   - Emit `ICC: server not reachable. Run /mcp to reconnect, then /watch to activate.` on stdout
   - **Skip the rest of startup entirely.** Registration would fail with a less informative error. Stale-PID cleanup is deferred to the next successful startup.
4. **If the call succeeds:** continue to the existing startup flow unchanged (stale-PID cleanup, snooze handling, session-instance persistence, signal-file check, registration call, output the normal connected line).

The existing `hookRequest` function only supports POST; we add a small sibling helper `hookGet(path)` (or extend `hookRequest` with a method parameter) that issues a GET and returns `null` on any error. The helper lives next to `hookRequest` in `bin/icc.ts`.

**Why skip stale-PID cleanup on unreachable:** the cleanup is defensive housekeeping that is always safe to defer to the next startup. Not running it on an unreachable-server startup saves ~20 ms of filesystem iteration and keeps the hook behavior simple: "server is down, bail early, do nothing else."

#### Component 3b: Docker — `/setup/claude-code` hooks template

**File:** `src/server.ts`, the `/setup/claude-code` response payload, specifically the `hooks.SessionStart[0].hooks[0].command` (the `startup` matcher entry) and the `hooks.SessionStart[1].hooks[0].command` (the `resume` matcher entry) and the `hooks.SessionStart[3].hooks[0].command` (the `clear` matcher entry). All three currently contain:

```bash
curl -sf -X POST http://localhost:3178/api/hook/startup -H 'Authorization: Bearer <localToken>' -H 'Content-Type: application/json' -d '{"instance":"'"$(basename $PWD)"'"}'
```

**New shape** (the health pre-check wraps the existing POST):

```bash
curl -sf -m 1 -H 'Authorization: Bearer <localToken>' http://localhost:3178/api/health > /dev/null 2>&1 || { echo 'ICC: server not reachable. Run /mcp to reconnect, then /watch to activate.'; exit 0; }; curl -sf -X POST http://localhost:3178/api/hook/startup -H 'Authorization: Bearer <localToken>' -H 'Content-Type: application/json' -d '{"instance":"'"$(basename $PWD)"'"}'
```

Two changes in the one-liner:
- Prepended: `curl -sf -m 1 ... /api/health || { echo "..."; exit 0; }` — hits the health endpoint with a 1-second `-m` timeout, and on any failure emits the unreachable line and exits 0 (so the hook does not fail — it just reports and bails)
- The existing POST continues unchanged after the `;`

The `{authHeader}` string templating already exists in the server's payload-building code, so both curl calls get the Bearer header automatically. No shell-level indirection or env var is needed.

**Why `exit 0` instead of `exit 1`:** hook commands that exit nonzero are treated by Claude Code as errors and surfaced in a way that interrupts the UX. We explicitly want the "server unreachable" case to be a soft warning, not a hook failure. Exit 0 keeps the session proceeding normally with just the advisory line in stdout.

**Why pre-check on `startup`, `resume`, and `clear` but not `compact` / `UserPromptSubmit`:** the spec's intent is the hint appears at *session-open* time. `compact` is mid-session. `UserPromptSubmit` is mid-session. The `resume` and `clear` matchers are session-open equivalents (resume from a prior session, re-fire after /clear), so they get the same treatment as `startup`.

#### Why two implementations, not one abstraction

An earlier draft of this spec claimed the health check was inherited "automatically" via `localBaseUrl`, but that was wrong: `localBaseUrl` is a server-side template variable used when *building* the `/setup/claude-code` payload. The bare-metal hook at `bin/icc.ts:610` calls `hookRequest` directly, not through any template string, so no `localBaseUrl` substitution ever touches it. The two hook runtimes are genuinely independent and need independent changes. Keeping them parallel (same user-visible output, same logic, different implementations) is the correct design given the runtime split.

## Files touched

- `src/server.ts` — `/api/watch` handler: check `sessionReconnect` return, return 410 on unknown token (~5 lines)
- `src/server.ts` — `/setup/claude-code` skill template: new stale-token branch in `/watch` skill step 7 + change curl invocation to not use `-f` (~10 lines in the template string)
- `src/server.ts` — `/setup/claude-code` hooks template: wrap the `SessionStart[startup|resume|clear]` curl commands with a `/api/health` pre-check (~15 lines in the template strings — three matchers × one prepended guard each)
- `bin/icc.ts` — `hook startup` health pre-check + early-exit on unreachable (~25 lines), plus new `hookGet` helper (~20 lines)
- `test/server.test.ts` — new test for `/api/watch` 410 path on stale token
- `test/server.test.ts` or equivalent — new tests for the `/setup/claude-code` payload: `skills.watch.content` contains `stale_token` branch; `hooks.SessionStart[*].command` for startup/resume/clear contains the health pre-check prefix
- `test/hooks.test.ts` — new test for `hook startup` health pre-check behavior (bare-metal)

**No changes to:**
- `docs/claude-code-setup.md` (bare-metal `/watch` skill is unchanged)
- `docs/docker.md` (the Manual Setup reference block uses the same templated skill content; the new step 7 language will propagate via `/sync` once sub-project B ships)
- `~/.claude/CLAUDE.md` template (the handler is already in the Docker skill, not in the global CLAUDE.md)
- The bare-metal `icc hook watch` code path

## Verification

### Test 1 — Docker end-to-end on rpi1 (the reported scenario)

1. On rpi1, open a Claude Code session, run `/watch` to start a fresh watcher
2. `docker compose restart icc` (or `docker compose up -d` after a rebuild)
3. Observe the watcher background task complete with `stale_token` in its output
4. Observe Claude Code silently re-running the skill from step 3 — no user-visible output
5. Confirm the new watcher is alive via `/watch` task tracker or server-side activeWatchers count
6. Send a test message to rpi1 from um890 and confirm delivery
7. **Pass criterion:** zero user input between steps 2 and 6; rpi1 can delete `feedback_docker_restart` from memory without losing recovery functionality

### Test 2 — Docker unit: server `/api/watch` 410

1. Start a test server instance with an empty registry
2. Issue `GET /api/watch?instance=test&sessionToken=deadbeef` with a known-bad token
3. Confirm response status is 410 and body is `{"error":"stale_token","action":"reregister"}`
4. Confirm `activeWatchers` does not contain the bad token afterward
5. Register a legitimate session, issue `/api/watch` with the good token, confirm it either returns `event:mail` immediately or blocks for long-polling — and **not** a 410

### Test 3 — Docker unit: skill template contains the stale-token branch

1. Call the `/setup/claude-code` handler directly from a test
2. Assert that the returned `skills.watch.content` string contains the literal `stale_token` substring in step 7
3. Assert the curl invocation in step 5 does not include `-f` (so error bodies reach the skill)

This is a string-level test, but it is the only way to verify the shipped skill content without spinning up a real Claude Code instance on Docker.

### Test 4 — SessionStart MCP unreachable hint (bare-metal)

1. `systemctl --user stop icc-server` on um890
2. Open a new Claude Code session in any project
3. Confirm SessionStart output includes `ICC: server not reachable. Run /mcp to reconnect, then /watch to activate.` immediately, before any prompt is typed
4. Confirm `~/.icc/session.<pid>.instance` is **not** written (early exit skipped it) — verify by checking the file does not exist at that PID
5. `systemctl --user start icc-server`
6. Open another session, confirm the normal `ICC: connected, N unread. Run /watch to activate.` line appears and the instance file is written

### Test 5 — SessionStart MCP unreachable hint (Docker, rpi1)

1. On rpi1, `docker compose stop icc`
2. Open a new Claude Code session
3. Same observations as Test 4 — confirms the `localBaseUrl` abstraction correctly routes the health check to port 3178 on Docker

### Test 6 — Unit: `hook startup` health pre-check branches

1. Mock a failing fetch → confirm stdout includes the unreachable message, confirm registration is not called (mock the registration helper, assert zero calls), confirm the function returns early without touching the signal-file check or instance-persistence helpers
2. Mock a 200 response → confirm the existing startup code runs normally

## Risks and mitigations

| Risk | Mitigation |
|---|---|
| Dropping `-f` from the `/watch` skill's curl invocation changes behavior for non-stale-token errors (e.g. server 500) — previously curl would exit nonzero and suppress output, now the 500 body reaches the skill | The skill's string-match logic for `"mail"` still works on the body; it only matches when `"mail"` is present. A 500 body does not contain `"mail"` or `"stale_token"`, so it falls into the existing `Otherwise` branch which silently relaunches — which is the current behavior. No regression. |
| 1-second health-check timeout too short on cold Pi container startup | The health endpoint is only reachable after the server is already listening. Once listening, response is sub-100 ms. 1 second is comfortable. If a future user reports false-positive unreachable hints, bump to 2 seconds; one-line change. |
| 410 status code conflicts with some HTTP client library default behavior (auto-retry on 4xx) | Docker watcher uses raw `curl`, no library auto-retry. 410 is treated identically to other 4xx by curl. Covered by Test 2. |
| `sessionReconnect` return value is inverted or has unexpected semantics | Inspected: `src/registry.ts:268-270` — returns `false` only when the token is unknown. Covered by Test 2 and the existing `sessionReconnect` unit tests. |
| Skill template changes require every Docker host to re-sync to pick them up | Yes — this is the exact problem sub-project B solves. Until B ships, rpi1 must manually re-run the wizard (or fetch `/setup/claude-code` by hand) to get the new skill content. Documented as a prerequisite for verification. |
| An `activeWatchers` entry is stranded if `sessionReconnect` succeeds but the subsequent `activeWatchers.set` is not reached due to an exception | Not possible: the two lines are sequential and adjacent with no intervening calls. Covered by Test 2's "no stranded entry" assertion. |
| The `hook startup` early-exit path skips `wakeWatcher(instanceName)` which normally clears the stale snooze, leaving the user with a snoozed watcher they cannot easily unsnooze on next session if the server comes back up | The wake-watcher logic only runs when the server is reachable on the current startup and the session is not a re-fire. On the next startup after the server recovers, normal flow resumes and wake runs. Worst case: the user sees a stale snooze on the first session-open *after* a server-down window, which is resolved by the next session. Acceptable. |

## Out of scope

- Auto-running `/mcp` from the unreachable hint
- Detecting partial server failures beyond the `/api/health` signal
- Cross-host stale-token detection
- Bare-metal watcher changes (not needed)
- Pre-emptive token validation on every `hook startup` (only run `/api/health`; if the server is up, the existing registration call already handles any token issues)

## Open questions

None. All design decisions resolved after the code-inspection-driven rewrite on 2026-04-07.

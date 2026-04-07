# Resilience: Stale-Token Recovery + SessionStart MCP Ping — Design

**Date:** 2026-04-07
**Status:** Approved, ready for implementation plan
**Sub-project:** C of 4 (Docker update flow improvements)
**Related:** rpi1 proposal items #5 and #6 in thread `9f20c338`

## Problem

Two recurring friction points around server restarts and watcher recovery:

### Problem 1 — Stale watcher session tokens after server restart

The instance registry (`src/registry.ts:38`) is purely in-memory (`new Map()`). Any restart of `icc-server` — `systemctl --user restart icc-server` on bare-metal or `docker compose up -d` on Docker — wipes every active watcher's session token. The watcher's long-poll continues against `/api/watch` with a token the server no longer knows about. The current behavior:

- The watcher exits on the next poll cycle (some failure mode in the existing handler — not always a clean signal)
- The model has to remember to re-launch with `--force` or the user has to type `/watch --force`
- rpi1 has a `feedback_docker_restart` memory entry hard-coding this recovery dance

This is **not Docker-specific.** Docker hits it more often because rebuilds happen more often, but the underlying bug exists on every host that runs an `icc-server`.

### Problem 2 — Silent MCP unreachability at SessionStart

When the local ICC server is down (container restarting, systemd unit failed, port collision), the existing `icc hook check` heartbeat that runs on `UserPromptSubmit` and `PostToolUse` will detect it on the next prompt and emit a reconnect hint. But there's a window between session-open and the user's first prompt where MCP is broken and the user has no idea — they'll type a message expecting it to work, then get an error. The hint should fire at SessionStart so the gap closes immediately.

## Goal

After this work:

- Watcher recovery after a server restart is fully automatic and silent. The user sees nothing; the model needs no special memory entry. rpi1's `feedback_docker_restart` memory becomes deletable.
- The "MCP unreachable" hint surfaces immediately on SessionStart, not lazily on the next prompt.

## Non-goals

- Persisting the registry across server restarts (that would be a much larger change and would defeat the GRACE/PURGATORY state machine's deliberate ephemerality)
- Auto-running `/mcp` from the unreachable hint (the hint stays advisory; the user remains in control)
- Detecting partial server failures (e.g. server up but inbox DB locked) — current `/api/health` shape is the line we accept
- Cross-host stale-token detection (e.g. peer's view of a now-restarted neighbor) — out of scope; this targets the local-host watcher loop

## Design

### Component 1: Server-side stale-token signal on `/api/watch`

**File:** `src/server.ts`, `/api/watch` long-poll handler.

**Behavior:** Whenever the long-poll handler attempts to look up the calling session token in the registry and finds nothing, it returns:

```
HTTP/1.1 410 Gone
Content-Type: application/json

{"error":"stale_token","action":"reregister"}
```

**Why 410 Gone:** semantically the textbook code for "the resource you're tracking no longer exists, do not retry with the same identifier." Distinguishes cleanly from 401 (which would mean the `localToken` itself is wrong, a different failure class). Also lets a future second cause of stale tokens — e.g. an admin force-evict via `DELETE /api/registry/:instance` — fall into the same code path with no protocol changes.

**Detection points within the handler:**
1. At the start of each long-poll cycle, when the watcher's reconnect arrives with a session token
2. If the registry entry transitions to `UNREGISTERED` mid-poll (e.g. force-evict in another connection)

In both cases the lookup function returns null and the handler emits the 410.

**Other clients (`curl`, web UI):** unaffected. They don't carry session tokens; they auth via `localToken` Bearer and never hit this path.

### Component 2: Watcher exit-with-marker on 410

**File:** `bin/icc.ts`, `hook watch` long-poll loop.

**Behavior:** When the long-poll receives status 410 (any 410, not just on `/api/watch`), the watcher:

1. Prints `[ICC] Stale session token — re-register` to stdout
2. Calls the existing PID/heartbeat-cleanup helper that the SIGTERM handler uses
3. Exits with code 0

Other 4xx responses still trigger the existing hard-error exit path with their distinct messages. 5xx and connection errors still fall into the existing silent reconnect/backoff loop — those represent transient failures where the same token is still potentially valid.

**Coordination with `~/.claude/CLAUDE.md` (no change to that file):** the existing handler reads:

> When the background watcher task completes, read its output and silently re-launch after handling:
> - If output contains `[ICC] Mail received`: call `check_messages` MCP tool, then re-launch
> - Otherwise (connection dropped, process killed): silently re-launch

The new marker falls into the "otherwise" branch and silently triggers a relaunch. The relaunch goes through `icc hook watch`'s existing startup phase, which always performs fresh registration → fresh token → fresh long-poll. End-to-end, the user sees nothing.

**Why a distinct marker (vs silent exit):** the existing "silently relaunch" path is meant for connection drops where the *same* token is still valid. Re-launching with the same token after a 410 would just hit another 410 forever. The marker is purely a debug-readable signal; the relaunch logic in `~/.claude/CLAUDE.md` doesn't branch on it because `icc hook watch`'s startup phase already does the right thing on every fresh invocation.

### Component 3: SessionStart MCP health pre-check

**File:** `bin/icc.ts`, `hook startup` subcommand.

**Behavior:** New code at the very top of the `startup` handler, *before* the existing registration call:

1. Issue `GET /api/health` against `localBaseUrl` (the same localhost-HTTP base URL the rest of the hook commands use — `localhost:3179` bare-metal, `localhost:3178` Docker; both already abstracted by the existing config-resolution code)
2. Use a 1-second timeout — short enough to be imperceptible on a healthy session, long enough to forgive a slow-starting container on a Pi
3. **If the call fails** (connection refused, timeout, non-2xx):
   - Emit `[ICC] Server unreachable — reconnect MCP with /mcp` on stdout
   - **Skip the registration step entirely.** Registration would just fail with a less informative error; we want the user-facing message to be "MCP server unreachable," not "registration failed" — those imply different mental models even though the root cause is the same.
   - Still emit the existing `ICC: ...` line so the hook's lifecycle position is visible, but with the unreachable hint replacing the connection-state portion.
4. **If the call succeeds:** continue to the existing registration code path unchanged.

**Why this hook (not a new `mcp-check` subcommand):** the `startup` hook already does one server roundtrip (registration). Adding a `/api/health` GET in front of it is a few lines of TypeScript and reuses the same HTTP client code path. There is no other consumer of an `mcp-check` subcommand, so factoring it out would over-decompose.

**Why pre-check, not post-check:** if the server is down, registration fails anyway, and the more informative message ("MCP unreachable") loses to the less informative one ("registration failed") if we let registration run first.

## Files touched

- `src/server.ts` — new 410 path in the `/api/watch` handler (~10 lines)
- `bin/icc.ts` — `hook watch` exit-on-410 (~5 lines), `hook startup` health pre-check (~20 lines)
- `test/server.test.ts` (or wherever `/api/watch` is tested) — new test for 410 path on stale token
- `test/hooks.test.ts` (or equivalent) — new tests for watch exit-on-410 and startup health pre-check
- **No changes** to skills, `~/.claude/CLAUDE.md` (or the docs that template it), `settings.json` templates, MCP tools, the protocol schema doc, or `docs/docker.md`/`docs/claude-code-setup.md` integration sections

## Verification

**Why this is not Docker-specific:** the registry is in-memory on every host (`src/registry.ts:38`). A `systemctl --user restart icc-server` on um890 wipes session tokens identically to a `docker compose up -d` on rpi1. Both Docker and bare-metal benefit equally; the implementation has no Docker-specific code paths.

### Test 1 — Bare-metal end-to-end on um890 (canonical dev test)

1. Open a Claude Code session in any project, run `/watch`, confirm watcher is alive
2. `systemctl --user restart icc-server`
3. Observe the watcher background task complete with `[ICC] Stale session token — re-register` in its output
4. Observe Claude Code's relaunch handler silently re-launch the watcher
5. Confirm the new watcher is alive and a `check_messages` works
6. **Pass criterion:** zero user input required between steps 2 and 5

### Test 2 — Docker end-to-end on rpi1 (rpi1's reported scenario)

1. On rpi1, open a Claude Code session, run `/watch`
2. `docker compose restart icc` (or `up -d` after a rebuild)
3. Same observations as Test 1
4. **Pass criterion:** rpi1 can delete the `feedback_docker_restart` memory entry without losing recovery functionality

### Test 3 — SessionStart MCP unreachable hint (bare-metal)

1. `systemctl --user stop icc-server`
2. Open a new Claude Code session in any project
3. Confirm SessionStart output includes `[ICC] Server unreachable — reconnect MCP with /mcp` immediately, before any prompt is typed
4. Confirm registration was *not* attempted (no error about registration failure)
5. `systemctl --user start icc-server`
6. Open another session, confirm the normal `ICC: connected, N unread. Run /watch to activate.` line appears

### Test 4 — SessionStart MCP unreachable hint (Docker)

1. On rpi1, `docker compose stop icc`
2. Open a new Claude Code session
3. Same observations as Test 3 — confirms the localhost-port abstraction works correctly for the Docker path (`localhost:3178`)

### Test 5 — Unit tests

- `test/server.test.ts`: `/api/watch` returns 410 with the documented body when called with an unknown session token; returns 200 with the long-poll response on a known token
- `test/hooks.test.ts`: `hook watch` exits 0 with the marker on a 410 response; falls into the existing reconnect path on 5xx; falls into the existing hard-error path on other 4xx
- `test/hooks.test.ts`: `hook startup` emits the unreachable hint and skips registration when the health endpoint is unreachable; performs normal registration when it's reachable

## Risks and mitigations

| Risk | Mitigation |
|---|---|
| The 1-second health check timeout is too short on a cold rpi container starting from disk | Cold-start of the Node process inside the container takes ~2s on a Pi 3, but the *health endpoint* is only hit after the server is already listening — once listening, the response is sub-100ms. 1s is comfortable. If a future user reports false-positive unreachable hints, bump to 2s. |
| 410 status code conflicts with some HTTP client library default behavior (auto-retry on certain 4xx) | Watcher uses raw `node:http` request, no library auto-retry; 410 is treated identically to other 4xx by raw clients. Covered by Test 5. |
| Multi-line output from `startup` (existing line + new unreachable hint) confuses the hook output parser | Both lines are written to stdout in the same hook invocation, which Claude Code surfaces in full. No parser involved. Manually verified by reading the existing hook output flow before writing this spec. |
| Re-launched watcher hits another 410 (e.g. server still mid-restart) | The relaunch goes through `icc hook watch`'s startup phase, which calls the registration endpoint synchronously and only enters the long-poll loop after a successful registration. If the server is still down at relaunch time, registration fails, the watcher exits with the existing hard-error path, and the user sees an error in the next task completion notification — same outcome as today, no regression. |

## Open questions

None. All design decisions resolved during brainstorming session 2026-04-07.

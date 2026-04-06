# Uncapped Mail Watcher Lifetime

**Date:** 2026-04-06
**Status:** Approved, pending implementation plan

## Background

The ICC mail watcher currently cycles every ~591 seconds. This cycling exists because the architecture was designed around the assumption that Claude Code's Bash tool enforces a hard 600-second timeout on background tasks (the documented max for the `timeout` parameter).

**This assumption is false.** Empirical testing on 2026-04-05 confirmed that `run_in_background: true` tasks run until natural process exit, ignoring the `timeout` parameter. A 20-minute test task completed cleanly, printed all expected output, and delivered its completion notification to the model.

The cycling architecture is therefore unnecessary complexity. It adds context noise (`[ICC] Watcher cycled` messages stacking up in idle sessions), requires a three-layer timeout cascade (585s server / 591s process / 600s Bash tool) to prevent race conditions, and creates a documented "cognitive pitfall" where the model misreads stacked cycle notifications as rapid cycling.

Prompt cache TTL is not a factor: the default 5-minute cache expires between the current 10-minute cycles anyway, so cycling frequency has no effect on cache warmth. Cache warmth is driven entirely by user activity, not watcher events.

## Goals

1. Remove the 10-minute cycling cap on the mail watcher.
2. Run a single long-lived watcher for the full session lifetime.
3. Preserve existing safety nets for detecting dead watchers and unexpected failures.
4. Reduce context noise from `[ICC] Watcher cycled` notifications.
5. Simplify the codebase and documentation.

## Non-Goals

- Changing the mail detection mechanism (signal files + long-poll remain).
- Changing the relaunch-after-mail behavior (model still relaunches on `[ICC] Mail received`).
- Changing the snooze mechanism.
- Adding a keep-cache-warm ping loop (out of scope; cache warmth is not affected by cycling).

## Design

### Exit conditions (watcher only exits when)

1. **Mail arrives** — watcher prints `[ICC] Mail received` and exits 0. Model handles message then relaunches.
2. **Claude Code session ends** — PID monitoring detects parent death, watcher silently exits.
3. **Signal received** — SIGTERM/SIGINT runs cleanup handlers and exits.
4. **Heartbeat staleness safety net fires** — if the watcher crashes unexpectedly, `icc hook check` (on `UserPromptSubmit`/`PostToolUse`) detects missing or stale heartbeat (>30s) and emits `[ICC] Watcher not running`, prompting the model to relaunch.

There is **no timer-based cycle**. The watcher has no notion of a maximum lifetime.

### Changes by file

#### `bin/icc.ts` — `watch` subcommand

- Remove the `maxTimer` `setTimeout` (currently 591s default).
- Remove the `timeout` flag parsing (no longer needed).
- Remove the `[ICC] Watcher cycled` stdout output.
- Remove the "Force immediate exit" comment block and the `process.exit(0)` that follows cycle cleanup (poll loop naturally exits on mail/PID-death/signal).
- Poll loop continues to check:
  - Mail signal files (exit with `[ICC] Mail received`)
  - Claude Code PID liveness (silent exit if parent dead)
  - Heartbeat file refresh (every 5s, unchanged)

#### `src/server.ts` — `/api/watch` endpoint

- Remove `WATCH_TIMEOUT_MS = 585_000` constant.
- Remove the `setTimeout` that fires `{event: 'timeout'}`.
- Connection holds until mail arrives or client disconnects.
- **Add SSE keepalive comments every 30 seconds** to prevent idle TCP connection drops by intermediate proxies, load balancers, or kernel-level idle timers. SSE comment format: `: keepalive\n\n` (ignored by parser, resets any idle timers).

#### `src/server.ts` — Docker watch skill (`~line 600`)

- Change curl `--max-time 591` to remove the flag entirely (or set to a very large value like `86400` if curl requires a bound).
- Bash `timeout: 600000` parameter is kept — it's a no-op for background tasks and removing it would be a semantic change unrelated to this refactor.

#### `~/.claude/CLAUDE.md` (user global instructions)

- Remove the `[ICC] Watcher cycled` relaunch rule from the "ICC Activation & Mail Watcher" section.
- Remove the "cognitive pitfall" paragraph about rapid cycling illusion — no longer applicable.
- Keep the `[ICC] Mail received` → `check_messages` + relaunch rule.
- Keep the guidance about the `icc hook check` safety net (implicit via `[ICC] Watcher not running` output).

#### Memory (`memory/MEMORY.md`)

- Update "Mail watcher outputs" note to remove `[ICC] Watcher cycled`.
- Update "Watcher timeout: 591s" note — remove, no longer relevant.
- Remove the "Cognitive pitfall" paragraph about rapid cycling.
- Add note: "Watcher lifetime is uncapped; exits only on mail receipt, session end, or signal."

### What stays unchanged

- Heartbeat file writes every 5s (still needed for `icc hook check` staleness detection — this is now the *only* mechanism that detects a dead watcher).
- `isWatcherAlive()` duplicate-launch guard (unchanged).
- Snooze mechanism (`~/.icc/watcher.<instance>.snoozed` file, `/snooze` and `/wake` skills).
- Session-end cleanup hook (`icc hook session-end`).
- SIGTERM/SIGINT cleanup handlers on the watcher process.
- Signal file architecture (`~/.icc/unread.<instance>`, fallback to `~/.icc/unread`).
- PID anchoring via `process.chdir(homedir())` to survive worktree removal.
- Session instance persistence (`~/.icc/session.<pid>.instance`).

## Risks and Mitigations

### Risk 1: TCP connection liveness over hours

HTTP long-poll connections may die silently due to idle timeouts in the kernel, intermediate proxies, or load balancers. An hours-long idle connection is a new regime for ICC.

**Mitigation:** Add SSE keepalive comments every 30 seconds on the server side. This resets idle timers at every network hop. If the connection dies anyway, the client-side poll loop will detect the closed connection and exit; the heartbeat staleness safety net in `icc hook check` will then prompt the model to relaunch on next user activity.

### Risk 2: GitHub issue #11716 (background task system-reminder loops)

A documented Claude Code bug causes infinite system-reminders and token exhaustion for some long-running background tasks.

**Mitigation:** The 20-minute empirical test showed zero anomalies. If issues emerge in practice, a targeted fallback is to reintroduce a cycle — but at a much longer interval (e.g. 1 hour) rather than the current 10-minute cap. This is a revert path, not a design constraint.

### Risk 3: Model forgets background task ID after `/clear`

Already handled by existing mechanisms: `SessionStart clear` hook re-fires `icc hook startup`, and `icc hook check` emits `[ICC] Watcher not running` on next prompt. No change needed.

### Risk 4: Unexpected watcher death with no user activity

If the watcher crashes during a long idle period, no signal will surface until the user next interacts (when `icc hook check` fires). This is identical to the current behavior — the heartbeat staleness check was always the ultimate safety net.

## Testing Strategy

1. **Unit-level:** Existing watcher tests continue to pass after removing timeout-related code paths.
2. **Integration:** Manual verification on `um890`:
   - Launch watcher, verify it runs continuously past 10 minutes.
   - Send a mail message, verify `[ICC] Mail received` fires and watcher exits cleanly.
   - Kill watcher process manually, verify `icc hook check` detects staleness on next prompt.
   - Test across `/clear` — verify re-fire of `SessionStart clear` hook and subsequent relaunch.
3. **Cross-host:** Deploy to rpi0 and derp after um890 validation. Docker host (rpi1) validates the `src/server.ts` watch skill path separately.
4. **Long-duration soak:** Leave a watcher running overnight on um890, verify it's still alive and functional next morning.

## Rollout

Standard ICC deployment: merge to main on um890, pull + restart on rpi0/derp, rebuild on rpi1. No config migration needed — the changes are purely behavioral.

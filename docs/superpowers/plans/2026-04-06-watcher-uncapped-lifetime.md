# Watcher Uncapped Lifetime Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Remove the 591s cycling cap on the ICC mail watcher so it runs for the full session lifetime, exiting only on mail receipt, session end, or signal.

**Architecture:** The watcher currently uses a three-layer timeout cascade (585s server / 591s process / 600s Bash tool) to stay under an assumed 600s hard limit on `run_in_background` tasks. Empirical testing (2026-04-05) proved no such limit exists. This plan strips the timer, enables TCP-level `SO_KEEPALIVE` on the server long-poll socket to survive idle TCP reapers (if any) without corrupting the JSON response body, rewrites three tests that depend on the `--timeout` cycle flag to use SIGTERM-based shutdown instead, and removes all documentation references to cycling.

**Keepalive design note:** An earlier draft used SSE-style comment lines (`: keepalive\n\n`) written into the response body. This was rejected because `/api/watch` clients (the test suite's `httpJSON`, and `JSON.parse` downstream of `curl -sf`) read the entire body and parse it as a single JSON value — comment bytes before the JSON would break them. TCP-level keepalive via `socket.setKeepAlive(true, 30_000)` is invisible to the HTTP layer and solves the same idle-reaper problem at the kernel. If Tailscale/LAN-only deployments never hit idle reapers (plausible — we have no evidence they do), the TCP keepalive is cheap belt-and-braces.

**Tech Stack:** Node.js, TypeScript, `node:test`, the existing ICC watcher architecture.

**Spec:** `docs/superpowers/specs/2026-04-06-watcher-uncapped-lifetime-design.md`

---

## File Structure

**Modified files:**
- `test/hook-heartbeat.test.ts` — rewrite 3 tests that depend on `--timeout` + `[ICC] Watcher cycled`; they will use SIGTERM shutdown like the existing test on line 91.
- `bin/icc.ts` — remove `maxTimer`, remove `--timeout` flag parsing, remove `[ICC] Watcher cycled` output, remove force-exit comment block.
- `src/server.ts` — remove `WATCH_TIMEOUT_MS` and its timer from `/api/watch`, enable `socket.setKeepAlive(true, 30_000)` on the long-poll connection, remove `--max-time 591` from docker watch/wake skill templates, update embedded CLAUDE.md instructions.
- `~/.claude/CLAUDE.md` (user global) — remove cycled relaunch rule and cognitive pitfall paragraph.
- `docs/claude-code-setup.md` — same removals as `~/.claude/CLAUDE.md`.
- `memory/project_watcher_uncapped.md` (new) — short note about the architecture change, linked from `MEMORY.md`.
- `memory/MEMORY.md` — remove "591s timeout" / "Watcher cycled" references, add link to new memory file.

**No new source files.** This is purely a simplification.

---

## Task 1: Rewrite cycle-dependent tests to use SIGTERM

**Files:**
- Modify: `test/hook-heartbeat.test.ts:17-24,26-33,205-213`

Three tests currently spawn `icc hook watch --timeout 1 --interval 1` and assert on `[ICC] Watcher cycled`. With the new architecture, the watcher has no cycle and no `--timeout` flag. These tests verify heartbeat/PID file lifecycle, which we can still verify by spawning the watcher, letting it run briefly, then sending SIGTERM — identical to the pattern at lines 91–107.

- [ ] **Step 1: Rewrite "watch creates heartbeat and PID files, deletes both on exit" (lines 17-24)**

Replace with:

```typescript
  it('watch creates heartbeat and PID files, deletes both on exit', async () => {
    const child = spawn('node', [iccBin, 'hook', 'watch', '--pid', String(process.pid), '--interval', '1'], {
      env: { ...process.env, HOME: tmp.tmpHome, ICC_IDENTITY: 'test-host', ICC_REMOTE_SSH: '', ICC_REMOTE_HTTP: '' },
      stdio: 'pipe',
    });

    await new Promise(resolve => setTimeout(resolve, 1500));
    const files = readdirSync(join(tmp.tmpHome, '.icc'));
    const watcherFiles = files.filter(f => f.startsWith('watcher.'));
    assert.ok(watcherFiles.length > 0, 'heartbeat and PID files should exist while watcher runs');

    child.kill('SIGTERM');
    await new Promise(resolve => child.on('close', resolve));

    const after = readdirSync(join(tmp.tmpHome, '.icc'));
    const afterWatcher = after.filter(f => f.startsWith('watcher.'));
    assert.equal(afterWatcher.length, 0, 'heartbeat and PID files should be deleted after watch exits');
  });
```

- [ ] **Step 2: Rewrite "watch starts even when a provisional heartbeat exists" (lines 26-33)**

Replace with:

```typescript
  it('watch starts even when a provisional heartbeat exists (startup race)', async () => {
    const hbPath = join(tmp.tmpHome, '.icc', `watcher.${instanceName}.heartbeat`);
    writeFileSync(hbPath, new Date().toISOString());

    const child = spawn('node', [iccBin, 'hook', 'watch', '--pid', String(process.pid), '--interval', '1'], {
      env: { ...process.env, HOME: tmp.tmpHome, ICC_IDENTITY: 'test-host', ICC_REMOTE_SSH: '', ICC_REMOTE_HTTP: '' },
      stdio: 'pipe',
    });

    const chunks: Buffer[] = [];
    child.stdout.on('data', (c) => chunks.push(c));

    await new Promise(resolve => setTimeout(resolve, 1500));

    // Watcher should be alive — heartbeat + pid files present
    const files = readdirSync(join(tmp.tmpHome, '.icc'));
    const pidFile = files.find(f => f === `watcher.${instanceName}.pid`);
    assert.ok(pidFile, 'watch should start despite provisional heartbeat');

    child.kill('SIGTERM');
    await new Promise(resolve => child.on('close', resolve));

    const stdout = Buffer.concat(chunks).toString();
    assert.ok(!stdout.includes('already active'), 'should NOT report already active');
  });
```

- [ ] **Step 3: Rewrite "other instance watcher does not block this instance" (lines 205-213)**

Replace with:

```typescript
  it('other instance watcher does not block this instance', async () => {
    writeFileSync(join(tmp.tmpHome, '.icc', 'watcher.other-project.pid'), '1');
    writeFileSync(join(tmp.tmpHome, '.icc', 'watcher.other-project.heartbeat'), new Date().toISOString());

    const child = spawn('node', [iccBin, 'hook', 'watch', '--pid', String(process.pid), '--interval', '1'], {
      env: { ...process.env, HOME: tmp.tmpHome, ICC_IDENTITY: 'test-host', ICC_REMOTE_SSH: '', ICC_REMOTE_HTTP: '' },
      stdio: 'pipe',
    });

    const chunks: Buffer[] = [];
    child.stdout.on('data', (c) => chunks.push(c));

    await new Promise(resolve => setTimeout(resolve, 1500));

    // This instance's watcher should be alive (other-project pid file did not block)
    const files = readdirSync(join(tmp.tmpHome, '.icc'));
    const thisPid = files.find(f => f === `watcher.${instanceName}.pid`);
    assert.ok(thisPid, 'this instance watcher should be running');

    child.kill('SIGTERM');
    await new Promise(resolve => child.on('close', resolve));

    const stdout = Buffer.concat(chunks).toString();
    assert.ok(!stdout.includes('already active'), 'should NOT report already active');
  });
```

- [ ] **Step 4: Verify rewritten tests pass against current code (refactor safety check)**

Run: `node --test test/hook-heartbeat.test.ts`

Expected: **all tests PASS.** The rewritten tests deliberately don't assert on `[ICC] Watcher cycled` or depend on `--timeout` self-exit, so they exercise the same heartbeat/PID/cleanup invariants under both the current cycling architecture and the post-Task-2 uncapped architecture. This is the refactor safety check: if they pass against unmodified `bin/icc.ts`, we know any failure after Task 2 is caused by the Task 2 changes, not the test rewrite. If any test fails here, stop and diagnose before proceeding.

- [ ] **Step 5: Commit**

```bash
git add test/hook-heartbeat.test.ts
git commit -m "test: switch watcher lifecycle tests to SIGTERM shutdown

Preparing for removal of the --timeout cycle flag. SIGTERM-based
shutdown exercises the same cleanup path without relying on
maxTimer behavior."
```

---

## Task 2: Strip maxTimer and cycled output from `bin/icc.ts`

**Files:**
- Modify: `bin/icc.ts:687-752`

Remove `--timeout` flag parsing, `maxTimer` setTimeout, `[ICC] Watcher cycled` stdout output, and the force-exit comment block. The watcher's only exit paths become: mail detection, PID death, SIGTERM/SIGINT.

- [ ] **Step 1: Apply the edit**

Replace lines 687-752 with:

```typescript
      const interval = parseInt((flags.interval as string) || '5', 10) * 1000;
      const monitorPid = flags.pid
        ? parseInt(flags.pid as string, 10)
        : getClaudeCodePid();

      await new Promise<void>((resolve) => {
        // Write PID lock and initial heartbeat
        writeWatcherPid(instanceName);
        writeHeartbeat(instanceName);

        const cleanup = () => {
          deleteWatcherPid(instanceName);
          deleteHeartbeat(instanceName);
        };

        // Graceful shutdown on signals
        const onSignal = () => { cleanup(); process.exit(0); };
        process.on('SIGTERM', onSignal);
        process.on('SIGINT', onSignal);

        // Immediate check
        const signal = checkSignalFiles(instanceName);
        if (signal) {
          cleanup();
          process.stdout.write(`[ICC] Mail received\n${signal}\n`);
          return resolve();
        }

        const poll = setInterval(() => {
          writeHeartbeat(instanceName);

          // PID monitoring: exit when Claude Code session dies
          if (monitorPid) {
            try {
              process.kill(monitorPid, 0);
            } catch {
              cleanup();
              clearInterval(poll);
              resolve();
              return;
            }
          }

          const signal = checkSignalFiles(instanceName);
          if (signal) {
            cleanup();
            process.stdout.write(`[ICC] Mail received\n${signal}\n`);
            clearInterval(poll);
            resolve();
          }
        }, interval);
      });
      // Force immediate exit on Promise resolve (mail receipt / PID death).
      // SIGTERM/SIGINT already exit directly inside onSignal, so only the
      // resolve paths reach here. The explicit exit prevents Node's event
      // loop drain from keeping the process alive long enough for the
      // model to launch a duplicate watcher before this one fully terminates.
      process.exit(0);
    }
```

Key changes:
- Line 688 `timeout` parsing: **deleted**
- `maxTimer` setTimeout block (lines 742-747): **deleted**
- `clearTimeout(maxTimer)` calls inside poll body (lines 726, 737): **deleted**
- Force-exit comment block (lines 749-751): simplified to a one-line comment

- [ ] **Step 2: Run the test suite to confirm no regressions**

Run: `node --test test/hook-heartbeat.test.ts`

Expected: All tests PASS. The SIGTERM-based tests still exercise the same cleanup path.

- [ ] **Step 3: Run the full test suite**

Run: `node --test test/*.test.ts`

Expected: All tests PASS. Then verify no other test references the removed surface:

```
Grep pattern: "Watcher cycled|--timeout|WATCH_TIMEOUT|event.*timeout" path: test glob: "*.test.ts"
```

Expected: no matches. If any test calls `httpJSON`/`httpRaw` against `/api/watch` and asserts `{event: 'timeout'}`, either remove the assertion or delete the test — the timeout event no longer exists.

- [ ] **Step 4: Commit**

```bash
git add bin/icc.ts
git commit -m "feat(watcher): remove cycling timeout from icc hook watch

The watcher now runs for the full session lifetime. Exit paths:
mail detection, PID death, SIGTERM/SIGINT. The --timeout flag and
[ICC] Watcher cycled output are gone. Empirical testing confirmed
run_in_background tasks ignore the 600s timeout parameter, so the
591s cycle was solving a problem that did not exist."
```

---

## Task 3: Strip `WATCH_TIMEOUT_MS` from server `/api/watch`, enable TCP keepalive

**Files:**
- Modify: `src/server.ts:1212-1275`

Remove the 585s timer and the `{event: 'timeout'}` path. Enable OS-level TCP keepalive on the underlying socket so the kernel sends ACK probes on idle connections — this defeats idle-timeout reapers at intermediate network hops (if any exist) without putting any bytes into the HTTP response body. The response remains a single JSON value written via `sendJSON`, so `httpJSON` in the test suite and `JSON.parse(curl ...)` downstream continue to work unmodified.

**Why not SSE comments?** An earlier draft wrote `: keepalive\n\n` into the response body every 30s. That corrupts the response for any client that `JSON.parse`s the full body (including `test/docker-endpoints.test.ts:275` via `httpJSON`). TCP keepalive is invisible to the HTTP layer and needs no client-side change.

- [ ] **Step 1: Rewrite the `/api/watch` handler**

Replace lines 1212-1275 with:

```typescript
    // GET /api/watch — long-poll endpoint for mail watcher (uncapped lifetime)
    if (method === 'GET' && url === '/api/watch') {
      const queryUrl = new URL(req.url || '/', 'http://localhost');
      const instance = queryUrl.searchParams.get('instance');
      const sessionToken = queryUrl.searchParams.get('sessionToken');

      if (!instance) {
        sendJSON(res, 400, { error: 'Missing required param: instance' });
        return;
      }

      // Duplicate guard: atomically check-and-reserve the session slot.
      // Node's single-threaded model makes the check/set pair atomic as long
      // as no await intervenes between them. A future refactor that adds an
      // await here would reintroduce a TOCTOU race.
      if (sessionToken) {
        if (activeWatchers.has(sessionToken)) {
          sendJSON(res, 200, { event: 'duplicate' });
          return;
        }
        activeWatchers.set(sessionToken, res);
        sessionReconnect(sessionToken);
      }

      // Immediate inbox check — return immediately if unread messages exist.
      // Release the reserved slot first so the next watcher can claim it.
      const unread = getUnread();
      const realUnread = unread.filter(m => !isReceipt(m));
      if (realUnread.length > 0) {
        if (sessionToken) activeWatchers.delete(sessionToken);
        sendJSON(res, 200, { event: 'mail', unreadCount: realUnread.length });
        return;
      }

      // Long-poll: block indefinitely until a message arrives or the client
      // disconnects. No server-side timeout; watcher lifetime is bounded
      // only by the client process (icc hook watch) and its PID/signal
      // monitoring.
      //
      // Enable OS-level TCP keepalive so the kernel sends ACK probes on
      // otherwise-idle connections. This defeats any idle-timeout reapers
      // at intermediate network hops without touching the HTTP body, so
      // clients that JSON.parse the full response keep working unchanged.
      req.socket.setKeepAlive(true, 30_000);

      // Declare unsubscribe as a mutable binding BEFORE cleanup references
      // it, to avoid a TDZ error if inboxSubscribe ever fires its callback
      // synchronously during registration.
      let unsubscribe: () => void = () => {};

      const cleanup = () => {
        if (sessionToken) {
          activeWatchers.delete(sessionToken);
          onWatcherDisconnect(sessionToken);
        }
        unsubscribe();
      };

      unsubscribe = inboxSubscribe((msg) => {
        if (isReceipt(msg)) return; // Don't wake on receipts
        cleanup();
        sendJSON(res, 200, { event: 'mail', unreadCount: 1 });
      });

      // Connection close handler (client disconnect)
      req.on('close', () => {
        cleanup();
      });

      return;
    }
```

Key changes vs. current code:
- `WATCH_TIMEOUT_MS` constant: **deleted**
- `setTimeout` firing `{event: 'timeout'}` and `timer.unref()`: **deleted**
- `req.socket.setKeepAlive(true, 30_000)`: **added**
- `sendJSON` retained for both mail and duplicate responses — no chunked-encoding surgery.
- Duplicate-guard reservation moved to happen synchronously *before* any other await-capable code, closing a latent TOCTOU.

**Behavior preserved — `sessionReconnect` ordering.** `sessionReconnect` clears grace/purgatory timers and promotes session state to ACTIVE (see `src/registry.ts:268`). The original code only called it *after* the duplicate-guard short-circuit, so a duplicate watcher never triggered a reconnect. The rewrite preserves that ordering exactly: `sessionReconnect` is inside the non-duplicate branch of the `if (sessionToken)` block. Do not hoist it above the duplicate check — doing so would let a second watcher's request clear timers belonging to the first, already-connected watcher.

- [ ] **Step 2: Run the full test suite**

Run: `node --test test/*.test.ts`

Expected: All tests PASS. **Hang-guard:** `test/docker-endpoints.test.ts:275` ("wakes on new inbox message") previously relied on the server's 585s timeout as an implicit fallback if `inboxSubscribe` wire-up regressed. With the timeout removed, a regression there would hang the suite indefinitely. If `node --test` does not already enforce a per-test timeout in this file, wrap that test with `{ timeout: 5000 }` (node:test supports `it(name, { timeout }, fn)`) so a broken wire-up fails fast.

No test directly exercises `/api/watch` long-poll timeout (verify with):

```
Grep pattern: "api/watch|WATCH_TIMEOUT" path: test glob: "*.test.ts"
```

If any test references `WATCH_TIMEOUT_MS` or asserts `{event: 'timeout'}`, update it to either remove the assertion or drop the test entirely.

- [ ] **Step 3: Commit**

```bash
git add src/server.ts
git commit -m "feat(server): remove /api/watch timeout, add SSE keepalive

Server now holds the long-poll connection indefinitely. A 30-second
SSE keepalive comment prevents intermediate network hops from
killing idle connections. Pairs with uncapped watcher client."
```

---

## Task 4: Remove `--max-time 591` from Docker watch/wake skill templates

**Files:**
- Modify: `src/server.ts:603,686`

The `/setup/claude-code` endpoint generates skill files for Docker-based ICC deployments. The `watch` and `wake` skills both include a curl command with `--max-time 591`. Remove the flag so the curl connection lives as long as the underlying HTTP response.

> **Warning:** These strings live inside a backtick template literal. Preserve `${authHeader}`, `${localBaseUrl}`, and any other `${...}` interpolations exactly — they are real JavaScript expressions, not literal text. Only remove the `--max-time 591 ` substring (including the trailing space).

- [ ] **Step 1: Edit the watch skill template (line 603)**

Change:

```
   RESULT=$(curl --max-time 591 -sf${authHeader} "${localBaseUrl}/api/watch?instance=INSTANCE&sessionToken=TOKEN"); echo "$RESULT"
```

To:

```
   RESULT=$(curl -sf${authHeader} "${localBaseUrl}/api/watch?instance=INSTANCE&sessionToken=TOKEN"); echo "$RESULT"
```

- [ ] **Step 2: Edit the wake skill template (line 686)**

Apply the identical change.

- [ ] **Step 3: Update the step-7 handler in the watch skill template (line 609-612)**

Current text:

```
7. When the background task completes later, read its output and handle:
   - If output contains \`"mail"\`: call \`check_messages\` MCP tool, then
     relaunch from step 5
   - If output contains \`"timeout"\`: relaunch from step 5
```

Replace with:

```
7. When the background task completes later, read its output and handle:
   - If output contains \`"mail"\`: call \`check_messages\` MCP tool, then
     relaunch from step 5
   - Otherwise (connection dropped, process killed): silently relaunch
     from step 5
```

The `"timeout"` event no longer exists; the only non-mail exit is a connection drop, which the model handles by silently relaunching.

- [ ] **Step 4: Update the embedded CLAUDE.md block (lines 531-547)**

Replace:

```
When the background watcher task completes, read its output and silently
re-launch after handling:
- If output contains \`[ICC] Mail received\`: call \`check_messages\` MCP tool, then re-launch
- If output contains \`[ICC] Watcher cycled\`: just re-launch
Do not announce or comment on watcher restarts to the user.

If a watcher launch is denied by a hook or returns \`[ICC] Watcher already active\`,
do nothing — another watcher is already handling this instance. Do not retry.

Known limitation: \`/clear\` kills the watcher — the model loses the background
task ID and can't receive the completion notification. Recovery is automatic:
\`SessionStart clear\` hook re-fires startup. Run \`/watch\` again to reactivate.

Cognitive pitfall: In idle sessions, watcher cycle-completion notifications can
stack up in context without timestamps, creating an illusion of rapid cycling.
Each cycle actually runs its full ~591s. Don't investigate "rapid cycling"
unless wall-clock timing confirms sub-second completion.
```

With the canonical block from **Appendix A**, with each backtick escaped as `\`` because this block lives inside a JavaScript template literal. Do not hand-edit the wording — copy from Appendix A and apply only the backtick-escaping transform.

- [ ] **Step 5: Run tests**

Run: `node --test test/*.test.ts`

Expected: all tests PASS. No test file inspects the embedded template strings.

- [ ] **Step 6: Commit**

```bash
git add src/server.ts
git commit -m "feat(server): update claude-code setup templates for uncapped watcher

Removes --max-time 591 from docker watch/wake curl commands and
rewrites the embedded CLAUDE.md instructions. The model now treats
any non-mail watcher exit as a silent relaunch trigger and relies
on the icc hook check heartbeat safety net for dead-watcher
detection."
```

---

## Task 5: Update `docs/claude-code-setup.md`

**Files:**
- Modify: `docs/claude-code-setup.md:212-229,272-275`

This file is a human-readable walkthrough that mirrors the embedded templates from Task 4. Apply the same edits.

- [ ] **Step 1: Update the CLAUDE.md block (lines 212-229)**

Replace the `When the background watcher task completes...` block through the `Cognitive pitfall:` paragraph with the canonical text from **Appendix A**, used verbatim (plain markdown, no escaping).

- [ ] **Step 2: Update the watch skill block (lines 272-275)**

Replace:

```
4. When the background task completes later, read its output and handle:
   - If output contains `[ICC] Mail received`: call `check_messages` MCP tool, then relaunch
   - If output contains `[ICC] Watcher cycled`: just relaunch
```

With:

```
4. When the background task completes later, read its output and handle:
   - If output contains `[ICC] Mail received`: call `check_messages` MCP tool, then relaunch
   - Otherwise (connection dropped, process killed): silently relaunch
```

- [ ] **Step 3: Verify no other stale references**

```
Grep pattern: "Watcher cycled|591|--max-time" path: docs/claude-code-setup.md
```

Expected: no matches.

- [ ] **Step 4: Commit**

```bash
git add docs/claude-code-setup.md
git commit -m "docs: update claude-code setup guide for uncapped watcher"
```

---

## Task 6: Update `~/.claude/CLAUDE.md` (user global)

**Files:**
- Modify: `~/.claude/CLAUDE.md` (match by content, not line number)

This is the live instruction block the root conversation reads on every session. It must be updated independently of the project repo because it is not tracked in this repository.

> **Warning:** Do not use line numbers to anchor this edit. The user edits `~/.claude/CLAUDE.md` frequently and line numbers drift. Use the Edit tool with the surrounding content as `old_string` — specifically, match the block that starts with `When the background watcher task completes` and ends at the close of the `Cognitive pitfall:` paragraph (the blank line before the next `#` heading).

- [ ] **Step 1: Read the file and locate the block**

Run Read on `~/.claude/CLAUDE.md` first to confirm the current content of the watcher instruction block. Then apply the Edit with the exact current text as `old_string`.

- [ ] **Step 2: Apply the edit**

Replace the located block with the canonical text from **Appendix A**, used verbatim (no escaping).

(Relative to the current content, this removes: "If output contains `[ICC] Watcher cycled`: just re-launch" line, and the entire "Cognitive pitfall" paragraph.)

- [ ] **Step 3: No commit**

`~/.claude/CLAUDE.md` is not tracked in this repo. The change takes effect immediately for the current and future sessions.

---

## Task 7: Update memory

**Files:**
- Create: `/home/albertnam/.claude/projects/-home-albertnam-code-inter-claude-connector/memory/project_watcher_uncapped.md`
- Modify: `/home/albertnam/.claude/projects/-home-albertnam-code-inter-claude-connector/memory/MEMORY.md`

- [ ] **Step 1: Write the new memory file**

Create `project_watcher_uncapped.md` with:

```markdown
---
name: Watcher uncapped lifetime (2026-04-06)
description: ICC mail watcher no longer cycles — runs for full session, only exits on mail/signal/PID-death
type: project
---

As of 2026-04-06, the ICC mail watcher has no cycling timer.

**Why:** Empirical testing on 2026-04-05 confirmed that Claude Code's `run_in_background` Bash tasks ignore the `timeout` parameter and run until natural process exit. The 591s cycle was solving a non-existent problem.

**How to apply:**
- The watcher exits only on: mail receipt (`[ICC] Mail received`), Claude Code PID death, or SIGTERM/SIGINT.
- `[ICC] Watcher cycled` output no longer exists — do not look for it.
- The `--timeout` flag on `icc hook watch` no longer exists.
- `WATCH_TIMEOUT_MS` in `src/server.ts` is gone; `/api/watch` holds the connection indefinitely, with OS-level TCP keepalive (`socket.setKeepAlive(true, 30_000)`) defeating any idle reapers. The response body is still a single JSON value written via `sendJSON` — do not add SSE comment lines, they break `httpJSON`/`JSON.parse` clients.
- If the watcher dies unexpectedly, `icc hook check` (UserPromptSubmit/PostToolUse) emits `[ICC] Watcher not running` on the next prompt — that's the model's signal to relaunch.
- Revert path if #11716 bites us: reintroduce a cycle at a much longer interval (e.g. 1 hour), not 10 minutes.
```

- [ ] **Step 2: Update `MEMORY.md`**

In the "Inbox Notifications" section, remove the lines mentioning `[ICC] Watcher cycled`, "Watcher timeout: 591s", and the "Cognitive pitfall" paragraph. Replace with a single line:

```
- **Watcher lifetime:** Uncapped — exits only on mail/PID-death/signal. See [Watcher uncapped lifetime](project_watcher_uncapped.md).
```

Add the new memory file to the index if `MEMORY.md` has a dedicated references section.

- [ ] **Step 3: No commit**

Memory files are not tracked in the repo.

---

## Task 8: Final verification

- [ ] **Step 1: Full test suite**

Run: `node --test test/*.test.ts`

Expected: all tests PASS, no regressions.

- [ ] **Step 2: Final grep sweep**

```
Grep pattern: "Watcher cycled|WATCH_TIMEOUT|--max-time 591|--timeout.*591" path: .
```

Expected: the only matches should be inside `docs/superpowers/specs/` and `docs/superpowers/plans/` (the design doc and this plan itself, which describe the pre-removal state).

- [ ] **Step 3a: Kick off um890 integration smoke test**

On um890 (primary dev machine):

1. Restart the ICC server: `systemctl --user restart icc-server`
2. Launch a new Claude Code session in a scratch directory
3. Run `/watch` to activate the watcher; record the `run_in_background` task ID
4. Verify the watcher task is running: `TaskOutput block:false` on its ID
5. **Record wall-clock start time** for the idle check

Do NOT proceed to Step 3b until at least 15 wall-clock minutes have elapsed since Step 5. Interleave *unrelated* tasks during the wait — but do NOT run Step 3c (the restart-while-connected check) yet, because restarting the server would invalidate the idle-duration measurement.

- [ ] **Step 3b: Verify um890 idle + mail + recovery checks**

Once 15 wall-clock minutes have elapsed since Step 3a:

6. Verify the watcher is still running — no cycle notification in context, no relaunch occurred, task still `running`
7. Send a test message from another host via the `send_message` MCP tool (e.g. from a WSL2 session)
8. Verify the watcher exits with `[ICC] Mail received`, the model handles the message, and the watcher is relaunched
9. Kill the watcher manually: `kill $(cat ~/.icc/watcher.<instance>.pid)`
10. Submit any prompt to the Claude Code session
11. Verify `icc hook check` emits `[ICC] Watcher not running` and the model relaunches the watcher

- [ ] **Step 3c: Restart-while-connected protocol check**

Run this *after* Step 3b completes so the idle-duration measurement in 3b is not contaminated. Task 3 retains `sendJSON` (no chunked encoding), so the wire protocol is unchanged, but verify explicitly:

1. With a watcher actively long-polling against um890's `icc-server`, run `systemctl --user restart icc-server` in a separate terminal
2. Observe the background task output: the `curl`/watcher should exit with a connection drop (non-`Mail received` exit)
3. Verify the model silently relaunches the watcher per the updated CLAUDE.md rule ("any non-mail exit → silent relaunch")
4. Verify the new watcher registers against the restarted server (heartbeat file refreshes, `~/.icc/watcher.<instance>.pid` updated)

If any step fails, stop and diagnose before deploying to peers — a protocol regression here will break every peer simultaneously.

If all Step 3a/3b/3c checks pass, um890 is verified. Proceed to staged deploy.

- [ ] **Step 4: Staged deploy — rpi0 first**

Deploy to one peer first and verify cross-host watcher behavior before fanning out.

**Preferred path: ICC-mediated deploy.** If a live Claude Code session exists on rpi0, send a message to it asking the peer instance to run `git pull && systemctl --user restart icc-server` locally. This honours the user's ICC-over-SSH preference and the ICC philosophy that peers control themselves.

```
send_message to=rpi0/<active-instance> body="[TOPIC: deploy] Please pull main and restart icc-server to pick up the uncapped watcher change. Reply when done." status=ACTION_NEEDED
```

**Fallback: direct SSH.** Only if no live rpi0 session is available:

```bash
ssh rpi0 'cd ~/code/inter-claude-connector && git pull && systemctl --user restart icc-server'
```

Then from um890:
1. Verify `ping_remote` against rpi0 still works
2. If there is an active Claude Code session on rpi0, verify its watcher relaunched cleanly after the restart (check `~/.icc/watcher.<instance>.heartbeat` freshness on rpi0 via `read_remote_file`)
3. Send a test message from um890 → rpi0 and verify delivery

- [ ] **Step 5: Fan out to remaining peers**

Only after rpi0 is verified. Apply the same ICC-first, SSH-fallback rule to each remaining peer. Only resort to SSH when no live peer session is available to execute the deploy locally.

**Per-peer deploy command (to be executed by the peer instance, or over SSH if none is running):**

- **derp (Hetzner VPS, runs as root):** `cd /root/code/inter-claude-connector && git pull && systemctl --user restart icc-server`
- **rpi1 (docker):** `cd ~/code/inter-claude-connector && git pull && docker compose up -d --build`
- **WSL2:** `cd ~/code/inter-claude-connector && git pull && systemctl --user restart icc-server`

Track acknowledgements and verify with `ping_remote` after each deploy.

- [ ] **Step 6: Close out**

No final commit — all commits were made incrementally per task. Verify `git status` is clean and `git log --oneline -10` shows the expected sequence of 5 commits (Tasks 1, 2, 3, 4, 5).

---

## Task 9: (removed)

Previously an optional keepalive regression test. Deleted along with the SSE-comment keepalive design — TCP-level `setKeepAlive` has no observable application-layer artifact to test, and integration-testing kernel TCP behavior is out of scope for this suite.

---

## Appendix A: Canonical watcher instruction block

Tasks 4, 5, and 6 all rewrite the same block of watcher instructions in three different locations (the `src/server.ts` template literal, `docs/claude-code-setup.md`, and `~/.claude/CLAUDE.md`). To prevent drift, this appendix is the **single source of truth**. When executing Tasks 4/5/6, copy the text below verbatim, transforming only as noted per task.

**Canonical text:**

```markdown
When the background watcher task completes, read its output and silently re-launch after handling:
- If output contains `[ICC] Mail received`: call `check_messages` MCP tool, then re-launch
- Otherwise (connection dropped, process killed): silently re-launch
Do not announce or comment on watcher restarts to the user.

The watcher has no cycling timer — it runs for the full session and only exits on mail receipt, session end, or unexpected process death. If the `icc hook check` safety net emits `[ICC] Watcher not running` on a later prompt, re-launch unless the watcher is snoozed.

If a watcher launch is denied by a hook or returns `[ICC] Watcher already active`, do nothing — another watcher is already handling this instance. Do not retry.

Known limitation: `/clear` kills the watcher — the model loses the background task ID and can't receive the completion notification. Recovery is automatic: `SessionStart clear` hook re-fires startup, and `icc hook check` on the next prompt emits `[ICC] Watcher not running`.
```

**Per-task transformations:**

- **Task 4** (`src/server.ts` template literal): escape every backtick as `\``. No other changes.
- **Task 5** (`docs/claude-code-setup.md`): use verbatim. No escaping.
- **Task 6** (`~/.claude/CLAUDE.md`): use verbatim. No escaping.

If a future edit needs to change the rules, update this appendix first, then propagate to Tasks 4/5/6. Any divergence between the three locations is a bug.

# Watcher Uncapped Lifetime Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Remove the 591s cycling cap on the ICC mail watcher so it runs for the full session lifetime, exiting only on mail receipt, session end, or signal.

**Architecture:** The watcher currently uses a three-layer timeout cascade (585s server / 591s process / 600s Bash tool) to stay under an assumed 600s hard limit on `run_in_background` tasks. Empirical testing (2026-04-05) proved no such limit exists. This plan strips the timer, adds SSE keepalive comments on the server long-poll to survive idle TCP timers, rewrites three tests that depend on the `--timeout` cycle flag to use SIGTERM-based shutdown instead, and removes all documentation references to cycling.

**Tech Stack:** Node.js, TypeScript, `node:test`, the existing ICC watcher architecture.

**Spec:** `docs/superpowers/specs/2026-04-06-watcher-uncapped-lifetime-design.md`

---

## File Structure

**Modified files:**
- `test/hook-heartbeat.test.ts` — rewrite 3 tests that depend on `--timeout` + `[ICC] Watcher cycled`; they will use SIGTERM shutdown like the existing test on line 91.
- `bin/icc.ts` — remove `maxTimer`, remove `--timeout` flag parsing, remove `[ICC] Watcher cycled` output, remove force-exit comment block.
- `src/server.ts` — remove `WATCH_TIMEOUT_MS` and its timer from `/api/watch`, add SSE keepalive comment interval, remove `--max-time 591` from docker watch/wake skill templates, update embedded CLAUDE.md instructions.
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

- [ ] **Step 4: Run tests to verify they fail against current code**

Run: `node --test test/hook-heartbeat.test.ts`

Expected: 3 tests FAIL because current `bin/icc.ts` still has the `--timeout` flag defaulted to 591s; the rewritten tests will spawn a watcher that doesn't self-exit, so the `SIGTERM` path will work — but one test may still pass coincidentally if timing aligns. The key assertion we expect to fail is: any test that reads stdout and finds `[ICC] Watcher cycled` in it still passes, but the new tests don't check for that string, so they should actually PASS against current code too. **Verify by running them now — both old and new code should satisfy the new tests.** If they pass, continue to Task 2.

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
      // Exit cleanly when the poll loop resolves (mail / PID death / signal).
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

Expected: All tests PASS. No other test should reference `[ICC] Watcher cycled` or the `--timeout` flag — verify with:

```bash
```

Then use Grep:

```
Grep pattern: "Watcher cycled|--timeout" path: test glob: "*.test.ts"
```

Expected: no matches.

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

## Task 3: Strip `WATCH_TIMEOUT_MS` from server `/api/watch`, add SSE keepalive

**Files:**
- Modify: `src/server.ts:1212-1275`

Remove the 585s timer. Add a keepalive interval that writes `: keepalive\n\n` to the response every 30 seconds so idle-timeout TCP reapers at any network hop see traffic. SSE comment lines are ignored by EventSource parsers and by the existing ICC client (which only reads a single JSON response body), so the keepalive is transparent.

**Important**: the current `/api/watch` handler uses `sendJSON(res, 200, ...)` to write the response body and close the connection. With keepalive, we need to manually set headers and write the SSE comment stream until the final JSON event, then end the response.

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

      // Duplicate guard: check if a watcher is already connected for this session
      if (sessionToken && activeWatchers.has(sessionToken)) {
        sendJSON(res, 200, { event: 'duplicate' });
        return;
      }

      // Reconnect session if token provided
      if (sessionToken) {
        sessionReconnect(sessionToken);
      }

      // Immediate inbox check — return immediately if unread messages exist
      const unread = getUnread();
      const realUnread = unread.filter(m => !isReceipt(m));
      if (realUnread.length > 0) {
        sendJSON(res, 200, { event: 'mail', unreadCount: realUnread.length });
        return;
      }

      // Long-poll: block indefinitely until message arrives or client disconnects.
      // No server-side timeout; the watcher lifetime is bounded only by the
      // client process (icc hook watch) and its PID/signal monitoring.
      //
      // SSE keepalive comments every 30s keep idle TCP timers from killing
      // long-lived connections at intermediate hops. Clients that read a
      // single JSON response (curl, the ICC watch command) ignore the
      // comment lines because they appear before the JSON body.
      //
      // We must write headers manually — sendJSON sets Content-Length which
      // is incompatible with a stream of keepalive bytes + final body.
      res.writeHead(200, {
        'Content-Type': 'application/json',
        'Transfer-Encoding': 'chunked',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
      });

      if (sessionToken) {
        activeWatchers.set(sessionToken, res);
      }

      const keepalive = setInterval(() => {
        try { res.write(': keepalive\n\n'); } catch { /* connection gone */ }
      }, 30_000);
      keepalive.unref();

      const cleanup = () => {
        clearInterval(keepalive);
        if (sessionToken) {
          activeWatchers.delete(sessionToken);
          onWatcherDisconnect(sessionToken);
        }
        unsubscribe();
      };

      const unsubscribe = inboxSubscribe((msg) => {
        if (isReceipt(msg)) return; // Don't wake on receipts
        cleanup();
        try {
          res.end(JSON.stringify({ event: 'mail', unreadCount: 1 }));
        } catch { /* connection already closed */ }
      });

      // Connection close handler (client disconnect)
      req.on('close', () => {
        cleanup();
      });

      return;
    }
```

Key changes:
- `WATCH_TIMEOUT_MS` constant: **deleted**
- `setTimeout` firing `{event: 'timeout'}`: **deleted**
- `res.writeHead` with chunked transfer: **added**
- `keepalive` interval: **added**
- `unsubscribe` callback: uses `res.end(JSON.stringify(...))` instead of `sendJSON` because headers are already sent.

- [ ] **Step 2: Run the full test suite**

Run: `node --test test/*.test.ts`

Expected: All tests PASS. No test directly exercises `/api/watch` long-poll timeout (verify with):

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

With:

```
When the background watcher task completes, read its output and silently
re-launch after handling:
- If output contains \`[ICC] Mail received\`: call \`check_messages\` MCP
  tool, then re-launch
- Otherwise (connection dropped, process killed): silently re-launch
Do not announce or comment on watcher restarts to the user.

The watcher has no cycling timer — it runs for the full session and only
exits on mail receipt, session end, or unexpected process death. If the
\`icc hook check\` safety net emits \`[ICC] Watcher not running\` on a
later prompt, re-launch unless the watcher is snoozed.

If a watcher launch is denied by a hook or returns \`[ICC] Watcher already
active\`, do nothing — another watcher is already handling this instance.

Known limitation: \`/clear\` kills the watcher — the model loses the
background task ID and can't receive the completion notification.
Recovery is automatic: \`SessionStart clear\` hook re-fires startup, and
\`icc hook check\` on the next prompt emits \`[ICC] Watcher not running\`.
```

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

Replace the `When the background watcher task completes...` block through the `Cognitive pitfall:` paragraph with the same text used in Task 4 Step 4 (un-escaped — no `\`` needed since this is a plain markdown file).

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
- Modify: `~/.claude/CLAUDE.md:23-38`

This is the live instruction block the root conversation reads on every session. It must be updated independently of the project repo because it is not tracked in this repository.

- [ ] **Step 1: Apply the edit**

Replace lines 23-38 with:

```markdown
When the background watcher task completes, read its output and silently re-launch after handling:
- If output contains `[ICC] Mail received`: call `check_messages` MCP tool, then re-launch
- Otherwise (connection dropped, process killed): silently re-launch
Do not announce or comment on watcher restarts to the user.

The watcher has no cycling timer — it runs for the full session and only exits on mail receipt, session end, or unexpected process death. If the `icc hook check` safety net emits `[ICC] Watcher not running` on a later prompt, re-launch unless the watcher is snoozed.

If a watcher launch is denied by a hook or returns `[ICC] Watcher already active`,
do nothing — another watcher is already handling this instance. Do not retry.

Known limitation: `/clear` kills the watcher — the model loses the background
task ID and can't receive the completion notification. Recovery is automatic:
`SessionStart clear` hook re-fires startup, and `icc hook check` on the next
prompt emits `[ICC] Watcher not running`.
```

(Removes: "If output contains `[ICC] Watcher cycled`: just re-launch" line, and the entire "Cognitive pitfall" paragraph.)

- [ ] **Step 2: No commit**

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
- `WATCH_TIMEOUT_MS` in `src/server.ts` is gone; `/api/watch` holds the connection with 30s SSE keepalive comments.
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

- [ ] **Step 3: Integration smoke test (manual)**

On um890 (primary dev machine):

1. Restart the ICC server: `systemctl --user restart icc-server`
2. Launch a new Claude Code session in a scratch directory
3. Run `/watch` to activate the watcher
4. Verify the watcher task is running: `TaskOutput block:false` on its ID
5. Wait at least 15 minutes (well past the former 591s cycle)
6. Verify the watcher is still running — no cycle notification in context, no relaunch occurred
7. Send a test message from another host: `icc send --to um890/<instance> "test"` (or via `send_message` MCP tool from another session)
8. Verify the watcher exits with `[ICC] Mail received`, the model handles the message, and the watcher is relaunched
9. Kill the watcher manually: `kill $(cat ~/.icc/watcher.<instance>.pid)`
10. Submit any prompt to the Claude Code session
11. Verify `icc hook check` emits `[ICC] Watcher not running` and the model relaunches the watcher

If all 11 checks pass, the implementation is complete.

- [ ] **Step 4: Deploy to peers**

After um890 verification passes:

```bash
# rpi0
ssh rpi0 'cd ~/code/inter-claude-connector && git pull && systemctl --user restart icc-server'
# derp
ssh derp 'cd /root/code/inter-claude-connector && git pull && systemctl --user restart icc-server'
# rpi1 (docker)
ssh rpi1 'cd ~/code/inter-claude-connector && git pull && docker compose up -d --build'
```

Note: This deployment uses direct SSH because ICC's `run_remote_command` is read-only by design. The user's preference for ICC-over-SSH applies to inspection commands, not deployment.

- [ ] **Step 5: Close out**

No final commit — all commits were made incrementally per task. Verify `git status` is clean and `git log --oneline -10` shows the expected sequence of 5 commits (Tasks 1, 2, 3, 4, 5).

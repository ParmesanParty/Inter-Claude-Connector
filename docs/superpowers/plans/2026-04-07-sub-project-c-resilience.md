# Sub-project C: Docker Stale-Token Recovery + SessionStart MCP Ping — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make Docker watcher recovery after a container restart fully automatic (no `/watch --force` dance, rpi1 can delete their `feedback_docker_restart` memory entry), and make MCP-unreachable at SessionStart immediately visible on both bare-metal and Docker hosts.

**Architecture:** Three independent changes. (1) Server `/api/watch` returns HTTP 410 when `sessionReconnect` reports an unknown token. (2) Docker `/watch` skill template in `src/server.ts` adds a `stale_token` branch that re-registers and relaunches. (3) SessionStart MCP health pre-check with two parallel implementations — `bin/icc.ts hook startup` for bare-metal, and inline `curl` guard in the `SessionStart[startup|resume|clear]` hook command template for Docker.

**Tech Stack:** Node.js `node:http`/`node:https`, existing `src/registry.ts` session helpers, Node's built-in test runner, shared test helpers in `test/helpers.ts`.

**Related spec:** `docs/superpowers/specs/2026-04-07-resilience-stale-token-and-mcp-ping-design.md`

---

## File structure

| Path | Responsibility | Action |
|---|---|---|
| `src/server.ts` | `/api/watch` handler + `/setup/claude-code` payload (skill + hook templates) | Modify |
| `bin/icc.ts` | `hook startup` subcommand + new `hookGet` helper | Modify |
| `test/server.test.ts` | `/api/watch` 410 test + `/setup/claude-code` template content tests | Modify (append) |
| `test/hooks.test.ts` | `hook startup` health pre-check behavior test | Modify (append) |

No new files. No public API changes. No changes to `docs/`, `bin/icc.ts`'s watch loop, or `~/.claude/CLAUDE.md` templates.

---

## Verified preconditions

These were checked against current `main` (2026-04-07) before the plan was finalized; the implementing agent does not need to re-verify but should be aware:

- **`/api/health` requires no auth** — `src/server.ts:377` handles it before any auth gate. `hookGet` MUST NOT send an `Authorization` header for this path (sending one is harmless but irrelevant; relying on auth would be wrong).
- **`request` from `node:http` is already imported** at `bin/icc.ts:7`. `hookGet` reuses the existing import; do not add a duplicate.
- **`httpJSON` test helper has no built-in timeout** in `test/helpers.ts`. Task 1 adds one (see Step 0 below) so the stale-token tests don't hang and so future tests inherit the protection.

---

## Task 1: Server `/api/watch` — return 410 on unknown session token

- [ ] **Step 0: Bake a default timeout into `httpJSON` helper**

Open `test/helpers.ts` and find `httpJSON`. Add a default 2000ms timeout to the underlying `http.request` options (`timeout: opts?.timeout ?? 2000`) and a `req.on('timeout', () => { req.destroy(new Error('httpJSON timeout')); })` handler. This prevents the stale-token test (and every future test) from hanging when the server hangs instead of responding. Run the existing test suite once to confirm no regressions: `node --test test/*.test.ts 2>&1 | tail -5`.


**Files:**
- Modify: `src/server.ts` (the `/api/watch` handler around line 1226-1233)
- Test: `test/server.test.ts` (append)

- [ ] **Step 1: Write the failing test**

Append this test to `test/server.test.ts`. If the file has a `describe('/api/watch ...')` block, add inside it; otherwise add as a new top-level describe.

```ts
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { withServer, httpJSON } from './helpers.ts';

describe('/api/watch stale-token handling', () => {
  it('returns 410 with stale_token error when session token is unknown', async () => {
    await withServer({}, async ({ port }) => {
      const res = await httpJSON(port, 'GET', '/api/watch?instance=ghost&sessionToken=deadbeefcafebabe');
      assert.equal(res.status, 410);
      assert.deepEqual(res.body, { error: 'stale_token', action: 'reregister' });
    });
  });

  it('does not strand unknown tokens in activeWatchers', async () => {
    // Verified indirectly: a second request with the same bad token must
    // still get 410 (not "duplicate") — proving the first request did not
    // register the bad token.
    await withServer({}, async ({ port }) => {
      await httpJSON(port, 'GET', '/api/watch?instance=ghost&sessionToken=deadbeefcafebabe');
      const res2 = await httpJSON(port, 'GET', '/api/watch?instance=ghost&sessionToken=deadbeefcafebabe');
      assert.equal(res2.status, 410);
      assert.deepEqual(res2.body, { error: 'stale_token', action: 'reregister' });
    });
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
node --test test/server.test.ts 2>&1 | grep -A2 'stale-token'
```

Expected: FAIL with `status !== 410` (the current handler accepts the stale token and would hang; `httpJSON` must have a timeout — if the request hangs, that also counts as "current behavior is wrong").

(Step 0 above already added the helper-level timeout, so the test will fail with a timeout error rather than hanging.)

- [ ] **Step 3: Write the minimal implementation**

Open `src/server.ts`. Find the block at lines 1226-1233:

```ts
if (sessionToken) {
  if (activeWatchers.has(sessionToken)) {
    sendJSON(res, 200, { event: 'duplicate' });
    return;
  }
  activeWatchers.set(sessionToken, res);
  sessionReconnect(sessionToken);
}
```

Replace with:

```ts
if (sessionToken) {
  if (activeWatchers.has(sessionToken)) {
    sendJSON(res, 200, { event: 'duplicate' });
    return;
  }
  // Check that the session still exists in the registry before accepting.
  // sessionReconnect returns false when the token is unknown — e.g. after
  // a server restart wiped the in-memory registry. Telling the client the
  // token is dead (410 Gone) so it can re-register is the only way to
  // recover from that state without stranding a zombie watcher.
  if (!sessionReconnect(sessionToken)) {
    sendJSON(res, 410, { error: 'stale_token', action: 'reregister' });
    return;
  }
  activeWatchers.set(sessionToken, res);
}
```

Note: the call to `sessionReconnect` has moved to *before* `activeWatchers.set`, so an unknown-token connection is never recorded.

- [ ] **Step 4: Run the test to verify it passes**

```bash
node --test test/server.test.ts 2>&1 | grep -A2 'stale-token'
```

Expected: both tests PASS.

- [ ] **Step 5: Run the full server test file**

```bash
node --test test/server.test.ts 2>&1 | tail -15
```

Expected: no regressions. Existing tests still pass.

- [ ] **Step 6: Commit**

```bash
git add src/server.ts test/server.test.ts
git commit -m "feat(server): return 410 on /api/watch with stale session token

When sessionReconnect reports an unknown token (e.g. registry wiped by
server restart), reject the long-poll with HTTP 410 + stale_token body
instead of silently accepting a zombie connection. activeWatchers is
only updated after the session check passes, so bad tokens never
register as duplicates.

Enables Docker /watch skill's stale-token recovery branch in the next
task."
```

---

## Task 2: Docker `/watch` skill template — stale-token branch

**Files:**
- Modify: `src/server.ts` (the `/setup/claude-code` response payload, `skills.watch.content` string around lines 593-606)
- Test: `test/server.test.ts` (append)

- [ ] **Step 1: Write the failing test**

Append to `test/server.test.ts`:

```ts
describe('/setup/claude-code skill template: stale-token recovery', () => {
  it('/watch skill content contains stale_token recovery branch', async () => {
    await withServer({}, async ({ port }) => {
      const res = await httpJSON(port, 'GET', '/setup/claude-code');
      assert.equal(res.status, 200);
      const watchContent: string = res.body.skills.watch.content;
      assert.ok(
        watchContent.includes('stale_token'),
        'skill must reference stale_token for the recovery branch'
      );
      assert.ok(
        watchContent.includes('rm -f /tmp/icc-session-$PPID.token'),
        'skill must delete stale token file'
      );
      assert.ok(
        watchContent.includes('re-run this skill from step 3'),
        'skill must instruct re-running from step 3 (re-register)'
      );
    });
  });

  it('/watch skill curl invocation does not use -f so error bodies reach the skill', async () => {
    await withServer({}, async ({ port }) => {
      const res = await httpJSON(port, 'GET', '/setup/claude-code');
      const watchContent: string = res.body.skills.watch.content;
      // The curl call in step 5 must not suppress error bodies (-f).
      // We check the curl line is structured as `curl -s ...` not `curl -sf ...`.
      const step5Line = watchContent
        .split('\n')
        .find((line) => line.includes('/api/watch?instance='));
      assert.ok(step5Line, 'watch curl line must be present in skill');
      assert.ok(
        !step5Line!.includes('-sf '),
        `watch curl line must not use -f flag; found: ${step5Line}`
      );
    });
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

```bash
node --test test/server.test.ts 2>&1 | grep -A2 'stale-token recovery'
```

Expected: FAIL — current skill content has no `stale_token` branch and uses `curl -sf`.

- [ ] **Step 3: Locate and modify the skill template in src/server.ts**

Find the `watch` skill content around lines 550-606 (the `skills.watch.content` string inside the `/setup/claude-code` handler). In step 5 of the template, change:

```js
5. **Launch the watcher.** Use the Bash tool with \`run_in_background: true\`
   and \`timeout: 600000\`:
   \`\`\`bash
   RESULT=$(curl -sf${authHeader} "${localBaseUrl}/api/watch?instance=INSTANCE&sessionToken=TOKEN"); echo "$RESULT"
   \`\`\`
```

to:

```js
5. **Launch the watcher.** Use the Bash tool with \`run_in_background: true\`
   and \`timeout: 600000\`:
   \`\`\`bash
   RESULT=$(curl -s${authHeader} "${localBaseUrl}/api/watch?instance=INSTANCE&sessionToken=TOKEN"); echo "$RESULT"
   \`\`\`
```

The only change on that line is `curl -sf` → `curl -s` (drop the `-f` so the 410 body reaches the skill output).

**Note on `-f` asymmetry between this task and Task 4:** Task 4 keeps `curl -sf` on the `/api/health` pre-check because the health check only needs the exit code (no body parsing). This task drops `-f` on the watch invocation because the skill *must* see the `stale_token` body to branch on it. The two are not in tension.

Then replace the existing step 7 block:

```js
7. When the background task completes later, read its output and handle:
   - If output contains \`"mail"\`: call \`check_messages\` MCP tool, then
     relaunch from step 5
   - Otherwise (connection dropped, process killed): silently relaunch
     from step 5`,
```

with:

```js
7. When the background task completes later, read its output and handle:
   - If output contains \`"stale_token"\`: the session token was invalidated
     (likely because the ICC container was restarted). Delete the stale
     token file with \`rm -f /tmp/icc-session-$PPID.token\`, then silently
     re-run this skill from step 3 (re-register) to acquire a fresh token
     and relaunch the watcher. Do not tell the user — recovery is automatic.
   - If output contains \`"mail"\`: call \`check_messages\` MCP tool, then
     relaunch from step 5 (the existing token is still valid).
   - Otherwise (connection dropped, process killed): silently relaunch
     from step 5 (the existing token is still valid; the connection just
     dropped transiently).`,
```

- [ ] **Step 4: Run the tests to verify they pass**

```bash
node --test test/server.test.ts 2>&1 | grep -A2 'stale-token recovery'
```

Expected: both tests PASS.

- [ ] **Step 5: Run the full server test file for regressions**

```bash
node --test test/server.test.ts 2>&1 | tail -15
```

Expected: no regressions.

- [ ] **Step 6: Commit**

```bash
git add src/server.ts test/server.test.ts
git commit -m "feat(server): add stale_token branch to Docker /watch skill template

When the /api/watch long-poll returns a 410 body, the skill now detects
the stale_token marker, deletes the session token file, and silently
re-runs step 3 (re-register) to recover. Also drops curl -sf → curl -s
on the watch invocation so the 410 body reaches the skill output.

Existing mail-receipt and connection-drop branches unchanged. Recovery
is invisible to the user.

Completes the Docker stale-token recovery loop started in the previous
commit."
```

---

## Task 3: Bare-metal — `hook startup` health pre-check + `hookGet` helper

**Files:**
- Modify: `bin/icc.ts` (add `hookGet` helper near line 566, modify `hook startup` at line 580)
- Test: `test/hooks.test.ts` (append)

- [ ] **Step 1: Write the failing test**

Append to `test/hooks.test.ts` (or create if the file doesn't exist — check first with `ls test/hooks.test.ts`):

```ts
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { runHook, createTmpHome, withServer } from './helpers.ts';

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
    const tmpHome = createTmpHome();
    // No server running — hook should fail health check.
    const { stdout } = await runHook('startup', { HOME: tmpHome, ICC_PORT: '39999' });
    assert.ok(
      stdout.includes(UNREACHABLE_HINT),
      `stdout must contain the exact unreachable hint; got: ${JSON.stringify(stdout)}`
    );
  });

  it('proceeds with normal registration when server responds to /api/health', async () => {
    const tmpHome = createTmpHome();
    await withServer({}, async ({ port }) => {
      const { stdout } = await runHook('startup', {
        HOME: tmpHome,
        ICC_PORT: String(port),
      });
      assert.match(stdout, /^ICC: connected, \d+ unread\. Run \/watch to activate\.$/m);
      assert.ok(!stdout.includes(UNREACHABLE_HINT), 'must not emit unreachable hint on healthy server');
    });
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
node --test test/hooks.test.ts 2>&1 | grep -A2 'MCP health pre-check'
```

Expected: FAIL — the existing startup hook emits the old wording `ICC: server not reachable. Run /watch to activate when ready.` which does not match the exact string `UNREACHABLE_HINT` constant defined in the test. The implementation in Step 4 updates the wording to match.

- [ ] **Step 3: Add the `hookGet` helper**

Open `bin/icc.ts`. Find the `hookRequest` function at line 530. Immediately below its closing `}` (before `async function hook()` at line 568), add:

```ts
/**
 * GET-variant of hookRequest for health checks and other non-mutating calls.
 * Returns parsed JSON on success, or null on any error (connection refused,
 * timeout, non-2xx, JSON parse failure). 1-second timeout — intentionally
 * short so it does not delay a healthy SessionStart.
 */
async function hookGet(path: string): Promise<any> {
  // NOTE: `request` (from node:http) is already imported at the top of bin/icc.ts
  // — do not re-import. /api/health requires no auth (verified in src/server.ts),
  // so we send no Authorization header. If you extend hookGet to other endpoints
  // later, decide auth on a per-call basis.
  const { loadConfig, getTlsOptions, createIdentityVerifier } = await import('../src/config.ts');
  const config = loadConfig();
  const port = config.server.port;
  const tlsOpts = getTlsOptions(config);
  const requestFn = tlsOpts
    ? (await import('node:https')).request
    : request;

  return new Promise<any>((resolve) => {
    const req = requestFn({
      hostname: '127.0.0.1',
      port,
      path,
      method: 'GET',
      timeout: 1000,
      ...(tlsOpts ? { ...tlsOpts, checkServerIdentity: createIdentityVerifier(config.identity) } : {}),
    }, (res: any) => {
      if (res.statusCode && (res.statusCode < 200 || res.statusCode >= 300)) {
        res.resume();
        resolve(null);
        return;
      }
      let data = '';
      res.on('data', (chunk: string) => { data += chunk; });
      res.on('end', () => {
        try { resolve(JSON.parse(data)); } catch { resolve(null); }
      });
    });
    req.on('error', () => resolve(null));
    req.on('timeout', () => { req.destroy(); resolve(null); });
    req.end();
  });
}
```

- [ ] **Step 4: Modify the `startup` case to pre-check health**

In `bin/icc.ts`, locate the `case 'startup':` block at line 580. Replace the entire block (lines 580-617) with:

```ts
    case 'startup': {
      // Health pre-check: if the local server is down, emit an unreachable
      // hint and bail out before doing any other startup work. Registration
      // would fail anyway, and stale-PID cleanup can safely wait for the
      // next successful startup.
      const health = await hookGet('/api/health');
      if (health === null) {
        process.stdout.write('ICC: server not reachable. Run /mcp to reconnect, then /watch to activate.\n');
        break;
      }

      // Clean stale session files from dead PIDs
      const iccDir = join(homedir(), '.icc');
      try {
        for (const f of readdirSync(iccDir)) {
          // Clean stale .instance and .token files
          const isInstance = f.startsWith('session.') && f.endsWith('.instance');
          const isToken = f.startsWith('session.') && f.endsWith('.token');
          if (!isInstance && !isToken) continue;
          const suffix = isInstance ? '.instance' : '.token';
          const pid = parseInt(f.slice('session.'.length, -suffix.length), 10);
          if (isNaN(pid)) continue;
          try { process.kill(pid, 0); } catch {
            try { unlinkSync(join(iccDir, f)); } catch { /* ignore */ }
          }
        }
      } catch { /* non-fatal */ }
      // Clear stale snooze from crashed sessions. If the session instance file
      // already exists for our PID, this is a mid-session re-fire (/clear or
      // resume) — preserve the user's snooze preference.
      const isRefire = existsSync(sessionInstancePath(getClaudeCodePid()));
      if (!isRefire) {
        wakeWatcher(instanceName);
      }
      // Persist instance name for subsequent hooks (survives cwd changes)
      writeSessionInstance(instanceName);
      // Check signal files → stdout (fallback for when server is down)
      const signal = checkSignalFiles(instanceName);
      if (signal) process.stdout.write(signal + '\n');
      // Query server for connection status + unread count (non-fatal)
      const startupResult = await hookRequest('/api/hook/startup', { instance: instanceName });
      if (startupResult?.connected) {
        process.stdout.write(`ICC: connected, ${startupResult.unreadCount} unread. Run /watch to activate.\n`);
      } else {
        process.stdout.write('ICC: server not reachable. Run /mcp to reconnect, then /watch to activate.\n');
      }
      break;
    }
```

Two changes from the existing code:
- Added the health pre-check block at the top
- Updated the fallback "server not reachable" line to match the new wording (`Run /mcp to reconnect, then /watch to activate.`)

- [ ] **Step 5: Run the test to verify it passes**

```bash
node --test test/hooks.test.ts 2>&1 | grep -A2 'MCP health pre-check'
```

Expected: both tests PASS.

- [ ] **Step 6: Run the full hooks test file for regressions**

```bash
node --test test/hooks.test.ts 2>&1 | tail -15
```

Expected: no regressions. If existing tests assert the old "Run /watch to activate when ready." wording, update them to the new wording in the same commit.

- [ ] **Step 7: Commit**

```bash
git add bin/icc.ts test/hooks.test.ts
git commit -m "feat(hook): SessionStart health pre-check on bare-metal

icc hook startup now issues GET /api/health before any other work.
On failure (server down, timeout, non-2xx), emits an unreachable hint
naming both /mcp and /watch as recovery actions, then bails out
without attempting registration or stale-PID cleanup (which can wait
for the next successful startup).

Adds hookGet helper alongside hookRequest for non-mutating local
server calls with a 1-second timeout."
```

---

## Task 4: Docker — `SessionStart` hook template health pre-check

**Files:**
- Modify: `src/server.ts` (the `/setup/claude-code` response payload, `hooks.SessionStart[0|1|3].hooks[0].command` entries around lines 445-500)
- Test: `test/server.test.ts` (append)

- [ ] **Step 1: Locate the current template strings and record their exact shape**

Run:
```bash
grep -n 'api/hook/startup' /home/albertnam/code/inter-claude-connector/src/server.ts
```

Expected: at least 3 lines in the `hooks.SessionStart[*].command` template strings (plus possibly one reference in documentation or comments). Then read the surrounding context for each match (use `Read` with an `offset` and `limit` around each line number) and **copy the literal current `command:` string for each of the three matchers (`startup`, `resume`, `clear`) into a scratch note before proceeding.** Step 4 below shows an assumed "current shape" for the edit, but the actual on-disk string may differ (formatting, argument order, quoting, or recent edits). You MUST diff the assumed shape against the literal current strings before writing the edit — if they differ, transform the actual strings, not the template in this plan.

- [ ] **Step 2: Write the failing test**

Append to `test/server.test.ts`:

```ts
describe('/setup/claude-code hooks template: health pre-check', () => {
  it('SessionStart startup/resume/clear commands include /api/health guard', async () => {
    await withServer({}, async ({ port }) => {
      const res = await httpJSON(port, 'GET', '/setup/claude-code');
      const matchers = ['startup', 'resume', 'clear'];
      for (const matcher of matchers) {
        const entry = res.body.hooks.SessionStart.find((e: any) => e.matcher === matcher);
        assert.ok(entry, `SessionStart ${matcher} entry must exist`);
        const command: string = entry.hooks[0].command;
        assert.ok(
          command.includes('/api/health'),
          `${matcher} command must include /api/health pre-check; got: ${command}`
        );
        // Must match exact wording from bare-metal hook (Task 3). Keep in sync.
        assert.ok(
          command.includes('ICC: server not reachable. Run /mcp to reconnect, then /watch to activate.'),
          `${matcher} command must emit exact unreachable hint on health failure; got: ${command}`
        );
        assert.ok(
          command.includes('exit 0'),
          `${matcher} command must exit 0 on health failure (soft warning, not hook error)`
        );
        assert.ok(
          command.includes('/api/hook/startup'),
          `${matcher} command must still POST to /api/hook/startup on success`
        );
      }
    });
  });
});
```

- [ ] **Step 3: Run the test to verify it fails**

```bash
node --test test/server.test.ts 2>&1 | grep -A2 'hooks template: health'
```

Expected: FAIL — no `/api/health` substring in any SessionStart command.

- [ ] **Step 4: Update the three hook command template strings**

Open `src/server.ts`. For each of the three `SessionStart` matchers (`startup`, `resume`, `clear`), find the `command:` string and update it as follows.

**Assumed current shape** (verify against your Step 1 scratch note before applying — if the real strings differ, transform those instead):

```ts
command: `curl -sf -X POST ${localBaseUrl}/api/hook/startup${authHeader} -H 'Content-Type: application/json' -d '{"instance":"'"$(basename $PWD)"'"}'`,
```

**New shape — prepend a health pre-check guard:**

```ts
command: `curl -sf -m 1${authHeader} ${localBaseUrl}/api/health > /dev/null 2>&1 || { echo 'ICC: server not reachable. Run /mcp to reconnect, then /watch to activate.'; exit 0; }; curl -sf -X POST ${localBaseUrl}/api/hook/startup${authHeader} -H 'Content-Type: application/json' -d '{"instance":"'"$(basename $PWD)"'"}'`,
```

Make this change for all three matchers: `startup`, `resume`, and `clear`. Do not touch the `compact` matcher (that uses `/api/hook/heartbeat`, not startup, and is mid-session).

- [ ] **Step 5: Run the test to verify it passes**

```bash
node --test test/server.test.ts 2>&1 | grep -A2 'hooks template: health'
```

Expected: PASS.

- [ ] **Step 6: Run the full server test file for regressions**

```bash
node --test test/server.test.ts 2>&1 | tail -15
```

Expected: no regressions. If there's an existing test asserting the exact shape of the `SessionStart.startup` command (without the health guard), update it to match the new shape in this commit.

- [ ] **Step 7: Commit**

```bash
git add src/server.ts test/server.test.ts
git commit -m "feat(server): add health pre-check to Docker SessionStart hook templates

The /setup/claude-code SessionStart hooks for startup/resume/clear
matchers now wrap the existing curl POST with a curl -sf -m 1 guard
against /api/health. On health failure, the hook emits the same
'server not reachable' advisory the bare-metal hook emits and exits
0 (soft warning). On success, the guard passes through and the
original POST runs unchanged.

compact matcher (mid-session heartbeat) is unchanged. Completes
Component 3 parity — both bare-metal (icc hook startup) and Docker
(curl-based hook) now show the unreachable hint immediately at
SessionStart."
```

---

## Task 5: End-to-end verification

This task runs on live hosts to confirm the implementation works in practice. No code changes; purely manual verification with ICC collaboration.

- [ ] **Step 1: Full test suite passes locally**

```bash
cd ~/code/inter-claude-connector
node --test test/*.test.ts 2>&1 | tail -20
```

Expected: all tests pass (464+ with the new ones added).

- [ ] **Step 2: Restart um890 server and verify bare-metal health pre-check**

```bash
systemctl --user stop icc-server
# In another terminal or session: open a new Claude Code session
# Expected in the SessionStart output: "ICC: server not reachable. Run /mcp to reconnect, then /watch to activate."
systemctl --user start icc-server
# Open another session: expected "ICC: connected, N unread. Run /watch to activate."
```

- [ ] **Step 3: Collaborate with rpi1 for Docker verification**

Use ICC `send_message` to rpi1:

```
to: rpi1/inter-claude-connector
status: ACTION_NEEDED
body: [TOPIC: sub-project-c-verify] Resilience sub-project C just
merged to main. For Docker verification, please:

1. git pull (or wait for sub-project A to land and docker compose pull)
2. Re-fetch /setup/claude-code and re-apply the /watch skill + hook
   templates. **This manual reapply step exists only until sub-project B's
   /sync ships — do not bake it into muscle memory.** Until then:
   curl -H "Authorization: Bearer $(docker exec icc cat /home/icc/.icc/config.json | grep -oP '"localToken"\s*:\s*"\K[^"]+')" http://localhost:3178/setup/claude-code
3. Write the returned skills.watch.content to ~/.claude/skills/watch/SKILL.md
4. Update the SessionStart startup/resume/clear hooks in
   ~/.claude/settings.json with the new commands (including the
   /api/health guard)
5. Restart the Claude Code session (so new hooks load)
6. Run /watch to start a fresh watcher
7. In another terminal: docker compose restart icc
8. Observe: the watcher background task should complete with
   stale_token in its output. Claude Code should silently re-run the
   skill from step 3 and relaunch the watcher — no user action, no
   "Watcher already active" errors
9. Send yourself a test message: confirm delivery after auto-recovery
10. Open a new Claude Code session while icc container is stopped
    (docker compose stop icc): confirm the SessionStart output
    contains "ICC: server not reachable. Run /mcp to reconnect..."
    immediately, before any prompt

Report back with findings. You can delete feedback_docker_restart
from memory once (8) works reliably. Fix-everything-you-find applies.
```

- [ ] **Step 4: Wait for rpi1's reply and verify**

Read the reply via `check_messages`. Expected findings:
- Auto-recovery on `docker compose restart icc` works without intervention
- SessionStart unreachable hint appears immediately on new sessions when container is stopped
- Test message delivery works after auto-recovery
- `feedback_docker_restart` memory entry can be deleted

If rpi1 reports any failures, diagnose with their logs — do not dismiss as pre-existing (per CLAUDE.md).

- [ ] **Step 5: Update project memory**

After rpi1 confirms success, update memory:
- Remove the `feedback_docker_restart` entry from `~/.claude/projects/-home-albertnam-code-inter-claude-connector/memory/` (delete the file and remove any MEMORY.md reference)
- Add a note to `project_watcher_uncapped.md` (or a new `project_resilience.md`) noting that stale-token auto-recovery shipped 2026-04-07 and is Docker-only; bare-metal already handled it

---

## Self-review coverage matrix

| Spec section | Covered by |
|---|---|
| Component 1: server `/api/watch` 410 on unknown token | Task 1 |
| Component 2: Docker `/watch` skill stale_token branch | Task 2 |
| Component 3a: bare-metal `hook startup` health pre-check | Task 3 |
| Component 3b: Docker `SessionStart` hooks template health guard | Task 4 |
| `hookGet` helper added to `bin/icc.ts` | Task 3 Step 3 |
| `sessionReconnect` return-value check + ordering | Task 1 Step 3 |
| curl `-f` → `-s` on watch invocation | Task 2 Step 3 |
| Bare-metal unreachable wording matches spec | Task 3 Step 4 |
| Docker exit 0 on health failure (soft warning) | Task 4 Step 4 |
| Three matchers updated (startup/resume/clear), not compact | Task 4 Step 4 |
| Unit test: `/api/watch` 410 + no stranded tokens | Task 1 Step 1 |
| Unit test: Docker `/watch` skill contains stale_token + no `-f` | Task 2 Step 1 |
| Unit test: bare-metal startup health pre-check branches | Task 3 Step 1 |
| Unit test: Docker SessionStart hook template contains health guard | Task 4 Step 2 |
| E2E: rpi1 Docker restart auto-recovery | Task 5 Step 3 |
| E2E: SessionStart unreachable hint on both hosts | Task 5 Steps 2, 3 |
| Memory entry deletion for rpi1 | Task 5 Step 5 |

No placeholders. No gaps.

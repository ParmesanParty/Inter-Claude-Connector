# Docker Setup Flow Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Close all gaps between "ICC container running" and "Claude Code fully functional" — for both Docker and bare-metal deployments.

**Architecture:** Add a `GET /setup/claude-code` endpoint to the ICC server that returns structured JSON with MCP config, hooks, CLAUDE.md content, and skill definitions. Update the Docker wizard success screen to direct users toward this endpoint. Document skills as a first-class setup step in all deployment guides.

**Tech Stack:** TypeScript (Node.js), HTML (wizard UI), Markdown (docs)

---

### Task 1: Add `/setup/claude-code` endpoint + help entry

**Files:**
- Modify: `src/server.ts:229-338` (help endpoint), `src/server.ts:379` (before auth check)
- Test: `test/docker-endpoints.test.ts`

**Step 1: Write the failing tests**

Add a new `describe` block at the end of `test/docker-endpoints.test.ts`:

```typescript
describe('GET /setup/claude-code', () => {
  beforeEach(() => { isolateConfig(); reset(); });

  it('returns structured setup instructions without auth', async () => {
    await withServer({}, async (port) => {
      const res = await httpJSON(port, 'GET', '/setup/claude-code');
      assert.equal(res.status, 200);
      assert.ok(res.data.instructions);
      assert.ok(res.data.mcp);
      assert.ok(res.data.hooks);
      assert.ok(res.data.claudeMd);
      assert.ok(res.data.skills);
      assert.ok(res.data.postSetup);
    });
  });

  it('returns valid MCP config with URL transport', async () => {
    await withServer({}, async (port) => {
      const res = await httpJSON(port, 'GET', '/setup/claude-code');
      assert.equal(res.data.mcp.config.type, 'url');
      assert.ok(res.data.mcp.config.url.includes('/mcp'));
      assert.equal(res.data.mcp.mergeKey, 'mcpServers.icc');
    });
  });

  it('includes all three skills', async () => {
    await withServer({}, async (port) => {
      const res = await httpJSON(port, 'GET', '/setup/claude-code');
      const skills = res.data.skills;
      assert.ok(skills.watch);
      assert.ok(skills.snooze);
      assert.ok(skills.wake);
      // Skills should reference curl, not icc hook (Docker variants)
      assert.ok(skills.watch.content.includes('curl'));
      assert.ok(skills.snooze.content.includes('curl'));
      assert.ok(skills.wake.content.includes('curl'));
    });
  });

  it('hooks use dynamic instance names', async () => {
    await withServer({}, async (port) => {
      const res = await httpJSON(port, 'GET', '/setup/claude-code');
      const hooksStr = JSON.stringify(res.data.hooks.config);
      assert.ok(hooksStr.includes('$(basename $PWD)'));
      assert.ok(!hooksStr.includes('"PROJECT"'));
    });
  });

  it('is listed in /api/help', async () => {
    await withServer({}, async (port) => {
      const res = await httpJSON(port, 'GET', '/api/help');
      assert.ok(res.data.endpoints['GET /setup/claude-code']);
    });
  });
});
```

**Step 2: Run tests to verify they fail**

Run: `node --test test/docker-endpoints.test.ts`
Expected: 5 new tests FAIL (endpoint returns 401 or 404)

**Step 3: Add the endpoint to server.ts**

In `src/server.ts`, add the `/setup/claude-code` route **after** the TLS challenge endpoint (around line 379) and **before** the auth check (line 382). This places it in the no-auth zone alongside `/api/help` and `/api/health`.

```typescript
    // GET /setup/claude-code — bootstrapping endpoint for Claude Code self-configuration
    // No auth required — this is the first thing a new user hits before auth exists.
    // Contains no secrets (hooks use session-token flow, MCP URL needs no token).
    if (method === 'GET' && url === '/setup/claude-code') {
      const serverPort = port;
      sendJSON(res, 200, {
        instructions: 'Apply these configurations to integrate Claude Code with this ICC server. For each config file: create parent directories if needed, merge into existing content (do not overwrite unrelated keys). Write each skill file to the specified target path (create directories as needed). After writing all files, tell the user to restart Claude Code for MCP changes to take effect.',
        mcp: {
          target: '~/.claude.json',
          mergeKey: 'mcpServers.icc',
          config: { type: 'url', url: `http://localhost:${serverPort}/mcp` },
        },
        hooks: {
          target: '~/.claude/settings.json',
          mergeKey: 'hooks',
          config: {
            SessionStart: [
              {
                matcher: 'startup',
                hooks: [{
                  type: 'command',
                  command: `curl -sf -X POST http://localhost:${serverPort}/api/hook/startup -H 'Content-Type: application/json' -d '{"instance":"'"$(basename $PWD)"'"}'`,
                }],
              },
              {
                matcher: 'resume',
                hooks: [{
                  type: 'command',
                  command: `curl -sf -X POST http://localhost:${serverPort}/api/hook/startup -H 'Content-Type: application/json' -d '{"instance":"'"$(basename $PWD)"'"}'`,
                }],
              },
              {
                matcher: 'compact',
                hooks: [{
                  type: 'command',
                  command: `ST=$(cat /tmp/icc-session-$PPID.token 2>/dev/null); [ -n "$ST" ] && curl -sf -X POST http://localhost:${serverPort}/api/hook/heartbeat -H 'Content-Type: application/json' -d "{\\"sessionToken\\":\\"$ST\\"}" || true`,
                }],
              },
              {
                matcher: 'clear',
                hooks: [{
                  type: 'command',
                  command: `curl -sf -X POST http://localhost:${serverPort}/api/hook/startup -H 'Content-Type: application/json' -d '{"instance":"'"$(basename $PWD)"'"}'`,
                }],
              },
            ],
            UserPromptSubmit: [
              {
                hooks: [{
                  type: 'command',
                  command: `ST=$(cat /tmp/icc-session-$PPID.token 2>/dev/null); [ -n "$ST" ] && curl -sf -X POST http://localhost:${serverPort}/api/hook/heartbeat -H 'Content-Type: application/json' -d "{\\"sessionToken\\":\\"$ST\\"}" || true`,
                }],
              },
            ],
            PreToolUse: [
              {
                matcher: 'Bash',
                hooks: [{
                  type: 'command',
                  command: `cat | curl -sf -X POST http://localhost:${serverPort}/api/hook/pre-bash -H 'Content-Type: application/json' -d @-`,
                }],
              },
              {
                matcher: 'mcp__icc__send_message|mcp__icc__respond_to_message',
                hooks: [{
                  type: 'command',
                  command: `cat | curl -sf -X POST http://localhost:${serverPort}/api/hook/pre-icc-message -H 'Content-Type: application/json' -d @-`,
                }],
              },
            ],
            SessionEnd: [
              {
                hooks: [{
                  type: 'command',
                  command: `ST=$(cat /tmp/icc-session-$PPID.token 2>/dev/null); [ -n "$ST" ] && curl -sf -X POST http://localhost:${serverPort}/api/hook/session-end -H 'Content-Type: application/json' -d "{\\"sessionToken\\":\\"$ST\\"}" || true; rm -f /tmp/icc-session-$PPID.token`,
                }],
              },
            ],
          },
        },
        claudeMd: {
          target: '~/.claude/CLAUDE.md',
          append: true,
          content: `# ICC Inbox

When a hook surfaces an unread message notification (e.g. "You have N unread messages"), you **must**:
1. Call \`check_messages\` (MCP tool) to read them
2. Briefly acknowledge the messages to the user
3. Use \`respond_to_message\` if a reply is warranted
4. Follow message conventions: prefix with \`[TOPIC: x]\`, and set the \`status\`
   parameter on \`send_message\`/\`respond_to_message\` (preferred) or suffix with
   \`[STATUS: WAITING_FOR_REPLY|FYI_ONLY|ACTION_NEEDED|RESOLVED]\` in body text

# ICC Activation & Mail Watcher

On session start, the startup hook outputs status: "ICC: connected, N unread.
Run /watch to activate." Do NOT auto-launch the watcher on startup. The user
or model invokes \`/watch\` to activate.

**Subagents (spawned via the Agent tool) must NOT launch or manage mail
watchers.** Only the root conversation handles the watcher lifecycle.

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
unless wall-clock timing confirms sub-second completion.`,
        },
        skills: {
          watch: {
            target: '~/.claude/skills/watch/SKILL.md',
            content: `---
name: watch
description: Activate ICC — register instance with server and launch mail watcher
disable-model-invocation: true
user-invocable: true
args: [--force] [--name <alt-name>]
---

# ICC Activation (Docker)

Register this instance with the ICC server and launch the mail watcher.
This is the activation point for a session — startup only checks status,
\`/watch\` activates.

## Steps

1. **Check if a watcher is already running.** Use \`TaskOutput\` with
   \`block: false\` on any known watcher task ID, or list background
   tasks with \`/tasks\`. If a watcher task exists and is still running,
   tell the user it's already active and do nothing else.

2. **Register with the server.** Run this using the Bash tool:
   \`\`\`bash
   curl -sf -X POST http://localhost:${serverPort}/api/hook/watch \\
     -H 'Content-Type: application/json' \\
     -d '{"instance":"'"$(basename $PWD)"'","pid":0}'
   \`\`\`
   Add \`,"force":true\` to the JSON if user passed \`--force\`.
   Add \`,"name":"<alt>"\` if user passed \`--name\`.

3. **Parse the response and handle:**
   - If \`status\` is \`"deferred"\`: show the conflict to the user with options:
     - \`/watch --force\` — evict the other session and take over
     - \`/watch --name <alt>\` — register under a different name
     - Cancel
   - If \`status\` is \`"active"\`: save the session token:
     \`\`\`bash
     echo "SESSION_TOKEN_VALUE" > /tmp/icc-session-$PPID.token
     \`\`\`
     (Replace SESSION_TOKEN_VALUE with the \`sessionToken\` from the response.)

4. **Launch the watcher.** Use the Bash tool with \`run_in_background: true\`
   and \`timeout: 600000\`:
   \`\`\`bash
   RESULT=$(curl --max-time 591 -sf "http://localhost:${serverPort}/api/watch?instance=$(basename $PWD)&sessionToken=TOKEN"); echo "$RESULT"
   \`\`\`
   (Replace TOKEN with the actual session token.)

5. **Confirm activation:** "ICC activated. Watching for messages."

6. When the background task completes later, read its output and handle:
   - If output contains \`"mail"\`: call \`check_messages\` MCP tool, then
     relaunch from step 4
   - If output contains \`"timeout"\`: relaunch from step 4`,
          },
          snooze: {
            target: '~/.claude/skills/snooze/SKILL.md',
            content: `---
name: snooze
description: Suppress automatic ICC mail watcher launches for this session
disable-model-invocation: true
user-invocable: true
---

# ICC Watcher Snooze (Docker)

Suppress automatic watcher launches and deregister from the server.

## Steps

1. Read the session token:
   \`\`\`bash
   cat /tmp/icc-session-$PPID.token
   \`\`\`

2. Deregister with the server:
   \`\`\`bash
   curl -sf -X POST http://localhost:${serverPort}/api/hook/snooze \\
     -H 'Content-Type: application/json' \\
     -d '{"sessionToken":"TOKEN"}'
   \`\`\`
   (Replace TOKEN with the value from step 1.)

3. Remove the token file:
   \`\`\`bash
   rm -f /tmp/icc-session-$PPID.token
   \`\`\`

4. Confirm: "ICC watcher snoozed. Use \`/wake\` to re-enable."`,
          },
          wake: {
            target: '~/.claude/skills/wake/SKILL.md',
            content: `---
name: wake
description: Re-enable ICC mail watcher after snoozing
disable-model-invocation: true
user-invocable: true
---

# ICC Watcher Wake (Docker)

Re-register with the server and launch the watcher.

## Steps

1. **Re-register with the server:**
   \`\`\`bash
   curl -sf -X POST http://localhost:${serverPort}/api/hook/watch \\
     -H 'Content-Type: application/json' \\
     -d '{"instance":"'"$(basename $PWD)"'","pid":0,"force":true}'
   \`\`\`

2. **Save the new session token** from the response:
   \`\`\`bash
   echo "SESSION_TOKEN_VALUE" > /tmp/icc-session-$PPID.token
   \`\`\`

3. **Launch the watcher.** Use the Bash tool with \`run_in_background: true\`
   and \`timeout: 600000\`:
   \`\`\`bash
   RESULT=$(curl --max-time 591 -sf "http://localhost:${serverPort}/api/watch?instance=$(basename $PWD)&sessionToken=TOKEN"); echo "$RESULT"
   \`\`\`

4. Confirm: "ICC watcher re-activated."`,
          },
        },
        postSetup: 'Restart Claude Code for MCP changes to take effect. After restart, the SessionStart hook will confirm ICC connectivity. Run /watch to activate the mail watcher.',
      });
      return;
    }
```

Also add the endpoint to the help listing. In the `endpoints` object inside `GET /api/help` (around line 310, after the `POST /api/inbox/delete` entry), add:

```typescript
          'GET /setup/claude-code': {
            auth: false,
            description: 'Returns structured JSON with everything Claude Code needs to self-configure: MCP config, hooks, CLAUDE.md content, and skill definitions. Designed for bootstrapping — Claude Code fetches this endpoint and applies the configs.',
            response: '{ instructions, mcp: { target, mergeKey, config }, hooks: { target, mergeKey, config }, claudeMd: { target, append, content }, skills: { watch, snooze, wake }, postSetup }',
          },
```

**Step 4: Run tests to verify they pass**

Run: `node --test test/docker-endpoints.test.ts`
Expected: All tests pass, including the 5 new ones

**Step 5: Commit**

```bash
git add src/server.ts test/docker-endpoints.test.ts
git commit -m "feat: add GET /setup/claude-code endpoint for self-configuration

Serves MCP config, hooks (with dynamic instance names), CLAUDE.md content,
and Docker-specific skill definitions (/watch, /snooze, /wake) as structured
JSON. No auth required — bootstrapping endpoint for new deployments."
```

---

### Task 2: Update wizard success screen

**Files:**
- Modify: `docker/wizard.ts:388-406` (success screen HTML)

**Step 1: Replace the success screen HTML**

In `docker/wizard.ts`, replace the `success-screen` div (the section starting at the `<div id="success-screen"` line) with:

```html
  <div id="success-screen" class="card hidden" style="max-width: 600px; margin: 0 auto;">
    <h2>Setup Complete!</h2>
    <p class="success">ICC is configured and starting up.</p>
    <div class="result-box">
      <label>Identity</label>
      <div id="result-identity"></div>
      <label style="margin-top: 0.75rem">Local Token</label>
      <div id="result-token"></div>
      <div id="result-peers-section" class="hidden">
        <label style="margin-top: 0.75rem">Peers</label>
        <div id="result-peers"></div>
      </div>
    </div>
    <p style="margin-top: 1rem; color: #71767b; font-size: 0.85rem;">
      Save the local token &mdash; you'll need it for web UI login and direct API access.
    </p>
    <div style="margin-top: 1.25rem; padding: 1rem 1.25rem; background: #1a2634; border: 1px solid #1d9bf0; border-radius: 8px;">
      <p style="color: #1d9bf0; font-size: 0.95rem; font-weight: 600; margin-bottom: 0.5rem;">Next: Connect Claude Code</p>
      <p style="color: #8b98a5; font-size: 0.85rem; line-height: 1.5; margin-bottom: 0.75rem;">
        Open any Claude Code session and paste this prompt:
      </p>
      <div style="background: #0f1419; border: 1px solid #2f3336; border-radius: 6px; padding: 0.75rem 1rem; font-family: monospace; font-size: 0.85rem; color: #e7e9ea; cursor: pointer; position: relative;" onclick="navigator.clipboard.writeText(this.innerText.replace('Copied!','').trim())" title="Click to copy">
        Set up ICC integration by fetching and applying the configuration from http://localhost:3179/setup/claude-code
      </div>
      <p style="color: #71767b; font-size: 0.8rem; margin-top: 0.5rem;">
        This configures MCP, hooks, skills, and CLAUDE.md automatically.
        Claude Code will ask you to restart afterward.
      </p>
    </div>
    <details style="margin-top: 1rem;">
      <summary style="color: #71767b; font-size: 0.85rem; cursor: pointer;">Manual setup (advanced)</summary>
      <div style="margin-top: 0.75rem;">
        <p style="color: #8b98a5; font-size: 0.85rem; margin-bottom: 0.5rem;">
          If you prefer to configure manually, fetch the setup JSON:
        </p>
        <div style="background: #0f1419; border: 1px solid #2f3336; border-radius: 6px; padding: 0.75rem 1rem; font-family: monospace; font-size: 0.85rem; color: #e7e9ea;">
          curl http://localhost:3179/setup/claude-code
        </div>
        <p style="color: #8b98a5; font-size: 0.85rem; margin-top: 0.5rem;">
          Then apply each section to the target file listed in the response.
          See <a href="https://github.com/ParmesanParty/Inter-Claude-Connector/blob/main/docs/docker.md#claude-code-setup-docker"
          style="color: #1d9bf0; text-decoration: none;">the full docs</a> for details.
        </p>
      </div>
    </details>
  </div>
```

**Step 2: Verify no syntax errors**

Run: `node -e "import('./docker/wizard.ts')"`
Expected: No errors (module loads cleanly)

**Step 3: Commit**

```bash
git add docker/wizard.ts
git commit -m "feat: wizard success screen directs users to Claude Code self-setup

Primary CTA: paste a prompt into Claude Code pointing at /setup/claude-code.
Manual setup collapsed as fallback. Token display kept for web UI/API access."
```

---

### Task 3: Add skills section to bare-metal setup doc

**Files:**
- Modify: `docs/claude-code-setup.md` (add Section 4 after Section 3)

**Step 1: Add Section 4: Skills**

After the `## 3. CLAUDE.md` section (which ends with the closing triple-backtick of the markdown code block, around line 231), add:

````markdown
## 4. Skills (`~/.claude/skills/`)

Skills give Claude Code the `/watch`, `/snooze`, and `/wake` slash commands
for managing the ICC mail watcher. Create the directory structure and write
each file.

### `/watch` — activate the mail watcher

Write to `~/.claude/skills/watch/SKILL.md`:

```markdown
---
name: watch
description: Activate ICC — register instance with server and launch mail watcher
disable-model-invocation: true
user-invocable: true
args: [--force] [--name <alt-name>]
---

# ICC Activation

Register this instance with the ICC server and launch the mail watcher. This is the activation point for a session — startup only checks status, `/watch` activates.

## Steps

1. **Check if a watcher is already running.** Use `TaskOutput` with `block: false` on any known watcher task ID, or list background tasks with `/tasks`. If a watcher task exists and is still running, tell the user it's already active and do nothing else.

2. **If no watcher is running**, launch one:
   - Use the `Bash` tool with `run_in_background: true`
   - Command: `icc hook watch` (add `--force` if user passed `--force`, add `--name <name>` if user passed `--name`)
   - Timeout: `600000`

3. **Check the immediate output.** The watch hook registers with the server before starting:
   - If output contains `[ICC] Registration deferred:` — show the conflict to the user with options:
     - `/watch --force` — evict the other session and take over
     - `/watch --name <alt>` — register under a different name
     - Cancel — don't activate
   - If output contains `[ICC] Watcher already active` — tell the user it's already running
   - Otherwise — confirm activation: "ICC activated as <instance>. Watching for messages."

4. When the background task completes later, read its output and handle:
   - If output contains `[ICC] Mail received`: call `check_messages` MCP tool, then relaunch
   - If output contains `[ICC] Watcher cycled`: just relaunch
```

### `/snooze` — suppress watcher auto-launches

Write to `~/.claude/skills/snooze/SKILL.md`:

```markdown
---
name: snooze
description: Suppress automatic ICC mail watcher launches for this session. Use when watcher restarts are unwanted.
disable-model-invocation: true
user-invocable: true
---

# ICC Watcher Snooze

Suppress automatic watcher launches and deregister from the server for the current session.

## Steps

1. Run `icc hook snooze-watcher` using the `Bash` tool. This deregisters the session token with the server and sets the local snooze flag.
2. Confirm to the user that watcher auto-launch is snoozed and the instance is deregistered.
3. Tell them they can use `/wake` to re-enable it.
```

### `/wake` — re-enable after snooze

Write to `~/.claude/skills/wake/SKILL.md`:

```markdown
---
name: wake
description: Re-enable automatic ICC mail watcher launches after snoozing. Use when ready to resume watcher.
disable-model-invocation: true
user-invocable: true
---

# ICC Watcher Wake

Remove the snooze flag, re-register with the server, and immediately launch the watcher.

## Steps

1. Run `icc hook wake-watcher` using the `Bash` tool. This removes the snooze flag, re-registers with the server, and writes a new session token.
2. Launch the watcher: use the `Bash` tool with `run_in_background: true`, command `icc hook watch`, timeout `600000`.
3. Confirm to the user that the watcher is back online.
```
````

**Step 2: Update the Verification section**

In the existing Verification section (around line 234), add a 4th verification item:

```markdown
4. **Skills:** Run `/watch` inside a Claude Code session. It should register
   with the server and start the mail watcher.
```

**Step 3: Commit**

```bash
git add docs/claude-code-setup.md
git commit -m "docs: add skills as Section 4 in bare-metal Claude Code setup

Documents /watch, /snooze, /wake skill files with full content.
Skills are now a first-class setup step alongside MCP, hooks, and CLAUDE.md."
```

---

### Task 4: Update docker.md — restructure Claude Code Setup section

**Files:**
- Modify: `docs/docker.md:32-131`

**Step 1: Restructure the Claude Code Setup section**

Replace the entire "## Claude Code Setup (Docker)" section (lines 33-131) with:

````markdown
## Claude Code Setup (Docker)

> **When to do this:** After the ICC container is running and initialized
> (via the setup wizard or a pre-existing config volume). This configures
> Claude Code on the **host machine** to talk to the containerized ICC server.

### Recommended: Automatic Setup

The ICC server provides a self-configuration endpoint. Open any Claude Code
session and paste this prompt:

> Set up ICC integration by fetching and applying the configuration from http://localhost:3179/setup/claude-code

Claude Code will fetch the endpoint, which returns structured JSON with MCP
config, hooks, CLAUDE.md content, and skill definitions (`/watch`, `/snooze`,
`/wake`). It will write each config to the appropriate file and prompt you to
restart.

After restarting, the SessionStart hook will confirm connectivity:
`ICC: connected, N unread. Run /watch to activate.`

### Manual Setup (Reference)

If you prefer to configure manually, the sections below show the raw configs.
You can also fetch them as JSON: `curl http://localhost:3179/setup/claude-code`

#### MCP Configuration

Add to `~/.claude.json`:

```json
{
  "mcpServers": {
    "icc": {
      "type": "url",
      "url": "http://localhost:3179/mcp"
    }
  }
}
```

#### Hook Configuration

Add to `~/.claude/settings.json` under `"hooks"`:

```json
{
  "hooks": {
    "SessionStart": [
      {
        "matcher": "startup",
        "hooks": [{
          "type": "command",
          "command": "curl -sf -X POST http://localhost:3179/api/hook/startup -H 'Content-Type: application/json' -d '{\"instance\":\"'\"$(basename $PWD)\"'\"}'"
        }]
      },
      {
        "matcher": "resume",
        "hooks": [{
          "type": "command",
          "command": "curl -sf -X POST http://localhost:3179/api/hook/startup -H 'Content-Type: application/json' -d '{\"instance\":\"'\"$(basename $PWD)\"'\"}'"
        }]
      },
      {
        "matcher": "compact",
        "hooks": [{
          "type": "command",
          "command": "ST=$(cat /tmp/icc-session-$PPID.token 2>/dev/null); [ -n \"$ST\" ] && curl -sf -X POST http://localhost:3179/api/hook/heartbeat -H 'Content-Type: application/json' -d \"{\\\"sessionToken\\\":\\\"$ST\\\"}\" || true"
        }]
      },
      {
        "matcher": "clear",
        "hooks": [{
          "type": "command",
          "command": "curl -sf -X POST http://localhost:3179/api/hook/startup -H 'Content-Type: application/json' -d '{\"instance\":\"'\"$(basename $PWD)\"'\"}'"
        }]
      }
    ],
    "UserPromptSubmit": [
      {
        "hooks": [{
          "type": "command",
          "command": "ST=$(cat /tmp/icc-session-$PPID.token 2>/dev/null); [ -n \"$ST\" ] && curl -sf -X POST http://localhost:3179/api/hook/heartbeat -H 'Content-Type: application/json' -d \"{\\\"sessionToken\\\":\\\"$ST\\\"}\" || true"
        }]
      }
    ],
    "PreToolUse": [
      {
        "matcher": "Bash",
        "hooks": [{
          "type": "command",
          "command": "cat | curl -sf -X POST http://localhost:3179/api/hook/pre-bash -H 'Content-Type: application/json' -d @-"
        }]
      },
      {
        "matcher": "mcp__icc__send_message|mcp__icc__respond_to_message",
        "hooks": [{
          "type": "command",
          "command": "cat | curl -sf -X POST http://localhost:3179/api/hook/pre-icc-message -H 'Content-Type: application/json' -d @-"
        }]
      }
    ],
    "SessionEnd": [
      {
        "hooks": [{
          "type": "command",
          "command": "ST=$(cat /tmp/icc-session-$PPID.token 2>/dev/null); [ -n \"$ST\" ] && curl -sf -X POST http://localhost:3179/api/hook/session-end -H 'Content-Type: application/json' -d \"{\\\"sessionToken\\\":\\\"$ST\\\"}\" || true; rm -f /tmp/icc-session-$PPID.token"
        }]
      }
    ]
  }
}
```

Instance names are resolved dynamically via `$(basename $PWD)` — no manual
replacement needed.

#### Skills

Write the following skill files to enable `/watch`, `/snooze`, and `/wake`
commands. The `/setup/claude-code` endpoint serves the full content of each
skill — fetch it with `curl http://localhost:3179/setup/claude-code` and
extract the `skills` section, or let Claude Code do it automatically via the
recommended setup above.

Skill targets:
- `~/.claude/skills/watch/SKILL.md`
- `~/.claude/skills/snooze/SKILL.md`
- `~/.claude/skills/wake/SKILL.md`

#### CLAUDE.md

Append ICC inbox and watcher instructions to `~/.claude/CLAUDE.md`. The full
content is available in the `/setup/claude-code` endpoint response under the
`claudeMd` key, or in [`docs/claude-code-setup.md` § 3](claude-code-setup.md#3-claudemd-claudeclaudemd).
````

**Step 2: Commit**

```bash
git add docs/docker.md
git commit -m "docs: restructure Docker Claude Code setup to lead with endpoint

Primary path: paste prompt into Claude Code pointing at /setup/claude-code.
Manual config kept as reference. Hooks now use dynamic instance names.
Skills section added."
```

---

### Task 5: Update new-host-deployment.md

**Files:**
- Modify: `docs/new-host-deployment.md:358-374` (Configure Claude Code section), `docs/new-host-deployment.md:405-416` (Quick Reference table)

**Step 1: Update Configure Claude Code section**

Replace the existing "## Configure Claude Code" section (lines 358-374) with:

```markdown
## Configure Claude Code

Four things need to be set up: MCP server config (`~/.claude.json`),
lifecycle hooks (`~/.claude/settings.json`), watcher instructions
(`~/.claude/CLAUDE.md`), and skills (`~/.claude/skills/`).

The easiest way is to let Claude Code configure itself. Open a Claude
Code session in `~/code/inter-claude-connector` and prompt:

> Read docs/claude-code-setup.md and configure ICC integration on this
> host.

Claude Code will read the reference file, resolve local paths (node
binary, home directory), and write all config files and skill
definitions.

See [`docs/claude-code-setup.md`](claude-code-setup.md) for the full
configuration reference if you prefer to set up manually.
```

**Step 2: Add skills row to Quick Reference table**

In the Quick Reference table (around line 415), add a row after the
"Watcher instructions" row:

```markdown
| Skills | `~/.claude/skills/{watch,snooze,wake}/SKILL.md` | `/watch`, `/snooze`, `/wake` commands |
```

**Step 3: Commit**

```bash
git add docs/new-host-deployment.md
git commit -m "docs: add skills to new-host-deployment setup and quick reference"
```

---

### Task 6: Run full test suite

**Step 1: Run all tests**

Run: `node --test test/*.test.ts`
Expected: All tests pass (existing + 5 new from Task 1)

**Step 2: Manually verify the endpoint**

If an ICC server is running locally:

```bash
curl -sf http://localhost:3179/setup/claude-code | node -e "
  const data = JSON.parse(require('fs').readFileSync('/dev/stdin','utf8'));
  console.log('Sections:', Object.keys(data).join(', '));
  console.log('Skills:', Object.keys(data.skills).join(', '));
  console.log('MCP type:', data.mcp.config.type);
  console.log('Has dynamic instance:', JSON.stringify(data.hooks.config).includes('basename'));
"
```

Expected output:
```
Sections: instructions, mcp, hooks, claudeMd, skills, postSetup
Skills: watch, snooze, wake
MCP type: url
Has dynamic instance: true
```

**Step 3: Final commit (if any fixups needed)**

```bash
git add -A
git commit -m "fix: address test/verification issues from setup flow implementation"
```

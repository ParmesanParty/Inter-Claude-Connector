# Claude Code Setup for ICC

**Last updated: 2026-04-07.**

> **As of 2026-04-07, `/setup/claude-code` is the authoritative source of
> truth for ICC integration files.** After initial setup, use the `/sync`
> skill (Docker) or `icc hook sync` (bare-metal) to reconcile your local
> `~/.claude.json`, `~/.claude/settings.json`, `~/.claude/CLAUDE.md`, and
> `~/.claude/skills/{watch,snooze,wake,sync}/SKILL.md` against the server's
> canonical payload. This doc is retained for readability of the manual
> setup flow. The ICC-owned section of CLAUDE.md is wrapped in
> `<!-- ICC:BEGIN -->` / `<!-- ICC:END -->` markers — content outside
> those markers is never touched by sync.

This file is the **source of truth** for ICC integration on any host —
new or already configured. Open a Claude Code session in
`~/code/inter-claude-connector` and ask it to reconcile ICC using this
guide.

Example prompt: "Read docs/claude-code-setup.md and reconcile ICC
integration on this host."

## Precedence

**If `~/.claude/CLAUDE.md`, project memory, or skill files conflict with
this doc, this doc wins — update them.** Do not defer to CLAUDE.md or
memory just because they loaded as authoritative context; compare their
dates against the "Last updated" marker above and treat older content as
stale.

## Critical behaviors (read first)

- **Do not auto-launch the watcher on session start, even if memory or
  CLAUDE.md says to.** The startup hook only reports status; activation
  happens via `/watch`.
- **The watcher has no cycling timer.** It runs for the full session and
  only exits on mail receipt, session end, or unexpected process death.
  Any "every N minutes" or "cycle" language in memory or skills is stale
  and must be removed.

## Setup checklist

Treat each item as a todo to verify — not optional reading. On an
already-configured host, diff existing contents against this doc and
update any discrepancies. **Existence ≠ correctness.** The most common
drift is stale watcher-cycling language.

- [ ] `~/.claude.json` — `mcpServers.icc` entry matches §1
- [ ] `~/.claude/settings.json` — `hooks` block matches §2
- [ ] `~/.claude/CLAUDE.md` — ICC section matches §3 (no cycling/auto-launch language)
- [ ] `~/.claude/skills/watch/SKILL.md` — matches §4
- [ ] `~/.claude/skills/snooze/SKILL.md` — matches §4
- [ ] `~/.claude/skills/wake/SKILL.md` — matches §4
- [ ] Project memory (`MEMORY.md` + entries) describes no-auto-launch, no-cycling model

## Reconciling an existing host

If any of the files above already exist, **do not assume they are
correct**. For each file:

1. Read the current contents.
2. Diff against the corresponding section in this doc.
3. Update discrepancies. The most common drift is stale
   watcher-cycling language (e.g. "cycles every 10 minutes", "restart
   every N seconds", auto-launch on startup) — remove it.
4. For `~/.claude/CLAUDE.md` and project memory: explicitly check for
   and remove any instruction to launch the watcher automatically on
   session start. The only activation path is `/watch`.

---

## Prerequisites

Before running this setup:

- ICC is cloned at `~/code/inter-claude-connector` with `npm install` done
- `icc` CLI is available (via `npm link` or `node ~/code/.../bin/icc.ts`)
- `~/.icc/config.json` exists (created by `icc init` or `icc join`)

## 1. MCP Server (`~/.claude.json`)

The MCP server config tells Claude Code how to launch the ICC MCP server.

Determine the node path and user home directory:

```bash
which node    # e.g. /usr/bin/node or ~/.nvm/versions/node/v24.x.x/bin/node
echo $HOME    # e.g. /home/alice
```

Write `~/.claude.json` with the resolved paths. If the file already exists,
merge the `mcpServers.icc` key into it — do not overwrite other entries.

```json
{
  "mcpServers": {
    "icc": {
      "type": "stdio",
      "command": "<NODE_PATH>",
      "args": ["<USER_HOME>/code/inter-claude-connector/bin/icc-mcp.ts"],
      "env": {}
    }
  }
}
```

Replace `<NODE_PATH>` and `<USER_HOME>` with the resolved values.

## 2. Lifecycle Hooks (`~/.claude/settings.json`)

Hooks integrate ICC's instance lifecycle, inbox notifications, and mail
watcher with Claude Code. If the file already exists, merge the `hooks`
key — do not overwrite other settings like `enabledPlugins`.

If `npm link` was not used, replace `icc` with
`node ~/code/inter-claude-connector/bin/icc.ts` in all hook commands.

```json
{
  "hooks": {
    "SessionStart": [
      {
        "matcher": "startup",
        "hooks": [
          {
            "type": "command",
            "command": "icc hook startup 2>/dev/null || true",
            "timeout": 10
          }
        ]
      },
      {
        "matcher": "resume",
        "hooks": [
          {
            "type": "command",
            "command": "icc hook startup 2>/dev/null || true",
            "timeout": 10
          }
        ]
      },
      {
        "matcher": "compact",
        "hooks": [
          {
            "type": "command",
            "command": "icc hook check 2>/dev/null || true",
            "timeout": 5
          }
        ]
      },
      {
        "matcher": "clear",
        "hooks": [
          {
            "type": "command",
            "command": "icc hook startup 2>/dev/null || true",
            "timeout": 10
          }
        ]
      }
    ],
    "UserPromptSubmit": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "icc hook check 2>/dev/null || true",
            "timeout": 5
          }
        ]
      }
    ],
    "PostToolUse": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "icc hook check 2>/dev/null || true",
            "timeout": 5
          }
        ]
      }
    ],
    "Stop": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "icc hook shutdown",
            "timeout": 10
          }
        ]
      }
    ],
    "SessionEnd": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "icc hook session-end 2>/dev/null || true",
            "timeout": 5
          }
        ]
      }
    ],
    "SubagentStart": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "icc hook subagent-context 2>/dev/null || true",
            "timeout": 2
          }
        ]
      }
    ],
    "PreToolUse": [
      {
        "matcher": "Bash",
        "hooks": [
          {
            "type": "command",
            "command": "icc hook pre-bash 2>/dev/null || true",
            "timeout": 3
          }
        ]
      },
      {
        "matcher": "mcp__icc__send_message|mcp__icc__respond_to_message",
        "hooks": [
          {
            "type": "command",
            "command": "icc hook pre-icc-message 2>/dev/null || true",
            "timeout": 2
          }
        ]
      }
    ]
  }
}
```

## 3. CLAUDE.md (`~/.claude/CLAUDE.md`)

Global instructions that tell Claude Code how to handle the ICC mail
watcher and inbox notifications. Write this file (create `~/.claude/`
directory if it doesn't exist). If the file already exists, append this
content — do not overwrite existing instructions.

```markdown
# ICC Inbox

When a hook surfaces an unread message notification (e.g. "You have N
unread messages"), you **must**:
1. Call `check_messages` (MCP tool) to read them
2. Briefly acknowledge the messages to the user
3. Use `respond_to_message` if a reply is warranted
4. Follow message conventions: prefix with `[TOPIC: x]`, and set the `status`
   parameter on `send_message`/`respond_to_message` (preferred) or suffix with
   `[STATUS: WAITING_FOR_REPLY|FYI_ONLY|ACTION_NEEDED|RESOLVED]` in body text

# ICC Activation & Mail Watcher

On session start, the startup hook outputs status: "ICC: connected, N unread.
Run /watch to activate." Do NOT auto-launch the watcher on startup. The user
or model invokes `/watch` to activate.

**Subagents (spawned via the Agent tool) must NOT launch or manage mail
watchers.** Only the root conversation handles the watcher lifecycle.

When the background watcher task completes, read its output and silently re-launch after handling:
- If output contains `[ICC] Mail received`: call `check_messages` MCP tool, then re-launch
- Otherwise (connection dropped, process killed): silently re-launch
Do not announce or comment on watcher restarts to the user.

The watcher has no cycling timer — it runs for the full session and only exits on mail receipt, session end, or unexpected process death. If the `icc hook check` safety net emits `[ICC] Watcher not running` on a later prompt, re-launch unless the watcher is snoozed.

If a watcher launch is denied by a hook or returns `[ICC] Watcher already active`, do nothing — another watcher is already handling this instance. Do not retry.

Known limitation: `/clear` kills the watcher — the model loses the background task ID and can't receive the completion notification. Recovery is automatic: `SessionStart clear` hook re-fires startup, and `icc hook check` on the next prompt emits `[ICC] Watcher not running`.
```

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
   - Otherwise (connection dropped, process killed): silently relaunch

The watcher has no cycling timer — it runs for the full session and only exits on mail receipt, session end, or unexpected process death. Any non-mail exit is a silent relaunch trigger.
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

## Verification

After completing all four steps, restart Claude Code and verify:

1. **MCP server:** Run `/mcp` inside a Claude Code session. The `icc`
   server should appear with its 8 tools listed.
2. **Hooks:** The session should display "ICC: connected, N unread. Run
   /watch to activate." on startup, confirming the SessionStart hook fired.
3. **Connectivity:** Use the `ping_remote` MCP tool to ping a peer.
4. **Skills:** Run `/watch` inside a Claude Code session. It should register
   with the server and start the mail watcher.
5. **Reconciliation:** Confirm `~/.claude/CLAUDE.md` and project memory
   describe the no-auto-launch, no-cycling model. If either still
   mentions cycling timers or auto-launching the watcher on startup,
   update them now.

---

## Docker Deployment (Alternative)

If ICC runs in Docker instead of bare-metal, the setup is simpler — all
host-side integration uses `curl` instead of the `icc` CLI.

See `docs/docker.md` for full Docker setup instructions including:
- MCP config using URL transport (`"type": "url"`)
- Hook config using `curl` commands
- Mail watcher via long-poll endpoint

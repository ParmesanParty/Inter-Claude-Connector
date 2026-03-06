# Claude Code Setup for ICC

This file is a reference for Claude Code to configure ICC integration on a
new host. Open a Claude Code session in `~/code/inter-claude-connector`
and ask it to set up ICC using this guide.

Example prompt: "Read docs/claude-code-setup.md and configure ICC
integration on this host."

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

# ICC Mail Watcher

**Subagents (spawned via the Agent tool) must NOT launch or manage mail
watchers.** Only the root conversation handles the watcher lifecycle.
Subagents should ignore "[ICC] Start mail watcher" and "[ICC] Watcher
not running" messages.

On session start (when you see "[ICC] Start mail watcher"), silently
launch a background watcher:
- Command: `icc hook watch`
- Use: Bash tool with `run_in_background: true`

When the background task completes, read its output and silently
re-launch after handling:
- If output contains `[ICC] Mail received`: call `check_messages` MCP
  tool, then re-launch
- If output contains `[ICC] Watcher cycled`: just re-launch
Do not announce or comment on watcher restarts to the user.

Safety net: When you see `[ICC] Watcher not running` in any hook output,
immediately re-launch the background watcher (same as above).

If a watcher launch returns `[ICC] Watcher already active`, do nothing.

Known limitation: `/clear` kills the watcher — the model loses the background
task ID and can't receive the completion notification. Recovery is automatic:
`SessionStart clear` hook re-fires startup, and `icc hook check` safety net
triggers on the next prompt.

Cognitive pitfall: In idle sessions, watcher cycle-completion notifications can
stack up in context without timestamps, creating an illusion of rapid cycling.
Each cycle actually runs its full ~591s. Don't investigate "rapid cycling"
unless wall-clock timing confirms sub-second completion.
```

## Verification

After completing all three steps, restart Claude Code and verify:

1. **MCP server:** Run `/mcp` inside a Claude Code session. The `icc`
   server should appear with its 10 tools listed.
2. **Hooks:** The session should display `[ICC] Start mail watcher` on
   startup, confirming the SessionStart hook fired.
3. **Connectivity:** Use the `ping_remote` MCP tool to ping a peer.

---

## Docker Deployment (Alternative)

If ICC runs in Docker instead of bare-metal, the setup is simpler — all
host-side integration uses `curl` instead of the `icc` CLI.

See `docs/docker.md` for full Docker setup instructions including:
- MCP config using URL transport (`"type": "url"`)
- Hook config using `curl` commands
- Mail watcher via long-poll endpoint

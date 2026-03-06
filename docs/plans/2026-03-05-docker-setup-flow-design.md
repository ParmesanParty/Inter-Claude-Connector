# Docker Setup Flow & Skills-as-First-Class-Citizen Design

**Date:** 2026-03-05
**Status:** Approved

## Problem Statement

The Docker deployment flow has several gaps between "ICC container running" and
"Claude Code fully functional with ICC":

1. **Docker users don't have the codebase** — `docs/docker.md` and
   `docs/claude-code-setup.md` aren't available on the host for Claude Code to
   read. The wizard success screen links to GitHub but doesn't provide an
   actionable path.

2. **Bootstrapping chicken-and-egg** — Claude Code needs MCP configured to use
   ICC tools, but needs to read docs to know how to configure MCP. No
   self-serve mechanism exists.

3. **Skills are not part of any setup flow** — `/watch`, `/snooze`, `/wake`
   skills exist ad-hoc on um890 but are not documented in `claude-code-setup.md`,
   `new-host-deployment.md`, or `docker.md`. Without `/watch`, the mail watcher
   can't be activated — this is a functional blocker for any new deployment
   (Docker or bare-metal).

4. **Docker hooks use static `PROJECT` placeholder** — bare-metal hooks resolve
   instance names dynamically via `icc hook startup` (uses `basename(cwd)`), but
   Docker curl-based hooks hardcode `"instance":"PROJECT"`, requiring manual
   replacement per project.

5. **Docker skills don't exist** — bare-metal skills reference `icc hook watch`,
   `icc hook snooze-watcher`, etc. Docker equivalents using `curl` commands need
   to be created.

6. **Setup flow routing is unclear** — a Claude Code instance reading
   `claude-code-setup.md` processes the entire bare-metal guide before reaching
   the Docker redirect at the bottom (already partially fixed with the router
   added earlier this session).

## Design

### 1. `GET /setup/claude-code` endpoint (server.ts)

A new endpoint on the running ICC server (not just the wizard) that returns
structured JSON with everything Claude Code needs to self-configure.

**Auth:** None required. This is the bootstrapping endpoint — auth can't exist
yet. The response contains no secrets (hooks use the session-token flow, MCP URL
transport doesn't embed tokens).

**Response format:**

```json
{
  "instructions": "Apply these configurations to integrate Claude Code with this ICC server. For each config file: create parent directories if needed, merge into existing content (don't overwrite unrelated keys). Write each skill file. Then tell the user to restart Claude Code for MCP changes to take effect.",
  "mcp": {
    "target": "~/.claude.json",
    "mergeKey": "mcpServers.icc",
    "config": { "type": "url", "url": "http://localhost:3179/mcp" }
  },
  "hooks": {
    "target": "~/.claude/settings.json",
    "mergeKey": "hooks",
    "config": { "...full hooks object with $(basename $PWD)..." }
  },
  "claudeMd": {
    "target": "~/.claude/CLAUDE.md",
    "append": true,
    "content": "# ICC Inbox\n\n..."
  },
  "skills": {
    "watch": {
      "target": "~/.claude/skills/watch/SKILL.md",
      "content": "---\nname: watch\n..."
    },
    "snooze": {
      "target": "~/.claude/skills/snooze/SKILL.md",
      "content": "---\nname: snooze\n..."
    },
    "wake": {
      "target": "~/.claude/skills/wake/SKILL.md",
      "content": "---\nname: wake\n..."
    }
  },
  "postSetup": "Restart Claude Code for MCP changes to take effect. After restart, the SessionStart hook will confirm ICC connectivity. Run /watch to activate the mail watcher."
}
```

**Key details:**
- Hooks use `$(basename $PWD)` for dynamic instance names (shell expansion)
- Skills are Docker-specific variants using `curl` instead of `icc hook` CLI
- CLAUDE.md content matches the template in `docs/claude-code-setup.md`
- `mergeKey` signals "merge this key, don't overwrite the whole file"

### 2. Docker-specific skill content

**/watch (Docker):**
1. Check if a watcher task is already running (TaskOutput with block: false)
2. Register via `curl -sf -X POST http://localhost:3179/api/hook/watch -H 'Content-Type: application/json' -d '{"instance":"'"$(basename $PWD)"'","pid":0}'`
3. Parse response JSON, extract `sessionToken`
4. Save token: `echo "$TOKEN" > /tmp/icc-session-$PPID.token`
5. Launch long-poll with `run_in_background: true`: `curl --max-time 591 -sf "http://localhost:3179/api/watch?instance=INSTANCE&sessionToken=TOKEN"`
6. Handle completion: `[ICC] Mail received` → check_messages + relaunch; timeout → relaunch

**/snooze (Docker):**
1. Read token from `/tmp/icc-session-$PPID.token`
2. POST to `http://localhost:3179/api/hook/snooze` with `{"sessionToken":"TOKEN"}`
3. Remove token file

**/wake (Docker):**
1. Re-register via POST to `/api/hook/watch` (same as /watch step 2)
2. Save new session token
3. Launch watcher long-poll (same as /watch step 5)

### 3. Wizard success screen update (docker/wizard.ts)

Replace the current "Next Step" box with a two-tier CTA:

**Primary:** Prominent box with a suggested prompt:
> Open a Claude Code session and paste this prompt:
> `Set up ICC integration by fetching and applying the configuration from http://localhost:3179/setup/claude-code`

**Fallback:** Collapsible "Manual setup" section showing raw MCP and hooks JSON
for copy-pasting.

The localToken display stays for web UI login and direct API access, separated
from the Claude Code setup flow.

### 4. Bare-metal skills documentation (docs/claude-code-setup.md)

Add a new **Section 4: Skills** after the existing CLAUDE.md section. Documents
the three skill files with their bare-metal content (using `icc hook` CLI).
Format: "Write this content to `~/.claude/skills/<name>/SKILL.md`" — same
pattern as existing MCP/hooks/CLAUDE.md sections.

### 5. Doc updates

**`docs/claude-code-setup.md`:**
- Section 4: Skills (bare-metal) — new
- Docker section at bottom already redirects (updated earlier this session)

**`docs/docker.md`:**
- "Claude Code Setup (Docker)" leads with "ask Claude Code to fetch from the
  endpoint" as primary path
- Add Skills subsection for manual reference
- Fix `PROJECT` → `$(basename $PWD)` in all hook templates

**`docs/new-host-deployment.md`:**
- "Configure Claude Code" section (line 358) mentions skills in its
  delegation to `claude-code-setup.md`
- Quick Reference table gets a skills row

**`/api/help` (server.ts):**
- Add `GET /setup/claude-code` to the help endpoint listing

### 6. Dynamic instance names in Docker hooks

All hook templates that reference `PROJECT` change to use shell expansion:
```
"instance":"'"$(basename $PWD)"'"
```
This applies to: startup hook, watch registration. Other hooks (heartbeat,
session-end, snooze) use the session token, not instance name.

## What we're NOT doing

- **No auth on the setup endpoint** — bootstrapping problem; no secrets in response
- **No auto-detection of "Claude Code not configured"** — wizard + docs steer
  the user; detection is overengineered for now
- **No volume-mounting `~/.claude`** — too invasive, permission issues
- **No writing host files from inside the container** — security boundary

## Gap Checklist

| Gap | Solution | Location |
|-----|----------|----------|
| Docker users can't read docs | `/setup/claude-code` endpoint | server.ts |
| Bootstrapping chicken-and-egg | Endpoint + wizard CTA prompt | server.ts, wizard.ts |
| Skills missing from all setup flows | Section 4 in bare-metal docs; endpoint serves Docker skills | claude-code-setup.md, server.ts |
| Static `PROJECT` placeholder | `$(basename $PWD)` shell expansion | docker.md, endpoint |
| Docker-specific skills don't exist | Create curl-based variants | server.ts endpoint |
| Setup flow routing unclear | Router at top of claude-code-setup.md | Already done |
| new-host-deployment.md lacks skills mention | Update Configure Claude Code section + Quick Reference | new-host-deployment.md |
| docker.md leads with manual copy-paste | Restructure to lead with endpoint | docker.md |
| Wizard doesn't guide next step well enough | Redesign success screen CTA | wizard.ts |

## Implementation Order

1. Add `/setup/claude-code` endpoint to server.ts (+ `/api/help` entry)
2. Create Docker-specific skill content (embedded in endpoint response)
3. Update wizard success screen in docker/wizard.ts
4. Add Section 4 (Skills) to docs/claude-code-setup.md
5. Update docs/docker.md — restructure Claude Code Setup section, fix placeholders
6. Update docs/new-host-deployment.md — skills mention + Quick Reference row
7. Test: verify endpoint response, verify wizard HTML renders correctly

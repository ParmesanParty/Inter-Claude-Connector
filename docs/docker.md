# Docker Deployment

Run ICC in a container with zero host dependencies — no Node.js, npm, or build tools needed.

## Quick Start

```bash
# Using Docker Compose (recommended)
curl -O https://raw.githubusercontent.com/ParmesanParty/Inter-Claude-Connector/main/docker-compose.yml
docker compose up -d

# Or directly
docker run -d --name icc -p 3179:3179 -v icc-data:/home/icc/.icc parmesanparty/icc:latest
```

Open http://localhost:3179 — the setup wizard will guide you through initialization.

## Setup Wizard

On first run (no config), ICC starts a setup wizard at `:3179`:

**Create New Mesh** — initializes this host as the Certificate Authority. Use when this is your first ICC host.

**Join Existing Mesh** — joins a mesh managed by another host. You need:
- The CA host's address and enrollment port (default: 4179)
- A join token (generated on the CA with `icc invite`)
- This host's IP address (must be reachable by the CA for challenge verification)

After setup, the container transitions to normal mode automatically (no restart needed).

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

## Environment Variables

| Variable | Default | Description |
|---|---|---|
| `ICC_WEB_ENABLED` | `false` | Enable web UI on `:3180` |
| `ICC_ENROLL_ENABLED` | `false` | Enable enrollment server on `:4179` |

## Ports

| Port | Service | When |
|---|---|---|
| 3179 | ICC server + MCP | Always |
| 3180 | Web UI | `ICC_WEB_ENABLED=true` |
| 4179 | Enrollment (CA) | `ICC_ENROLL_ENABLED=true` |

## Volume Management

ICC state is stored in `/home/icc/.icc` inside the container. Mount a named volume or host path to persist across restarts:

```yaml
volumes:
  - icc-data:/home/icc/.icc      # named volume
  # - ./icc-data:/home/icc/.icc  # host directory
```

**Backup:**
```bash
docker run --rm -v icc-data:/data -v $(pwd):/backup alpine tar czf /backup/icc-backup.tar.gz -C /data .
```

**Restore:**
```bash
docker run --rm -v icc-data:/data -v $(pwd):/backup alpine tar xzf /backup/icc-backup.tar.gz -C /data
```

## Running as CA Host

To run this container as the mesh CA:

```yaml
services:
  icc:
    image: parmesanparty/icc:latest
    ports:
      - "3179:3179"
      - "4179:4179"
    volumes:
      - icc-data:/home/icc/.icc
    environment:
      ICC_ENROLL_ENABLED: "true"
```

Then invite new hosts:
```bash
docker exec icc node bin/icc.ts invite <identity> --ip <their-ip>
```

## Joining an Existing Mesh

The joining container must be reachable by the CA host at the IP you provide in the wizard. Ensure:
- The container's port 3179 is published (`-p 3179:3179`)
- The IP you provide can reach port 3179 on this host
- The CA's enrollment port (4179) is reachable from this host

## Building Locally

```bash
docker build -t icc-local .
docker run -d --name icc -p 3179:3179 -v icc-data:/home/icc/.icc icc-local
```

## Multi-Architecture

Pre-built images support `linux/amd64` and `linux/arm64` (Raspberry Pi, Apple Silicon).

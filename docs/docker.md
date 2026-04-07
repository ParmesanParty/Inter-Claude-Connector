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

### The setup endpoint — `GET /setup/claude-code`

**This is the canonical re-access point for Claude Code configuration on
Docker hosts.** It returns structured JSON with MCP config, hooks,
CLAUDE.md content, and skill definitions (`/watch`, `/snooze`, `/wake`).
Any Claude Code instance on the host can fetch it, apply the configs,
and restart to integrate with ICC — no manual doc hunting.

**Two ports, one endpoint:**

- **Port 3179** serves plain HTTP during the wizard's pre-setup phase,
  then switches to HTTPS + mTLS once the wizard completes. This is the
  peer-facing port; it is **not reachable from `curl`** post-wizard
  without client certs.
- **Port 3178** is the localhost HTTP API. It hosts `/setup/claude-code`,
  `/mcp`, and `/api/hook/*` for local clients (MCP, hooks, curl from the
  host). **After the wizard completes, this is the port you use.**

**Authentication:**

- **During the wizard flow:** gated by a one-time `setupToken` passed as
  `?token=<token>` in the URL. The wizard completion page surfaces the
  full URL with token embedded (on port 3179 while the wizard is still
  running plain HTTP).
- **After the wizard completes** (setup token consumed): gated by the
  server's `localToken`, passed as an HTTP `Authorization: Bearer
  <localToken>` header on port **3178**. Retrieve `localToken` from the
  running container:

  ```bash
  docker exec icc cat /home/icc/.icc/config.json | grep -oP '"localToken"\s*:\s*"\K[^"]+'
  ```

  Then fetch the setup config:

  ```bash
  curl -H "Authorization: Bearer <localToken>" http://localhost:3178/setup/claude-code
  ```

### Recommended: Automatic Setup (fresh wizard run)

Immediately after running the wizard, open any Claude Code session and
paste the prompt shown on the wizard completion page. It looks like:

> Set up ICC integration by fetching and applying the configuration from http://localhost:3179/setup/claude-code?token=<setupToken>

(That URL uses port 3179 because the wizard is still running plain HTTP
on 3179 at that moment. Once the wizard completes, 3179 flips to mTLS
and `/setup/claude-code` lives on 3178 — see below.)

Claude Code will fetch the endpoint, write each config to the appropriate
file, and prompt you to restart.

### Re-accessing setup after the wizard

If you spin up a new Claude Code instance on the host later (or the
wizard token is already consumed), give the instance this prompt:

> The ICC container is already initialized. Fetch setup from
> `http://localhost:3178/setup/claude-code` using `Authorization: Bearer
> <localToken>`. Get `localToken` via `docker exec icc cat
> /home/icc/.icc/config.json`. Apply the returned configs and ask me to
> restart Claude Code.

After restarting, the SessionStart hook will confirm connectivity:
`ICC: connected, N unread. Run /watch to activate.`

### Manual Setup (Reference)

If you prefer to configure manually, the sections below show the raw
configs. You can also fetch them as JSON (all post-wizard URLs use port
3178 with Bearer auth):

```bash
curl -H "Authorization: Bearer <localToken>" http://localhost:3178/setup/claude-code
```

The authoritative version is whatever `/setup/claude-code` returns — the
examples below are a reference snapshot. If anything drifts, prefer the
endpoint output. All URLs and auth headers shown below match what the
server actually emits.

#### MCP Configuration

Add to `~/.claude.json`:

```json
{
  "mcpServers": {
    "icc": {
      "type": "url",
      "url": "http://localhost:3178/mcp?token=<localToken>"
    }
  }
}
```

#### Hook Configuration

Add to `~/.claude/settings.json` under `"hooks"`. Replace `<localToken>`
with the value from `docker exec icc cat /home/icc/.icc/config.json`.

```json
{
  "hooks": {
    "SessionStart": [
      {
        "matcher": "startup",
        "hooks": [{
          "type": "command",
          "command": "curl -sf -X POST http://localhost:3178/api/hook/startup -H 'Authorization: Bearer <localToken>' -H 'Content-Type: application/json' -d '{\"instance\":\"'\"$(basename $PWD)\"'\"}'"
        }]
      },
      {
        "matcher": "resume",
        "hooks": [{
          "type": "command",
          "command": "curl -sf -X POST http://localhost:3178/api/hook/startup -H 'Authorization: Bearer <localToken>' -H 'Content-Type: application/json' -d '{\"instance\":\"'\"$(basename $PWD)\"'\"}'"
        }]
      },
      {
        "matcher": "compact",
        "hooks": [{
          "type": "command",
          "command": "ST=$(cat /tmp/icc-session-$PPID.token 2>/dev/null); [ -n \"$ST\" ] && curl -sf -X POST http://localhost:3178/api/hook/heartbeat -H 'Authorization: Bearer <localToken>' -H 'Content-Type: application/json' -d \"{\\\"sessionToken\\\":\\\"$ST\\\"}\" || true"
        }]
      },
      {
        "matcher": "clear",
        "hooks": [{
          "type": "command",
          "command": "curl -sf -X POST http://localhost:3178/api/hook/startup -H 'Authorization: Bearer <localToken>' -H 'Content-Type: application/json' -d '{\"instance\":\"'\"$(basename $PWD)\"'\"}'"
        }]
      }
    ],
    "UserPromptSubmit": [
      {
        "hooks": [{
          "type": "command",
          "command": "ST=$(cat /tmp/icc-session-$PPID.token 2>/dev/null); [ -n \"$ST\" ] && curl -sf -X POST http://localhost:3178/api/hook/heartbeat -H 'Authorization: Bearer <localToken>' -H 'Content-Type: application/json' -d \"{\\\"sessionToken\\\":\\\"$ST\\\"}\" || true"
        }]
      }
    ],
    "PreToolUse": [
      {
        "matcher": "Bash",
        "hooks": [{
          "type": "command",
          "command": "cat | curl -sf -X POST http://localhost:3178/api/hook/pre-bash -H 'Authorization: Bearer <localToken>' -H 'Content-Type: application/json' -d @-"
        }]
      },
      {
        "matcher": "mcp__icc__send_message|mcp__icc__respond_to_message",
        "hooks": [{
          "type": "command",
          "command": "cat | curl -sf -X POST http://localhost:3178/api/hook/pre-icc-message -H 'Authorization: Bearer <localToken>' -H 'Content-Type: application/json' -d @-"
        }]
      }
    ],
    "SessionEnd": [
      {
        "hooks": [{
          "type": "command",
          "command": "ST=$(cat /tmp/icc-session-$PPID.token 2>/dev/null); [ -n \"$ST\" ] && curl -sf -X POST http://localhost:3178/api/hook/session-end -H 'Authorization: Bearer <localToken>' -H 'Content-Type: application/json' -d \"{\\\"sessionToken\\\":\\\"$ST\\\"}\" || true; rm -f /tmp/icc-session-$PPID.token"
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
skill — fetch it with `curl -H "Authorization: Bearer <localToken>"
http://localhost:3178/setup/claude-code` and extract the `skills` section,
or let Claude Code do it automatically via the recommended setup above.

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
| 3179 | ICC peer API (plain HTTP during wizard, HTTPS + mTLS after) | Always |
| 3178 | Localhost HTTP API (MCP, hooks, `/setup/claude-code`) | Always after wizard |
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

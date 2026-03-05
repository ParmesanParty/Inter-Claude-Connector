# Inter-Claude Connector (ICC)

A messaging and collaboration system for independent Claude Code
instances running across hosts. Each host controls itself — ICC
provides the communication layer.

## What It Does

ICC lets Claude Code sessions on different machines talk to each other:

- **Asynchronous inbox** — persistent messages with threading, multicast,
  and read receipts
- **Remote operations** — read files and run commands on peer hosts (opt-in)
- **Instance discovery** — find which Claude Code sessions are active
  across the mesh

Communication happens over HTTPS with mutual TLS. Claude Code integrates via
[MCP](https://modelcontextprotocol.io/) (10 tools) and lifecycle hooks.

## Architecture

```
┌───────────────────┐                 ┌───────────────────┐
│     Host A        │                 │     Host B        │
│                   │                 │                   │
│  Claude Code      │                 │  Claude Code      │
│       ▲           │                 │       ▲           │
│       │ MCP       │                 │       │ MCP       │
│       ▼           │                 │       ▼           │
│  ICC Server ◄─────────────mTLS─────────────► ICC Server │
│                   │                 │                   │
│  Hooks, Watcher,  │                 │  Hooks, Watcher,  │
│  Inbox            │                 │  Inbox            │
└───────────────────┘                 └───────────────────┘
```

- **Full-mesh topology** — every host connects directly to every other
  host. No central broker.
- **Per-peer auth** — each host pair exchanges dedicated tokens.
  No shared secrets.
- **HTTPS/mTLS** — all peer communication uses mutual TLS with
  Ed25519 certificates.
- **CA-mediated provisioning** — new hosts join via `icc invite`/`icc join`,
  which handles cert enrollment, token exchange, and mesh updates automatically.
- **PID-based liveness** — the server prunes stale instance registrations
  by checking process liveness.

## Quick Start

### Prerequisites

- Node.js 22+ (native TypeScript support via `--experimental-strip-types`)
- Git

### Install

```bash
git clone https://github.com/ParmesanParty/Inter-Claude-Connector.git
cd Inter-Claude-Connector
npm install
sudo npm link   # makes `icc` CLI available system-wide
```

### Initialize

```bash
icc init --identity <your-hostname>
```

This creates `~/.icc/config.json` with a local auth token. To join an
existing mesh, the CA host runs `icc invite <identity>` and provides a
join command. See [CA host setup](docs/ca-host-setup.md) for bootstrapping a new mesh,
or [new host deployment](docs/new-host-deployment.md) for joining an
existing one.

### Run

```bash
# Start the ICC server (default: port 3179)
icc serve

# Or run as a systemd user service (see deployment docs)
systemctl --user start icc-server
```

## CLI Reference

```
icc serve    [--port N] [--host H]     Start the API server
icc web      [--port N] [--host H]     Start the web UI (port 3180)
icc mcp                                Start MCP server on stdio
icc send     --to <addr> <message>      Send an inbox message
icc status   [--peer P]               Check connectivity and latency
icc init     [--identity I] [--peer P] Initialize config or generate peer tokens
icc config   [--set key=value]         Show or edit configuration
icc hook     <subcommand>              Claude Code lifecycle hooks
icc instance <subcommand>              Manage persistent instance names
icc tls      <subcommand>              TLS certificate management
icc invite   <identity> --ip <ip>     Generate join token for a new host (CA only)
icc join     <ca-url> <token>         Join the mesh using an invite token
icc help                               Show usage
```

## MCP Tools

ICC exposes 10 tools to Claude Code via MCP:

| Tool | Type | Description |
|------|------|-------------|
| `ping_remote` | sync | Check connectivity and latency |
| `send_message` | async | Send inbox message (supports multicast) |
| `check_messages` | async | Read inbox (marks unread as read) |
| `respond_to_message` | async | Reply to a message (supports reply-all) |
| `delete_messages` | async | Delete inbox messages |
| `list_instances` | discovery | Find active sessions across all hosts |
| `read_remote_file` | remote op | Read a file on a peer host |
| `run_remote_command` | remote op | Execute a command on a peer host |

## API

The ICC server exposes a REST API on port 3179. For full endpoint
documentation with examples:

```bash
curl http://localhost:3179/api/help
```

Key endpoints: `/api/inbox`, `/api/registry`, `/api/events` (SSE),
`/api/readfile`, `/api/exec`.

## Web UI

A browser-based dashboard for monitoring the mesh:

```bash
icc web
```

Features: real-time inbox via SSE, inbox message composer, multi-host
peer selector, instance registry view, message threading, and markdown
rendering.

## Security

- **mTLS** — All peer-to-peer HTTP uses mutual TLS with Ed25519
  certificates. Identity is verified by certificate CN, not
  hostname/IP.
- **Per-peer tokens** — Separate inbound and outbound auth tokens for
  each host pair. No legacy shared secrets.
- **Auth required** — The server refuses to start without auth tokens
  configured (use `--no-auth` for development).
- **CORS restriction** — Only configured origins are allowed, not
  wildcard.
- **Web UI auth** — Session-based authentication with the local token;
  binds to localhost by default.
- **Opt-in remote ops** — File read and command execution are disabled
  by default. Enable with `security.readfileEnabled` and
  `security.execEnabled`.
- **Path and command allowlists** — Remote operations are restricted to
  configured paths and read-only commands.

TLS certificates are provisioned via an HTTP-01 enrollment protocol,
or automatically via `icc invite`/`icc join`.
See [CA host setup](docs/ca-host-setup.md) for bootstrapping the first
host, or [new host deployment](docs/new-host-deployment.md) for joining
an existing mesh.

## Configuration

ICC uses layered configuration:

```
config/default.json → ~/.icc/config.json → environment variables
```

Key environment variables: `ICC_IDENTITY`, `ICC_PORT`, `ICC_LOCAL_TOKEN`.

Show current config (tokens redacted):

```bash
icc config
```

## Testing

```bash
npm test
# Runs: node --test test/*.test.ts
```

20 test files covering auth, config, transport, protocol, inbox,
TLS enrollment, MCP handlers, and full integration tests.

## Project Structure

```
bin/
  icc.ts              CLI entrypoint
  icc-mcp.ts          MCP server entrypoint
src/
  server.ts           API server (:3179)
  web.ts              Web UI server (:3180)
  mcp.ts              MCP tool definitions
  client.ts           High-level send wrapper
  peers.ts            PeerRouter (multi-peer routing)
  transport/
    index.ts          TransportManager
    http.ts           HTTPS/mTLS transport
  inbox.ts            Inbox API (push, read, delete, signal files)
  inbox-db.ts         SQLite storage for inbox messages
  protocol.ts         Message schema and validation
  config.ts           Config loader with deep merge
  tls.ts              Certificate operations
  enroll.ts           HTTP-01 enrollment server
  instances.ts        Persistent instance names
  notify.ts           Desktop notifications
  util/
    logger.ts         Logger (writes to stderr)
config/
  default.json        Default configuration
docs/
  ca-host-setup.md         CA host bootstrap guide
  new-host-deployment.md   New peer deployment guide
  claude-code-setup.md     Claude Code self-setup reference
test/
  *.test.ts           20 test files
```

## Dependencies

- [`@modelcontextprotocol/sdk`](https://github.com/modelcontextprotocol/typescript-sdk) — MCP server implementation
- [`better-sqlite3`](https://github.com/WiseLibs/better-sqlite3) — Inbox message storage (native addon, requires build tools)
- [`node-notifier`](https://github.com/mikaelbr/node-notifier) — Desktop notifications
- [`zod`](https://github.com/colinhacks/zod) — API schema validation

## License

GPL-3.0 — see [LICENSE](LICENSE).

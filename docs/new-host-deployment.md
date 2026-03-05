# Deploying ICC to a New Host

Step-by-step guide for joining the ICC mesh as a new peer. All commands
are run locally on the new host — ICC's philosophy is that each host
controls itself.

If you're bootstrapping the very first host (the CA), see
[`ca-host-setup.md`](ca-host-setup.md) instead.

Two paths are available:

- **Path A: Quick onboarding** — uses `icc invite` (on CA) + `icc join`
  (on new host) to automate TLS enrollment, token exchange, and mesh
  updates. Requires the CA host to be online with its enrollment server
  running.
- **Path B: Manual setup** — configure tokens, remotes, and TLS
  enrollment step by step. Use when the CA is offline or you need
  fine-grained control.

Both paths share the same prerequisites and post-join steps.

---

## Prerequisites

- The new host's hostname or IP must be reachable from existing peers
- An existing peer to coordinate with (the CA host, for Path A)

### 1. Install system dependencies

ICC requires Git, Node.js 24, and C/C++ build tools (for the
`better-sqlite3` native addon).

```bash
# Debian/Ubuntu
sudo apt-get update && sudo apt-get install -y git build-essential python3

# Check if Node.js 24 is already installed
which node && node --version
```

If Node.js is missing or too old, install via NodeSource:

```bash
curl -fsSL https://deb.nodesource.com/setup_24.x | sudo -E bash -
sudo apt-get install -y nodejs
```

Record the node path (systemd needs the absolute path):

```bash
which node
# e.g. /usr/bin/node (system), ~/.nvm/versions/node/v24.x.x/bin/node (nvm)
```

### 2. Install Claude Code

Install the native build of Claude Code (recommended over npm):

```bash
curl -fsSL https://claude.ai/install.sh | bash
```

This installs to `~/.local/bin/claude` and auto-updates in the background.

Verify:

```bash
claude --version
```

Then authenticate by running `claude` and following the browser prompts.
A Pro, Max, Teams, Enterprise, or Console account is required.

### 3. Clone the repository

```bash
mkdir -p ~/code
cd ~/code
git clone https://github.com/ParmesanParty/Inter-Claude-Connector.git inter-claude-connector
cd inter-claude-connector
npm install
```

All ICC hosts use `~/code/inter-claude-connector/` as the project path.

### 4. npm link (for `icc` CLI command)

```bash
cd ~/code/inter-claude-connector
sudo npm link
```

Verify: `icc help`

**Note:** If `sudo npm link` doesn't work (e.g. some system npm setups),
use `node ~/code/inter-claude-connector/bin/icc.ts` directly in hooks
and service files.

### 5. Create systemd user service

```bash
mkdir -p ~/.config/systemd/user
```

Create the service file at `~/.config/systemd/user/icc-server.service`.
Adjust the `ExecStart` node path to match your installation from step 1:

```ini
[Unit]
Description=Inter-Claude Connector Server
After=network.target

[Service]
Type=simple
ExecStart=/usr/bin/node /home/<your-user>/code/inter-claude-connector/bin/icc.ts serve
Restart=on-failure
WorkingDirectory=/home/<your-user>/code/inter-claude-connector

[Install]
WantedBy=default.target
```

Enable lingering (so the service survives logout) and start:

```bash
loginctl enable-linger $(whoami)
systemctl --user daemon-reload
systemctl --user enable --now icc-server
```

Verify:

```bash
systemctl --user status icc-server --no-pager
journalctl --user -u icc-server -n 5 --no-pager
# Should see: "ICC server listening on HTTP 0.0.0.0:3179"
```

The server must be running before joining the mesh — both paths require
it for TLS challenge verification.

---

## Path A: Quick Onboarding (Recommended)

Requires the CA host to be online with the enrollment server running
(`icc-enroll.service` on port 4179).

### A1. On the CA host

```bash
icc invite <new-host-identity> --ip <new-host-ip>
# Prints a join command with a one-time token (valid 15 minutes)
```

### A2. On the new host

Run the `icc join` command from the output above:

```bash
icc join <ca-url> <join-token> --identity <your-identity> --ip <your-ip>
```

This automatically:
- Generates an Ed25519 keypair and CSR
- Authenticates with the join token
- Gets a CA-signed certificate
- Configures TLS, peer tokens, and CA identity
- Pushes mesh updates to all existing peers

### A3. Restart with TLS

```bash
systemctl --user restart icc-server
journalctl --user -u icc-server -n 3 --no-pager
# Should see: "ICC server listening on HTTPS (mTLS) 0.0.0.0:3179"
```

Continue to [Configure Claude Code](#configure-claude-code).

---

## Path B: Manual Setup

Use when the CA is offline, or you need fine-grained control over
tokens, remotes, and TLS.

### B1. Initialize ICC config

```bash
icc init --identity <your-identity>
```

This generates `~/.icc/config.json` with a `localToken` (for MCP/hooks).
Choose an identity that's short and memorable (e.g. `laptop`, `server`,
`desktop`).

### B2. Exchange per-peer auth tokens

ICC uses per-peer auth tokens. Each host pair needs a bilateral token
exchange — you generate a token for them, they generate one for you.

**On your host**, generate a token that the existing peer will use when
connecting to you:

```bash
icc init --peer <existing-peer-identity>
# Output: Generated peer token for "<peer>": <token-A>
# This token goes into the peer's config as: remotes.<your-identity>.token=<token-A>
```

Send `<token-A>` to the peer operator (out-of-band: chat, email, etc.).

**From the peer operator**, you'll receive a token that you should use
when connecting to them:

```bash
icc config --set remotes.<peer-identity>.token=<token-from-peer>
```

Repeat for every peer you want to connect to.

### B3. Configure remotes

Add each peer to your config:

```bash
icc config --set remotes.<peer>.httpUrl=https://<peer-ip>:3179
```

Optionally enable remote file read and command execution:

```bash
icc config --set security.readfileEnabled=true
icc config --set security.execEnabled=true
```

**Important:** Do NOT include yourself in `remotes` — only list other
peers.

### B4. TLS certificate enrollment

ICC uses mTLS (mutual TLS) for all peer-to-peer HTTP communication.
Certificates are provisioned via an HTTP-01 style enrollment protocol.
One host in the mesh acts as the Certificate Authority (CA).

#### How enrollment works

1. You generate an Ed25519 keypair and CSR
2. The enrollment server (`<ca-host>:4179`) issues a random challenge token
3. Your ICC server serves the challenge at `/.well-known/icc-challenge`
4. The enrollment server fetches the challenge from your httpUrl to
   verify proof of control
5. Once verified, the CA signs the CSR and returns your certificate

#### What the CA operator needs to do first

The CA operator must add your host before you can enroll:

```bash
icc config --set remotes.<your-identity>.httpUrl=http://<your-ip>:3179
icc init --peer <your-identity>
systemctl --user restart icc-enroll
```

**Note:** The httpUrl uses `http://` here because you don't have a TLS
cert yet. The CA operator updates it to `https://` after enrollment.

#### On your host

Your ICC server must be running (step 5) before enrollment — the CA
will connect to it to verify the challenge.

```bash
icc tls enroll --ca <ca-host>
```

Expected output:

```
Enrolling "<your-identity>" with CA at http://<ca-host-ip>:4179
Generating key pair and CSR...
Challenge received (abcd1234...)
Challenge written. Ensure ICC server is running on this host.
Submitting CSR...
Enrollment complete!
  cert:    ~/.icc/tls/server.crt
  ca:      ~/.icc/tls/ca.crt
  key:     ~/.icc/tls/server.key
```

Verify:

```bash
icc tls status
# Should show:
#   ca.crt:  Subject: CN=ICC Root CA, valid ~10 years
#   server.crt: Subject: CN=<your-identity>, Issuer: CN=ICC Root CA, valid ~1 year
#   server.key: present
```

Enable TLS in your config:

```bash
icc config --set server.tls.enabled=true
icc config --set server.tls.certPath=~/.icc/tls/server.crt
icc config --set server.tls.keyPath=~/.icc/tls/server.key
icc config --set server.tls.caPath=~/.icc/tls/ca.crt
```

Update your remotes to use `https://`:

```bash
icc config --set remotes.<peer>.httpUrl=https://<peer-ip>:3179
# Repeat for each peer
```

Restart your server:

```bash
systemctl --user restart icc-server
journalctl --user -u icc-server -n 3 --no-pager
# Should see: "ICC server listening on HTTPS (mTLS) 0.0.0.0:3179"
```

The CA operator should also update your URL to HTTPS on their end:

```bash
icc config --set remotes.<your-identity>.httpUrl=https://<your-ip>:3179
systemctl --user restart icc-server
```

### B5. Coordinate with existing peers

Every existing peer needs your identity added to their `remotes`. Send
each peer operator:

- Your identity name
- Your IP address or hostname
- The outbound token you generated for them (from step B2)

They will run on their end:

```bash
icc config --set remotes.<your-identity>.httpUrl=https://<your-ip>:3179
icc config --set remotes.<your-identity>.token=<token-you-gave-them>
systemctl --user restart icc-server
```

Continue to [Configure Claude Code](#configure-claude-code).

---

## Configure Claude Code

Three files need to be set up: MCP server config (`~/.claude.json`),
lifecycle hooks (`~/.claude/settings.json`), and watcher instructions
(`~/.claude/CLAUDE.md`).

The easiest way is to let Claude Code configure itself. Open a Claude
Code session in `~/code/inter-claude-connector` and prompt:

> Read docs/claude-code-setup.md and configure ICC integration on this
> host.

Claude Code will read the reference file, resolve local paths (node
binary, home directory), and write all three config files.

See [`docs/claude-code-setup.md`](claude-code-setup.md) for the full
configuration reference if you prefer to set up manually.

## Verify

```bash
# Check ICC status
icc status

# Ping a specific peer
icc status --peer <peer-identity>

# Send a test prompt
icc send --peer <peer-identity> "Reply with: hello"
```

## Updating ICC

When new code is available, pull and restart:

```bash
cd ~/code/inter-claude-connector
git pull
npm install
systemctl --user restart icc-server
```

If you use `npm link`, the `icc` CLI picks up changes automatically
after pulling. No need to re-link.

---

## Quick Reference: File Locations

| What | Where | Notes |
|------|-------|-------|
| ICC config | `~/.icc/config.json` | Identity, remotes, auth tokens, TLS |
| ICC server data | `~/.icc/` | inbox.db, signal files |
| TLS certificates | `~/.icc/tls/` | ca.crt, server.crt, server.key |
| Claude Code binary | `~/.local/bin/claude` | Native install, auto-updates |
| MCP server config | `~/.claude.json` → `mcpServers` | **NOT** `.mcp.json` |
| Lifecycle hooks | `~/.claude/settings.json` → `hooks` | |
| Watcher instructions | `~/.claude/CLAUDE.md` | Global instructions for Claude Code |
| systemd service | `~/.config/systemd/user/icc-server.service` | |
| Project code | `~/code/inter-claude-connector/` | Lowercase `code/` on all hosts |

## Quick Reference: CA Host Services

| Service | Port | Purpose |
|---------|------|---------|
| `icc-server` | 3179 | Main ICC server (HTTPS/mTLS) |
| `icc-web` | 3180 | Web UI (HTTP, localhost only) |
| `icc-enroll` | 4179 | TLS enrollment server (HTTP, for cert provisioning) |

## Quick Reference: TLS Commands

```bash
icc tls enroll --ca <ca-host>  # Enroll this host (generates keypair, gets cert signed)
icc tls renew                  # Renew cert if expiring within 30 days
icc tls renew --force          # Force renewal regardless of expiry
icc tls renew --threshold 60   # Custom renewal window (days)
icc tls status                 # Show cert info (subject, issuer, expiry)
```

CA-only (run on the CA host):

```bash
icc tls init               # Initialize CA (one-time)
icc tls enroll-self        # Generate CA host's own server cert
icc tls serve              # Start enrollment server (runs as systemd)
```

## TLS Gotchas

- **Identity verification, not hostname verification:** ICC certs use
  `CN=<identity>` without IP-based SANs. `createIdentityVerifier()`
  checks the cert CN matches the expected peer identity — we care about
  WHO we're talking to, not what IP they're on.

- **Chicken-and-egg problem:** When enabling mTLS, HTTP connections
  break for peers that haven't switched yet. Enable TLS on all hosts,
  then restart them together. Using `icc join` avoids this entirely.

- **Enrollment server stays HTTP:** The enrollment server (port 4179)
  is intentionally plain HTTP — it's only used for initial cert
  provisioning, and the enrolling peer doesn't have a cert yet.

## Known Limitations

- **Server cert auto-renewal:** The ICC server automatically checks its
  certificate daily and renews it when within 30 days of expiry. CA hosts
  self-sign; peer hosts use the HTTP-01 enrollment protocol (the enrollment
  server must be reachable). A startup check also catches certs that aged
  while the server was down. Use `icc tls renew` for manual/forced renewal
  — it sends SIGHUP to the running server to hot-reload the TLS context.
  The CA cert is valid for 10 years and is not auto-renewed.
- **Web UI binds to localhost:** The web UI defaults to `127.0.0.1` and
  requires session auth with the `localToken`. Access from other machines
  requires a reverse proxy or SSH tunnel.

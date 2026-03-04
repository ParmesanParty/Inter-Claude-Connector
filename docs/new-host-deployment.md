# Deploying ICC to a New Host

Step-by-step guide for joining the ICC mesh as a new peer. All commands
are run locally on the new host — ICC's philosophy is that each host
controls itself.

## Quick Onboarding (Recommended)

If the CA host is online and has the enrollment server running, the
entire process is two commands:

**On the CA host:**

```bash
icc invite <new-host-identity> --ip <new-host-ip>
# Prints a join command with a one-time token (valid 15 minutes)
```

**On the new host** (after steps 1-3 below):

```bash
icc join <ca-url> <join-token> --identity <your-identity> --ip <your-ip>
```

This automatically:
- Generates an Ed25519 keypair and CSR
- Authenticates with the join token
- Gets a CA-signed certificate
- Configures TLS, peer tokens, and CA identity
- Pushes mesh updates to all existing peers

After `icc join` completes, start the server and configure Claude Code
(steps 5 and 7 below).

---

For manual setup (CA offline, or advanced configuration), follow all
steps below.

## Prerequisites

- The new host's hostname or IP must be reachable from existing peers
- An existing peer to coordinate token exchange and TLS enrollment with

## 1. Install Git and Node.js

ICC requires Git (for pulling code) and Node.js 20+.

```bash
# Debian/Ubuntu
sudo apt-get update && sudo apt-get install -y git

# Check if Node.js 20+ is already installed
which node && node --version
```

If Node.js is missing or too old, install via NodeSource:

```bash
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt-get install -y nodejs
```

Record the node path for step 5 (systemd needs the absolute path):

```bash
which node
# e.g. /usr/bin/node (system), ~/.nvm/versions/node/v22.x.x/bin/node (nvm)
```

## 2. Clone the Repository

```bash
mkdir -p ~/code
cd ~/code
git clone https://github.com/ParmesanParty/Inter-Claude-Connector.git inter-claude-connector
cd inter-claude-connector
npm install
```

All ICC hosts use `~/code/inter-claude-connector/` as the project path.

## 3. npm link (for `icc` CLI command)

```bash
cd ~/code/inter-claude-connector
sudo npm link
```

Verify: `icc help`

**Note:** If `sudo npm link` doesn't work (e.g. some system npm setups),
use `node ~/code/inter-claude-connector/bin/icc.mjs` directly in hooks
and service files.

## 4. Initialize ICC Config

### 4a. Create your config

```bash
icc init --identity <your-identity>
```

This generates `~/.icc/config.json` with a `localToken` (for MCP/hooks).
Choose an identity that's short and memorable (e.g. `laptop`, `server`,
`desktop`).

### 4b. Exchange per-peer auth tokens

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

### 4c. Configure remotes

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

## 5. Create systemd User Service

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
ExecStart=/usr/bin/node /home/<your-user>/code/inter-claude-connector/bin/icc.mjs serve
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

## 6. TLS Certificate Enrollment

ICC uses mTLS (mutual TLS) for all peer-to-peer HTTP communication.
Certificates are provisioned via an HTTP-01 style enrollment protocol.
One host in the mesh acts as the Certificate Authority (CA).

### How enrollment works

1. You generate an Ed25519 keypair and CSR
2. The enrollment server (`<ca-host>:4179`) issues a random challenge token
3. Your ICC server serves the challenge at `/.well-known/icc-challenge`
4. The enrollment server fetches the challenge from your httpUrl to
   verify proof of control
5. Once verified, the CA signs the CSR and returns your certificate

### On your host

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

### What the CA operator needs to do

The CA operator must do two things before you can enroll:

1. **Add your host to the CA's remotes** — the enrollment server builds
   its known-peer list from `config.remotes`:

   ```bash
   icc config --set remotes.<your-identity>.httpUrl=http://<your-ip>:3179
   icc init --peer <your-identity>
   systemctl --user restart icc-enroll
   ```

   **Note:** The httpUrl should use `http://` here because you don't
   have a TLS cert yet. The CA operator updates it to `https://` after
   enrollment completes.

2. **Update your URL to HTTPS after enrollment:**

   ```bash
   icc config --set remotes.<your-identity>.httpUrl=https://<your-ip>:3179
   systemctl --user restart icc-server
   ```

### TLS gotchas

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

## 7. Configure Claude Code

Three things to set up for Claude Code integration.

### 7a. MCP Server

The MCP server config goes in `~/.claude.json` under the top-level
`mcpServers` key. Add the following (adjust the node path if needed):

```json
{
  "mcpServers": {
    "icc": {
      "type": "stdio",
      "command": "/usr/bin/node",
      "args": ["/home/<your-user>/code/inter-claude-connector/bin/icc-mcp.mjs"],
      "env": {}
    }
  }
}
```

**Gotcha:** The MCP config file is `~/.claude.json`, NOT
`~/.claude/.mcp.json` or `~/.claude/settings.json`.

Verify after setup with `/mcp` inside a Claude Code session.

### 7b. Lifecycle Hooks

Hooks go in `~/.claude/settings.json` under the `hooks` key. If `npm
link` wasn't used, replace `icc` with
`node ~/code/inter-claude-connector/bin/icc.mjs` in all commands.

```json
{
  "hooks": {
    "SessionStart": [
      { "matcher": "startup", "hooks": [{ "type": "command", "command": "icc hook startup 2>/dev/null || true" }] },
      { "matcher": "resume", "hooks": [{ "type": "command", "command": "icc hook startup 2>/dev/null || true" }] },
      { "matcher": "clear", "hooks": [{ "type": "command", "command": "icc hook startup 2>/dev/null || true" }] },
      { "matcher": "compact", "hooks": [{ "type": "command", "command": "icc hook check 2>/dev/null || true" }] }
    ],
    "UserPromptSubmit": [
      { "matcher": "", "hooks": [{ "type": "command", "command": "icc hook check 2>/dev/null || true" }] }
    ],
    "PostToolUse": [
      { "matcher": "", "hooks": [{ "type": "command", "command": "icc hook check 2>/dev/null || true" }] }
    ],
    "Stop": [
      { "matcher": "", "hooks": [{ "type": "command", "command": "icc hook shutdown" }] }
    ],
    "SessionEnd": [
      { "matcher": "", "hooks": [{ "type": "command", "command": "icc hook session-end 2>/dev/null || true" }] }
    ],
    "SubagentStart": [
      { "matcher": "", "hooks": [{ "type": "command", "command": "icc hook subagent-context 2>/dev/null || true" }] }
    ],
    "PreToolUse": [
      { "matcher": "Bash", "hooks": [{ "type": "command", "command": "icc hook pre-bash 2>/dev/null || true" }] },
      { "matcher": "mcp__icc__send_message|respond_to_message", "hooks": [{ "type": "command", "command": "icc hook pre-icc-message 2>/dev/null || true" }] }
    ]
  }
}
```

### 7c. CLAUDE.md (Watcher Instructions)

Create `~/.claude/CLAUDE.md` with instructions that tell Claude Code how
to handle the ICC mail watcher. Without this, the model won't launch or
re-launch the watcher.

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
```

## 8. Coordinate with Existing Peers

**If you used `icc join`:** This step is automatic — the CA pushes
mesh updates to all existing peers with bidirectional auth tokens.

**If you used manual setup:** Every existing peer needs your identity
added to their `remotes`. Send each peer operator:

- Your identity name
- Your IP address or hostname
- The outbound token you generated for them (from step 4b)

They will run on their end:

```bash
icc config --set remotes.<your-identity>.httpUrl=https://<your-ip>:3179
icc config --set remotes.<your-identity>.token=<token-you-gave-them>
systemctl --user restart icc-server
```

## 9. Verify

```bash
# Check ICC status
icc status

# Ping a specific peer
icc status --peer <peer-identity>

# Send a test prompt
icc send --peer <peer-identity> "Reply with: hello"
```

## 10. Updating ICC

When new code is available, pull and restart:

```bash
cd ~/code/inter-claude-connector
git pull
npm install
systemctl --user restart icc-server
```

If you use `npm link`, the `icc` CLI picks up changes automatically
after pulling. No need to re-link.

## Quick Reference: File Locations

| What | Where | Notes |
|------|-------|-------|
| ICC config | `~/.icc/config.json` | Identity, remotes, auth tokens, TLS |
| ICC server data | `~/.icc/` | messages.jsonl, inbox/, signal files |
| TLS certificates | `~/.icc/tls/` | ca.crt, server.crt, server.key |
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
icc tls status             # Show cert info (subject, issuer, expiry)
```

CA-only (run on the CA host):

```bash
icc tls init               # Initialize CA (one-time)
icc tls serve              # Start enrollment server (runs as systemd)
```

## Known Limitations

- **Server cert expiry:** Server certs are valid for 1 year.
  Re-enrollment (`icc tls enroll --ca <ca-host>`) regenerates the keypair
  and cert. The CA cert is valid for 10 years.
- **Web UI binds to localhost:** The web UI defaults to `127.0.0.1` and
  requires session auth with the `localToken`. Access from other machines
  requires a reverse proxy or SSH tunnel.

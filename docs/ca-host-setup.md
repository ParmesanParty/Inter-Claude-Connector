# Setting Up the CA Host

Guide for bootstrapping the first ICC host as the Certificate Authority
(CA). This is a one-time setup for the host that will sign TLS
certificates and run the enrollment server for all peers in the mesh.

If you're joining an existing mesh where a CA already exists, see
[`new-host-deployment.md`](new-host-deployment.md) instead.

---

## Prerequisites

### 1. Install system dependencies

The CA host needs the same dependencies as any ICC host: Git, Node.js
24, and C/C++ build tools (for the `better-sqlite3` native addon).

```bash
# Debian/Ubuntu
sudo apt-get update && sudo apt-get install -y git build-essential python3
```

Install Node.js 24 via NodeSource if not already present:

```bash
curl -fsSL https://deb.nodesource.com/setup_24.x | sudo -E bash -
sudo apt-get install -y nodejs
```

Verify and record the node path (systemd needs the absolute path):

```bash
node --version   # Should be v24.x.x
which node       # e.g. /usr/bin/node or ~/.nvm/versions/node/v24.x.x/bin/node
```

OpenSSL is also required (used by `icc tls init` for key/cert
generation). It's pre-installed on most Linux distributions:

```bash
openssl version
```

### 2. Install Claude Code

```bash
curl -fsSL https://claude.ai/install.sh | bash
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

### 4. npm link

```bash
cd ~/code/inter-claude-connector
sudo npm link
icc help   # verify
```

**Note:** If `sudo npm link` doesn't work, use
`node ~/code/inter-claude-connector/bin/icc.ts` directly in service
files and hooks.

---

## Initialize the CA host

### 5. Create ICC config

```bash
icc init --identity <your-identity>
```

Choose a short, memorable identity (e.g. `um890`, `server`, `ca`).
This generates `~/.icc/config.json` with a `localToken` for MCP/hooks
and web UI authentication.

### 6. Initialize the Certificate Authority

```bash
icc tls init
```

This creates three files in `~/.icc/tls/`:

| File | Purpose |
|------|---------|
| `ca.key` | CA private key — **keep secret**, never distribute |
| `ca.crt` | CA certificate — distributed to all peers during enrollment |
| `ca.srl` | Serial number file — managed automatically |

The CA certificate is valid for ~10 years. Peer certificates signed by
this CA are valid for 1 year (re-enroll to renew).

Verify:

```bash
icc tls status
# Should show: ca.crt with Subject: CN=ICC Root CA, valid ~10 years
```

### 7. Generate the CA host's own certificate

The CA host needs its own TLS certificate for mTLS, just like any peer.
Since the CA can't enroll itself through the normal HTTP-01 flow, use
`enroll-self` to generate the certificate locally:

```bash
icc tls enroll-self
```

This generates an Ed25519 keypair, creates a CSR, and signs it with the
local CA — all in one step. Only works on the CA host (requires
`ca.key`).

> **Troubleshooting:** If you get "This command is only available on the
> CA host" on the actual CA host, run `icc tls init` first to initialize
> the CA (step 6).

Enable TLS in config:

```bash
icc config --set server.tls.enabled=true
icc config --set server.tls.certPath=~/.icc/tls/server.crt
icc config --set server.tls.keyPath=~/.icc/tls/server.key
icc config --set server.tls.caPath=~/.icc/tls/ca.crt
icc config --set tls.ca=<your-identity>
```

---

## Create systemd services

The CA host runs three services:

| Service | Port | Purpose |
|---------|------|---------|
| `icc-server` | 3179 | Main ICC API server (HTTPS/mTLS) |
| `icc-enroll` | 4179 | TLS enrollment server (HTTP, for cert provisioning) |
| `icc-web` | 3180 | Web UI (HTTP, localhost only, optional) |

### 8. Create service files

```bash
mkdir -p ~/.config/systemd/user
```

Replace `<NODE_PATH>` with the output of `which node`, and `<USER>`
with your username in each file below.

**`~/.config/systemd/user/icc-server.service`:**

```ini
[Unit]
Description=Inter-Claude Connector Server
After=network.target

[Service]
Type=simple
ExecStart=<NODE_PATH> /home/<USER>/code/inter-claude-connector/bin/icc.ts serve
Restart=on-failure
WorkingDirectory=/home/<USER>/code/inter-claude-connector

[Install]
WantedBy=default.target
```

**`~/.config/systemd/user/icc-enroll.service`:**

```ini
[Unit]
Description=Inter-Claude Connector Enrollment Server
After=icc-server.service

[Service]
Type=simple
ExecStart=<NODE_PATH> /home/<USER>/code/inter-claude-connector/bin/icc.ts tls serve
Restart=on-failure
WorkingDirectory=/home/<USER>/code/inter-claude-connector

[Install]
WantedBy=default.target
```

**`~/.config/systemd/user/icc-web.service`** (optional):

```ini
[Unit]
Description=Inter-Claude Connector Web UI
After=icc-server.service

[Service]
Type=simple
ExecStart=<NODE_PATH> /home/<USER>/code/inter-claude-connector/bin/icc.ts web
Restart=on-failure
WorkingDirectory=/home/<USER>/code/inter-claude-connector

[Install]
WantedBy=default.target
```

### 9. Enable and start services

```bash
loginctl enable-linger $(whoami)
systemctl --user daemon-reload
systemctl --user enable --now icc-server icc-enroll
```

Optionally enable the web UI:

```bash
systemctl --user enable --now icc-web
```

Verify:

```bash
systemctl --user status icc-server --no-pager
# Should see: "ICC server listening on HTTPS (mTLS) 0.0.0.0:3179"

systemctl --user status icc-enroll --no-pager
# Should see enrollment server listening on port 4179

journalctl --user -u icc-server -n 5 --no-pager
journalctl --user -u icc-enroll -n 5 --no-pager
```

---

## Configure Claude Code

Open a Claude Code session in `~/code/inter-claude-connector` and
prompt:

> Read docs/claude-code-setup.md and configure ICC integration on this
> host.

See [`docs/claude-code-setup.md`](claude-code-setup.md) for the full
configuration reference if you prefer to set up manually.

---

## Invite the first peer

Once the CA host is running, invite peers using:

```bash
icc invite <peer-identity> --ip <peer-ip>
```

This:
- Adds the peer to `remotes` (initially as `http://`)
- Generates bidirectional auth tokens
- Registers a one-time join token with the enrollment server (valid 15
  minutes)
- Prints the `icc join` command for the peer to run

The peer follows [Path A in the deployment guide](new-host-deployment.md#path-a-quick-onboarding-recommended).
After they run `icc join`, the CA automatically:
- Signs their certificate
- Pushes mesh updates to all existing peers
- Upgrades their remote URL to `https://`

Verify connectivity after the peer joins:

```bash
icc status --peer <peer-identity>
```

---

## Enrollment server details

The enrollment server runs on port 4179 (plain HTTP — intentionally
unencrypted since enrolling peers don't have certificates yet).

### Endpoints

| Endpoint | Purpose |
|----------|---------|
| `POST /enroll` | Request a challenge for a known peer |
| `POST /enroll/csr` | Submit CSR, receive signed certificate |
| `POST /enroll/join` | Join protocol step 1 (with join token) |
| `POST /enroll/join/complete` | Join protocol step 2 (submit CSR) |
| `POST /enroll/reload` | Reload peer config (auth required) |
| `POST /enroll/register-invite` | Store join token (auth required) |

### Rate limiting

Per-identity: max 3 enrollment attempts per 15 minutes. Returns HTTP
429 with `Retry-After` header when exceeded.

### Challenge flow

1. Peer requests enrollment → server generates random challenge (5-min
   TTL)
2. Peer writes challenge to `~/.icc/tls/.challenge`
3. Peer's ICC server serves it at `GET /.well-known/icc-challenge`
4. Enrollment server fetches challenge from peer's httpUrl to verify
   proof of control
5. On success, signs the CSR and returns the certificate + CA cert

---

## Operational notes

- **Restarting after config changes:** After `icc invite`, the
  enrollment server reloads automatically (via `/enroll/reload`). You
  do not need to restart `icc-enroll`. You may need to restart
  `icc-server` if TLS config or remotes changed.

- **Certificate renewal:** Peer certs expire after 1 year. Peers
  re-enroll with `icc tls enroll --ca <ca-identity>` to get a new cert.
  The CA cert is valid for 10 years.

- **CA key security:** The `ca.key` file is the root of trust for the
  entire mesh. Protect it accordingly. If compromised, all peer
  certificates must be re-issued.

- **Web UI:** Binds to `127.0.0.1` by default. Access from other
  machines requires an SSH tunnel or reverse proxy. Authenticates with
  the `localToken` via session cookie.

- **Mesh updates:** When a new peer joins via `icc join`, the enrollment
  server pushes `POST /api/mesh-update` to all existing peers. This
  endpoint is CA-only (verified by `config.tls.ca`) and adds the new
  peer's remote config and auth tokens automatically.

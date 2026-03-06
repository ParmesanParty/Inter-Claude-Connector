/**
 * Setup wizard — temporary HTTP server with inline HTML UI.
 * Runs on :3179 until configuration is complete, then hands off to the real server.
 */

import { createServer } from 'node:http';
import type { IncomingMessage, ServerResponse, Server } from 'node:http';
import { randomBytes } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { createLogger } from '../src/util/logger.ts';
import { readBody, sendJSON } from '../src/util/http.ts';

const log = createLogger('wizard');

interface WizardOptions {
  host?: string;
  port?: number;
  onComplete: () => Promise<void>;
}

export async function startSetupWizard(options: WizardOptions): Promise<void> {
  const { host = '0.0.0.0', port = 3179, onComplete } = options;
  const tlsDir = join(homedir(), '.icc', 'tls');

  // Dynamic challenge route (added during join flow)
  let activeChallenge: string | null = null;

  const server: Server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    const method = req.method || 'GET';
    const url = (req.url || '').split('?')[0]!;

    // CORS headers for wizard
    const corsHeaders: Record<string, string> = {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    };

    if (method === 'OPTIONS') {
      res.writeHead(204, corsHeaders);
      res.end();
      return;
    }

    // Health check — keeps Docker healthcheck green during setup
    if (method === 'GET' && url === '/api/health') {
      sendJSON(res, 200, { status: 'setup', mode: 'wizard' }, corsHeaders);
      return;
    }

    // Setup status
    if (method === 'GET' && url === '/setup/status') {
      sendJSON(res, 200, { configured: false }, corsHeaders);
      return;
    }

    // Challenge endpoint (for join flow — CA verifies this)
    if (method === 'GET' && url === '/.well-known/icc-challenge') {
      if (activeChallenge) {
        res.writeHead(200, { 'Content-Type': 'text/plain', ...corsHeaders });
        res.end(activeChallenge);
      } else {
        sendJSON(res, 404, { error: 'No active challenge' }, corsHeaders);
      }
      return;
    }

    // Ping connectivity check (proxy to avoid CORS issues)
    if (method === 'GET' && url === '/setup/ping') {
      const queryUrl = new URL(req.url || '/', 'http://localhost');
      const targetHost = queryUrl.searchParams.get('host');
      const targetPort = queryUrl.searchParams.get('port') || '4179';

      if (!targetHost) {
        sendJSON(res, 400, { error: 'Missing host param' }, corsHeaders);
        return;
      }

      try {
        const { httpJSON } = await import('../src/util/http.ts');
        const result = await httpJSON(`http://${targetHost}:${targetPort}/health`, 'GET', null);
        sendJSON(res, 200, { reachable: true, result }, corsHeaders);
      } catch (err) {
        sendJSON(res, 200, { reachable: false, error: (err as Error).message }, corsHeaders);
      }
      return;
    }

    // Initialize as CA
    if (method === 'POST' && url === '/setup/init-ca') {
      try {
        const body = JSON.parse(await readBody(req));
        const { identity } = body;

        if (!identity || identity === 'unnamed') {
          sendJSON(res, 400, { error: 'Identity is required and cannot be "unnamed"' }, corsHeaders);
          return;
        }

        const { loadConfig, writeConfig, clearConfigCache } = await import('../src/config.ts');
        const { initCA, generateKeyAndCSR, signCSR } = await import('../src/tls.ts');

        // Generate local token
        const localToken = randomBytes(32).toString('hex');

        // Load and update config
        clearConfigCache();
        const config = loadConfig();
        config.identity = identity;
        config.server.localToken = localToken;
        writeConfig(config);

        // Initialize CA
        mkdirSync(tlsDir, { recursive: true });
        initCA(tlsDir);

        // Generate server cert
        const csr = generateKeyAndCSR(tlsDir, identity);
        const cert = signCSR(tlsDir, csr, identity);

        // Write server cert
        writeFileSync(join(tlsDir, 'server.crt'), cert);

        // Update config with TLS
        clearConfigCache();
        const updatedConfig = loadConfig();
        updatedConfig.server.tls = {
          enabled: true,
          certPath: join(tlsDir, 'server.crt'),
          keyPath: join(tlsDir, 'server.key'),
          caPath: join(tlsDir, 'ca.crt'),
        };
        updatedConfig.tls = { ca: identity };
        writeConfig(updatedConfig);

        log.info(`CA initialized for identity "${identity}"`);

        sendJSON(res, 200, { ok: true, identity, localToken }, corsHeaders);

        // Stop wizard and transition to normal mode
        server.close(async () => {
          await onComplete();
        });
      } catch (err) {
        log.error(`Init CA failed: ${(err as Error).message}`);
        sendJSON(res, 500, { error: (err as Error).message }, corsHeaders);
      }
      return;
    }

    // Join existing mesh
    if (method === 'POST' && url === '/setup/join') {
      try {
        const body = JSON.parse(await readBody(req));
        const { identity, caHost, caPort, joinToken, caIdentity, ownIp } = body;

        if (!identity || !caHost || !joinToken || !caIdentity) {
          sendJSON(res, 400, { error: 'Missing required fields: identity, caHost, joinToken, caIdentity' }, corsHeaders);
          return;
        }

        const { loadConfig, writeConfig, clearConfigCache } = await import('../src/config.ts');
        const { generateKeyAndCSR } = await import('../src/tls.ts');
        const { httpJSON } = await import('../src/util/http.ts');

        // Generate local token
        const localToken = randomBytes(32).toString('hex');

        // Load and update config
        clearConfigCache();
        const config = loadConfig();
        config.identity = identity;
        config.server.localToken = localToken;
        writeConfig(config);

        // Phase 1: Generate key + CSR
        mkdirSync(tlsDir, { recursive: true });
        const csr = generateKeyAndCSR(tlsDir, identity);

        // Phase 2: Join via CA
        const enrollPort = caPort || 4179;
        const caUrl = `http://${caHost}:${enrollPort}`;
        const ownPort = config.server.port;
        const httpUrl = ownIp ? `http://${ownIp}:${ownPort}` : `http://0.0.0.0:${ownPort}`;

        const joinRes = await httpJSON(`${caUrl}/enroll/join`, 'POST', {
          identity,
          joinToken,
          httpUrl,
        });

        if (!joinRes.enrollmentId) {
          sendJSON(res, 500, { error: joinRes.error || 'Join failed' }, corsHeaders);
          return;
        }

        // Set challenge for CA to verify
        activeChallenge = joinRes.challenge;

        // Phase 3: Submit CSR
        const result = await httpJSON(`${caUrl}/enroll/join/complete`, 'POST', {
          enrollmentId: joinRes.enrollmentId,
          csr,
        });

        activeChallenge = null;

        if (!result.cert) {
          sendJSON(res, 500, { error: result.error || 'Join completion failed' }, corsHeaders);
          return;
        }

        // Phase 4: Write certs and configure
        writeFileSync(join(tlsDir, 'server.crt'), result.cert);
        writeFileSync(join(tlsDir, 'ca.crt'), result.caCert);

        clearConfigCache();
        const updatedConfig = loadConfig();
        updatedConfig.server.tls = {
          enabled: true,
          certPath: join(tlsDir, 'server.crt'),
          keyPath: join(tlsDir, 'server.key'),
          caPath: join(tlsDir, 'ca.crt'),
        };

        if (!updatedConfig.remotes) updatedConfig.remotes = {};
        if (!updatedConfig.server.peerTokens) updatedConfig.server.peerTokens = {};
        const peers: string[] = [];
        for (const peer of result.peers || []) {
          updatedConfig.remotes[peer.identity] = {
            httpUrl: peer.httpsUrl,
            token: peer.outboundToken,
          };
          updatedConfig.server.peerTokens[peer.identity] = peer.inboundToken;
          peers.push(peer.identity);
        }

        updatedConfig.tls = { ca: caIdentity };
        writeConfig(updatedConfig);

        log.info(`Joined mesh as "${identity}" via CA "${caIdentity}"`);

        sendJSON(res, 200, { ok: true, identity, localToken, peers }, corsHeaders);

        // Stop wizard and transition to normal mode
        server.close(async () => {
          await onComplete();
        });
      } catch (err) {
        log.error(`Join failed: ${(err as Error).message}`);
        sendJSON(res, 500, { error: (err as Error).message }, corsHeaders);
      }
      return;
    }

    // Wizard HTML UI
    if (method === 'GET' && (url === '/' || url === '/index.html')) {
      res.writeHead(200, { 'Content-Type': 'text/html', ...corsHeaders });
      res.end(getWizardHTML());
      return;
    }

    sendJSON(res, 404, { error: 'Not found' }, corsHeaders);
  });

  return new Promise<void>((resolve) => {
    server.listen(port, host, () => {
      log.info(`Setup wizard listening on ${host}:${port}`);
      resolve();
    });
  });
}

function getWizardHTML(): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>ICC Setup</title>
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body {
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    background: #0f1419;
    color: #e7e9ea;
    min-height: 100vh;
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 2rem;
  }
  .container { max-width: 800px; width: 100%; }
  h1 { text-align: center; margin-bottom: 0.5rem; font-size: 1.8rem; color: #fff; }
  .subtitle { text-align: center; color: #71767b; margin-bottom: 2rem; }
  .cards { display: grid; grid-template-columns: 1fr 1fr; gap: 1.5rem; }
  @media (max-width: 600px) { .cards { grid-template-columns: 1fr; } }
  .card {
    background: #16202a;
    border: 1px solid #2f3336;
    border-radius: 12px;
    padding: 1.5rem;
  }
  .card h2 { font-size: 1.1rem; margin-bottom: 0.5rem; }
  .card p { color: #71767b; font-size: 0.9rem; margin-bottom: 1rem; line-height: 1.4; }
  label { display: block; font-size: 0.85rem; color: #8b98a5; margin-bottom: 0.25rem; margin-top: 0.75rem; }
  input {
    width: 100%;
    padding: 0.5rem 0.75rem;
    background: #0f1419;
    border: 1px solid #2f3336;
    border-radius: 6px;
    color: #e7e9ea;
    font-size: 0.9rem;
  }
  input:focus { outline: none; border-color: #1d9bf0; }
  button {
    width: 100%;
    padding: 0.6rem;
    margin-top: 1rem;
    background: #1d9bf0;
    color: #fff;
    border: none;
    border-radius: 6px;
    font-size: 0.9rem;
    cursor: pointer;
    font-weight: 600;
  }
  button:hover { background: #1a8cd8; }
  button:disabled { background: #2f3336; cursor: not-allowed; }
  .error { color: #f4212e; font-size: 0.85rem; margin-top: 0.5rem; }
  .success { color: #00ba7c; font-size: 0.85rem; margin-top: 0.5rem; }
  .result-box {
    background: #0f1419;
    border: 1px solid #2f3336;
    border-radius: 6px;
    padding: 1rem;
    margin-top: 1rem;
    font-family: monospace;
    font-size: 0.85rem;
    word-break: break-all;
  }
  .result-box label { margin-top: 0; }
  .hidden { display: none; }
  .spinner { display: inline-block; width: 16px; height: 16px; border: 2px solid #2f3336; border-top-color: #1d9bf0; border-radius: 50%; animation: spin 0.8s linear infinite; vertical-align: middle; margin-right: 0.5rem; }
  @keyframes spin { to { transform: rotate(360deg); } }
</style>
</head>
<body>
<div class="container">
  <h1>Inter-Claude Connector</h1>
  <p class="subtitle">First-time setup &mdash; choose how to initialize this host</p>

  <div id="setup-cards" class="cards">
    <div class="card">
      <h2>Create New Mesh</h2>
      <p>Initialize this host as the Certificate Authority. Other hosts will join this mesh.</p>
      <label for="ca-identity">Host Identity</label>
      <input type="text" id="ca-identity" placeholder="e.g. server, um890, homelab">
      <button id="btn-init-ca" onclick="initCA()">Initialize CA</button>
      <div id="ca-error" class="error hidden"></div>
      <div id="ca-loading" class="hidden"><span class="spinner"></span> Initializing...</div>
    </div>

    <div class="card" id="join-card">
      <h2>Join Existing Mesh</h2>
      <p>Join a mesh managed by another host.</p>

      <div id="join-step1">
        <label for="join-identity">This Host's Identity</label>
        <input type="text" id="join-identity" placeholder="e.g. laptop, rpi0">
        <button id="btn-join-next" onclick="joinStep1()">Next</button>
      </div>

      <div id="join-step2" class="hidden">
        <div style="margin-bottom: 0.75rem;">
          <span style="color: #8b98a5; font-size: 0.85rem;">Identity:</span>
          <span id="join-identity-display" style="font-weight: 600;"></span>
        </div>

        <p style="color: #8b98a5; font-size: 0.85rem; margin-bottom: 0.25rem;">
          Run this on the CA host:
        </p>
        <div id="join-invite-cmd" style="background: #0f1419; border: 1px solid #2f3336; border-radius: 6px; padding: 0.75rem 1rem; font-family: monospace; font-size: 0.85rem; color: #e7e9ea; cursor: pointer; margin-bottom: 1rem;" onclick="navigator.clipboard.writeText(this.innerText.trim())" title="Click to copy"></div>

        <label for="join-setup-string">Paste the setup string from <code style="color: #e7e9ea;">icc invite</code></label>
        <input type="text" id="join-setup-string" placeholder="icc:eyJ..." oninput="onSetupStringInput()">

        <div id="join-ca-host-row" class="hidden">
          <label for="join-ca-host-from-setup">CA Host Address (IP or hostname)</label>
          <input type="text" id="join-ca-host-from-setup" placeholder="e.g. 192.168.1.100 or server.local">
        </div>

        <div id="join-own-host-row" class="hidden">
          <label for="join-own-host">This Host's Address (IP or hostname, reachable by CA)</label>
          <input type="text" id="join-own-host" placeholder="e.g. 192.168.1.101 or myhost.local">
        </div>

        <button id="btn-join" onclick="joinMesh()">Join Mesh</button>

        <details style="margin-top: 0.75rem;">
          <summary style="color: #71767b; font-size: 0.85rem; cursor: pointer;">Manual configuration (advanced)</summary>
          <div style="margin-top: 0.5rem;">
            <label for="join-ca-identity">CA Host Identity</label>
            <input type="text" id="join-ca-identity" placeholder="e.g. server">
            <label for="join-ca-host">CA Host Address</label>
            <input type="text" id="join-ca-host" placeholder="e.g. 192.168.1.100 or server.local">
            <label for="join-ca-port">CA Enrollment Port</label>
            <input type="text" id="join-ca-port" value="4179">
            <label for="join-token">Join Token</label>
            <input type="text" id="join-token" placeholder="Token from icc invite">
            <label for="join-manual-own-host">This Host's Address</label>
            <input type="text" id="join-manual-own-host" placeholder="e.g. 192.168.1.101 or myhost.local">
          </div>
        </details>
      </div>

      <div id="join-error" class="error hidden"></div>
      <div id="join-loading" class="hidden"><span class="spinner"></span> Joining mesh...</div>
    </div>
  </div>

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
</div>

<script>
async function initCA() {
  const identity = document.getElementById('ca-identity').value.trim();
  if (!identity) { showError('ca-error', 'Identity is required'); return; }

  hideError('ca-error');
  setLoading('btn-init-ca', 'ca-loading', true);

  try {
    const res = await fetch('/setup/init-ca', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ identity }),
    });
    const data = await res.json();
    if (!res.ok || !data.ok) throw new Error(data.error || 'Init failed');
    showSuccess(data.identity, data.localToken);
  } catch (err) {
    showError('ca-error', err.message);
    setLoading('btn-init-ca', 'ca-loading', false);
  }
}

function joinStep1() {
  const identity = document.getElementById('join-identity').value.trim();
  if (!identity) { showError('join-error', 'Identity is required'); return; }
  hideError('join-error');

  document.getElementById('join-identity-display').textContent = identity;
  document.getElementById('join-invite-cmd').textContent = 'icc invite ' + identity;
  document.getElementById('join-step1').classList.add('hidden');
  document.getElementById('join-step2').classList.remove('hidden');
}

function parseSetupString(raw) {
  const str = raw.trim();
  if (!str.startsWith('icc:')) return null;
  try {
    // base64url → base64 → decode
    const b64 = str.slice(4).replace(/-/g, '+').replace(/_/g, '/');
    const json = atob(b64);
    const data = JSON.parse(json);
    if (!data.caIdentity || !data.joinToken) return null;
    return data;
  } catch { return null; }
}

function onSetupStringInput() {
  const raw = document.getElementById('join-setup-string').value;
  const parsed = parseSetupString(raw);
  if (parsed && !parsed.caHost) {
    document.getElementById('join-ca-host-row').classList.remove('hidden');
  } else {
    document.getElementById('join-ca-host-row').classList.add('hidden');
  }
  if (parsed && !parsed.host) {
    document.getElementById('join-own-host-row').classList.remove('hidden');
  } else {
    document.getElementById('join-own-host-row').classList.add('hidden');
  }
}

async function joinMesh() {
  const identity = document.getElementById('join-identity').value.trim();
  const setupRaw = document.getElementById('join-setup-string').value.trim();

  let caIdentity, caHost, caPort, joinToken, ownHost;

  const parsed = parseSetupString(setupRaw);
  if (parsed) {
    // Setup string path
    caIdentity = parsed.caIdentity;
    caHost = parsed.caHost || document.getElementById('join-ca-host-from-setup').value.trim();
    caPort = parsed.caPort || 4179;
    joinToken = parsed.joinToken;
    ownHost = parsed.host || document.getElementById('join-own-host').value.trim();
  } else if (setupRaw === '') {
    // Manual path — read from manual fields
    caIdentity = document.getElementById('join-ca-identity').value.trim();
    caHost = document.getElementById('join-ca-host').value.trim();
    caPort = parseInt(document.getElementById('join-ca-port').value.trim()) || 4179;
    joinToken = document.getElementById('join-token').value.trim();
    ownHost = document.getElementById('join-manual-own-host').value.trim();
  } else {
    showError('join-error', 'Invalid setup string. It should start with "icc:" — check that you copied the full string.');
    return;
  }

  if (!identity || !caIdentity || !caHost || !joinToken) {
    showError('join-error', parsed ? 'Invalid setup string — missing required fields' : 'All fields except port and address are required');
    return;
  }

  hideError('join-error');
  setLoading('btn-join', 'join-loading', true);

  try {
    const res = await fetch('/setup/join', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ identity, caHost, caPort, joinToken, caIdentity, ownIp: ownHost }),
    });
    const data = await res.json();
    if (!res.ok || !data.ok) throw new Error(data.error || 'Join failed');
    showSuccess(data.identity, data.localToken, data.peers);
  } catch (err) {
    showError('join-error', err.message);
    setLoading('btn-join', 'join-loading', false);
  }
}

function showError(id, msg) {
  const el = document.getElementById(id);
  el.textContent = msg;
  el.classList.remove('hidden');
}

function hideError(id) {
  document.getElementById(id).classList.add('hidden');
}

function setLoading(btnId, loadingId, loading) {
  document.getElementById(btnId).disabled = loading;
  const el = document.getElementById(loadingId);
  if (loading) el.classList.remove('hidden');
  else el.classList.add('hidden');
}

function showSuccess(identity, token, peers) {
  document.getElementById('setup-cards').classList.add('hidden');
  document.getElementById('success-screen').classList.remove('hidden');
  document.getElementById('result-identity').textContent = identity;
  document.getElementById('result-token').textContent = token;
  if (peers && peers.length > 0) {
    document.getElementById('result-peers-section').classList.remove('hidden');
    document.getElementById('result-peers').textContent = peers.join(', ');
  }
}
</script>
</body>
</html>`;
}

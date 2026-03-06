# Wizard Join Flow Redesign Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Make "Join Existing Mesh" frictionless with a self-contained setup string from `icc invite`, while preserving manual field entry as a fallback.

**Architecture:** `icc invite` generates a base64url-encoded JSON setup string (`icc:eyJ...`). The wizard's Join card becomes a two-step flow: collect identity, then paste setup string. Manual fields collapse into `<details>`. The enrollment protocol and `POST /setup/join` backend are unchanged.

**Tech Stack:** TypeScript (Node.js CLI + wizard server), HTML/JS (wizard UI)

---

### Task 1: Update `icc invite` — rename `--ip` to `--host`, make optional, output setup string

**Files:**
- Modify: `bin/icc.ts:1213-1284` (invite function)
- Modify: `bin/icc.ts:1425` (help text)

**Step 1: Update the invite function**

Replace the entire `invite()` function (lines 1213-1284) in `bin/icc.ts`:

```typescript
async function invite(): Promise<void> {
  const identity = positional[0];
  if (!identity) {
    console.error('Usage: icc invite <identity> [--host <address>] [--port 3179]');
    process.exit(1);
  }

  // Accept --host or --ip (backwards compat alias)
  const host = (flags.host || flags.ip) as string | undefined;

  const peerPort = flags.port ? parseInt(flags.port as string, 10) : 3179;
  const { loadConfig, writeConfig, clearConfigCache, getLocalToken } = await import('../src/config.ts');
  clearConfigCache();
  const config = loadConfig();

  // Guard: self-invite
  if (identity === config.identity) {
    console.error(`Cannot invite yourself ("${identity}" is this host's identity).`);
    process.exit(1);
  }

  // Guard: existing peer
  if (config.remotes?.[identity] && !flags.force) {
    console.error(`Peer "${identity}" already exists in remotes.`);
    console.error('Re-inviting regenerates the peer token, breaking the existing connection.');
    console.error('Use --force to proceed anyway.');
    process.exit(1);
  }

  // 1. Add remote with http:// URL (will be upgraded to https after enrollment)
  if (!config.remotes) config.remotes = {};
  if (host) {
    config.remotes[identity] = { httpUrl: `http://${host}:${peerPort}` };
  }

  // 2. Generate peerToken for inbound auth from new host
  if (!config.server.peerTokens) config.server.peerTokens = {};
  const peerToken = randomBytes(32).toString('hex');
  config.server.peerTokens[identity] = peerToken;

  // 3. Generate join token
  const joinToken = randomBytes(32).toString('hex');

  // 4. Save config
  writeConfig(config);
  if (host) {
    console.log(`Added ${identity} to remotes (http://${host}:${peerPort})`);
  }
  console.log(`Generated peer token for ${identity}`);

  // 5. Notify enrollment server to reload config
  const enrollPort = config.server.enrollPort;
  const localToken = getLocalToken(config);
  try {
    await httpJSON(`http://127.0.0.1:${enrollPort}/enroll/reload`, 'POST', {}, localToken);
    console.log('Enrollment server reloaded');
  } catch {
    console.log('Note: enrollment server not running or reload failed — restart manually');
  }

  // 6. Register join token with enrollment server
  try {
    await httpJSON(`http://127.0.0.1:${enrollPort}/enroll/register-invite`, 'POST', {
      identity, joinToken, ip: host || '0.0.0.0', port: peerPort,
    }, localToken);
    console.log('Join token registered with enrollment server');
  } catch {
    console.log('Note: could not register join token — enrollment server may not be running');
  }

  // 7. Build setup string
  const setupPayload: Record<string, unknown> = {
    caIdentity: config.identity,
    caHost: host ? host : '0.0.0.0',
    caPort: enrollPort,
    joinToken,
  };
  if (host) setupPayload.host = host;
  const setupString = 'icc:' + Buffer.from(JSON.stringify(setupPayload)).toString('base64url');

  console.log(`\nSetup string (paste into the setup wizard on the new host):`);
  console.log(`  ${setupString}`);
  console.log(`\nOr run on ${identity}:`);
  console.log(`  icc join --ca ${config.identity} --token ${joinToken}`);
}
```

**Step 2: Update the help text**

In `bin/icc.ts`, find the help text line (around line 1425):

```
  invite <identity> --ip <ip> [--port N]  Generate join token for new host (CA only)
```

Replace with:

```
  invite <identity> [--host <addr>] [--port N]  Generate join token for new host (CA only)
```

**Step 3: Verify syntax**

Run: `node -e "import('./bin/icc.ts')"`
Expected: No errors

**Step 4: Commit**

```bash
git add bin/icc.ts
git commit -m "feat: icc invite outputs setup string, --ip renamed to --host (optional)

Setup string is base64url-encoded JSON with icc: prefix. Contains
caIdentity, caHost, caPort, joinToken, and optionally host.
--ip kept as silent alias for backwards compatibility."
```

---

### Task 2: Restructure wizard Join card HTML — two-step flow

**Files:**
- Modify: `docker/wizard.ts:367-385` (Join card HTML)

**Step 1: Replace the Join card HTML**

In `docker/wizard.ts`, replace the Join card (the `<div class="card">` starting at line 367 through the closing `</div>` at line 385) with:

```html
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
```

**Step 2: Verify no syntax errors**

Run: `node -e "import('./docker/wizard.ts')"`
Expected: No errors

**Step 3: Commit**

```bash
git add docker/wizard.ts
git commit -m "feat: wizard Join card restructured as two-step flow

Step 1: collect identity and show icc invite command.
Step 2: paste setup string or use manual fallback fields."
```

---

### Task 3: Rewrite wizard JavaScript — setup string parsing and two-step logic

**Files:**
- Modify: `docker/wizard.ts:459-487` (joinMesh function in `<script>`)

**Step 1: Replace the joinMesh function and add helpers**

In `docker/wizard.ts`, replace the `joinMesh()` function (lines 459-487) with these three functions:

```javascript
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
    caHost = parsed.caHost;
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
```

Note: The `POST /setup/join` backend already accepts `ownIp` as a field name and uses it for the `httpUrl` parameter. Passing a hostname there works fine — it gets used as `http://${ownIp}:${port}` which resolves correctly.

**Step 2: Verify no syntax errors**

Run: `node -e "import('./docker/wizard.ts')"`
Expected: No errors

**Step 3: Commit**

```bash
git add docker/wizard.ts
git commit -m "feat: wizard JS handles setup string parsing and two-step join flow

parseSetupString() decodes icc: base64url strings. joinMesh() uses
setup string fields with fallback to manual form inputs. Shows own
address field only when setup string lacks host."
```

---

### Task 4: Run tests and manual verification

**Step 1: Run the full test suite**

Run: `node --test test/*.test.ts`
Expected: All tests pass (no test changes needed — the wizard isn't unit-tested, and the backend `POST /setup/join` endpoint is unchanged)

**Step 2: Verify `icc invite` output**

If an ICC server with enrollment is running locally:

```bash
node bin/icc.ts invite testhost --host 192.168.1.50 2>&1 || true
```

Expected output should include:
```
Setup string (paste into the setup wizard on the new host):
  icc:eyJ...
```

Verify the setup string decodes correctly:

```bash
node -e "
  const str = process.argv[1].slice(4);
  console.log(JSON.parse(Buffer.from(str, 'base64url').toString()));
" "PASTE_STRING_HERE"
```

**Step 3: Verify wizard loads**

Run: `node -e "import('./docker/wizard.ts')"`
Expected: No errors

**Step 4: Commit (if any fixups needed)**

```bash
git add -A
git commit -m "fix: address issues from wizard join flow verification"
```

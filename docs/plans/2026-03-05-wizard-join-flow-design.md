# Wizard Join Flow Redesign

**Goal:** Make "Join Existing Mesh" frictionless by using a self-contained setup string from `icc invite`, while keeping manual field entry as a fallback.

**Architecture:** `icc invite` generates a base64url-encoded setup string containing all join parameters. The wizard's Join card becomes a two-step flow: collect identity → paste setup string. Manual fields collapse into a `<details>` fallback.

## Setup String Format

Base64url-encoded JSON with an `icc:` prefix:

```
icc:eyJjYUlkZW50aXR5IjoidW04OTAiLC...
```

Decoded:
```json
{
  "caIdentity": "um890",
  "caHost": "192.168.64.32",
  "caPort": 4179,
  "joinToken": "abc123...",
  "host": "192.168.64.100"
}
```

- `host` is optional — present only if the CA operator provided `--host` to `icc invite`
- `icc:` prefix makes it visually distinct and enables quick validation
- Base64url (no padding) is clipboard-friendly — no `+`, `/`, or `=`

## `icc invite` Changes

Current: `icc invite <identity> --ip <ip> [--port 3179]`
New: `icc invite <identity> [--host <address>] [--port 3179]`

- Rename `--ip` to `--host` (IP or resolvable hostname). Keep `--ip` as silent alias.
- `--host` becomes optional. If omitted, the setup string has no `host` field and the wizard prompts for it.
- New output after existing console lines:

```
Setup string (paste into the setup wizard on the new host):
  icc:eyJ...

Or run on the new host:
  icc join --ca um890 --token abc123...
```

## Wizard Join Flow

### Step 1: Collect Identity

The Join card initially shows:
- "This Host's Identity" input field
- "Next" button

### Step 2: Paste Setup String and Join

After clicking Next, the card shows:
- Identity locked/displayed (not editable)
- Copyable `icc invite <identity>` command for the CA operator
- Paste field for the setup string
- "Own Address" field — shown only if the setup string lacks `host`
- "Join Mesh" button
- Collapsed `<details>` "Manual configuration (advanced)" with raw fields: CA identity, CA host, CA port, join token, own address

### Join Execution

On "Join Mesh":
1. If setup string present: decode `icc:` prefix + base64url, extract fields
2. If `host` missing from string and not entered manually: show error, reveal address field
3. Submit to existing `POST /setup/join` endpoint (no backend changes needed)

Manual fallback submits the same POST with manually-entered fields.

## Files Modified

1. `bin/icc.ts` — `invite()`: rename `--ip` → `--host` (with alias), make optional, output setup string
2. `docker/wizard.ts` — restructure Join card HTML + JS, add setup string decoding

## Files Not Modified

- `src/enroll.ts` — enrollment protocol unchanged
- `icc join` CLI — unchanged, still works for bare-metal

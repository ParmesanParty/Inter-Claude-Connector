# Sub-project B: Unified /sync Skill + Version Drift Detection — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make every ICC host (bare-metal and Docker) able to reconcile its Claude Code integration files against a single source of truth — the local ICC server's /setup/claude-code endpoint — via a /sync slash skill, with version drift automatically announced on every SessionStart and hand-edited files protected from silent clobber.

**Architecture:** Five phases. (1) Unify the /setup/claude-code payload across modes by detecting Docker vs bare-metal and emitting mode-appropriate hooks and skills content. (2) Content-hash the payload and piggyback the version on the existing /api/hook/startup response so the hook can detect drift cheaply. (3) Add a src/manifest.ts module for the per-host applied-config manifest, plus owned-region hash helpers (JSON subtree, CLAUDE.md marker region, whole file). (4) Add a new `icc hook sync` CLI subcommand (bare-metal) and a curl-based /sync skill template (Docker). (5) Add CLAUDE.md sentinel marker support with idempotent first-sync migration.

**Tech Stack:** Node.js `node:http`/`node:https`, `node:crypto` for SHA-256 hashing, Node's built-in test runner, existing test helpers in `test/helpers.ts`, `jq` in shell templates (common dependency on both Debian/Raspbian and the container).

**Related spec:** `docs/superpowers/specs/2026-04-07-sync-skill-and-version-drift-design.md`

---

## File structure

| Path | Responsibility | Action |
|---|---|---|
| `src/setup-config.ts` | Payload builder + mode detection + canonical JSON serializer + content hashing. Shared by /setup/claude-code and /api/hook/startup. | Create |
| `src/manifest.ts` | Applied-config manifest read/write + per-file owned-region hash helpers. Used by `icc hook sync` and `hook startup`. | Create |
| `src/server.ts` | /setup/claude-code + /api/hook/startup handlers wired to the new payload builder | Modify |
| `bin/icc.ts` | `hook startup` drift detection; new `hook sync` subcommand; `hookGet` (from plan C) reused | Modify |
| `docs/claude-code-setup.md` | Marker-wrapped CLAUDE.md §3, /sync skill added to §4, banner noting server is authoritative | Modify |
| `docs/docker.md` | Same updates for Docker flow | Modify |
| `docker/wizard.ts` | Wizard completion page mentions /sync for ongoing reconciliation | Modify |
| `test/setup-config.test.ts` | Canonical JSON, hash determinism, mode detection, per-mode content | Create |
| `test/manifest.test.ts` | Manifest read/write, atomic writes, per-file hash classification | Create |
| `test/server.test.ts` | /setup/claude-code new fields (version, restartCategories); /api/hook/startup drifted flag | Modify (append) |
| `test/hooks.test.ts` | `hook startup` drift hint; `hook sync` behavior | Modify (append) |

---

## Phase 1 — Unified payload builder with mode detection

### Task 1: Create `src/setup-config.ts` skeleton with mode detection

**Files:**
- Create: `src/setup-config.ts`
- Test: `test/setup-config.test.ts`

- [ ] **Step 1: Write the failing test**

Create `test/setup-config.test.ts`:

```ts
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { detectMode, type HostMode } from '../src/setup-config.ts';
import type { ICCConfig } from '../src/types.ts';

const baseConfig = (overrides: Partial<ICCConfig['server']> = {}): ICCConfig => ({
  identity: 'test-host',
  server: { port: 3179, localToken: 'tok', peerTokens: {}, ...overrides },
  remotes: {},
  tls: { enabled: false, caPath: '', certPath: '', keyPath: '' },
  web: { enabled: false, host: '127.0.0.1', port: 3180 },
} as unknown as ICCConfig);

describe('setup-config: detectMode', () => {
  it('returns "docker" when localhostHttpPort is set', () => {
    const config = baseConfig({ localhostHttpPort: 3178 } as any);
    const mode: HostMode = detectMode(config);
    assert.equal(mode, 'docker');
  });
  it('returns "bare-metal" when localhostHttpPort is not set', () => {
    assert.equal(detectMode(baseConfig()), 'bare-metal');
  });
});
```

- [ ] **Step 2: Run, verify failing**

`node --test test/setup-config.test.ts 2>&1 | tail -15`
Expected: `Cannot find module '../src/setup-config.ts'`.

- [ ] **Step 3: Create the skeleton module**

Create `src/setup-config.ts` with:
- Import `createHash` from `node:crypto` and `ICCConfig` type
- Export type `HostMode = 'docker' | 'bare-metal'`
- Export `detectMode(config)` that returns `'docker'` when `config.server.localhostHttpPort` is a number, else `'bare-metal'`

- [ ] **Step 4: Run, verify pass**

`node --test test/setup-config.test.ts 2>&1 | tail -10`

- [ ] **Step 5: Commit**

`git add src/setup-config.ts test/setup-config.test.ts && git commit -m "feat(setup-config): scaffold mode detection module"`

---

### Task 2: Add `buildHooksTemplate` for both modes

**Files:**
- Modify: `src/setup-config.ts`
- Test: `test/setup-config.test.ts`

- [ ] **Step 1: Append failing tests** — assert that Docker mode produces `curl` + `Authorization: Bearer` commands targeting `http://localhost:3178/api/hook/startup`, bare-metal mode produces `icc hook startup` commands (no curl, no Bearer). Assert both modes cover all matchers: SessionStart (startup/resume/compact/clear), UserPromptSubmit, PostToolUse, Stop, SessionEnd, SubagentStart, PreToolUse.

- [ ] **Step 2: Run, verify failing**

- [ ] **Step 3: Implement `buildHooksTemplate(config)`**

Export `buildHooksTemplate(config): HooksTemplate` that dispatches on `detectMode`. Two private builders:

**`buildDockerHooks(config)`** — constructs all hook commands as curl one-liners using a `base = http://localhost:${localhostHttpPort}` and `authHeader = -H 'Authorization: Bearer ${localToken}'`. The SessionStart startup/resume/clear commands include the `/api/health` pre-check guard from sub-project C (curl `-sf -m 1 ${authHeader} ${base}/api/health > /dev/null 2>&1 || { echo '...'; exit 0; }`) before the existing POST. Heartbeat uses a session-token file read via `cat /tmp/icc-session-$PPID.token`. pre-bash and pre-icc-message stream stdin via `cat | curl ... -d @-`.

**`buildBareMetalHooks()`** — constructs all hook commands as `icc hook <subcmd> 2>/dev/null || true` with appropriate timeouts (10s for startup, 5s for check/session-end, 3s for pre-bash, 2s for pre-icc-message, 10s for Stop running `icc hook shutdown` without the `|| true`).

- [ ] **Step 4: Run tests, verify pass**

- [ ] **Step 5: Commit**

`git commit -m "feat(setup-config): mode-aware hooks template builder"`

---

### Task 3: Add `buildSkillsTemplate` for both modes

**Files:**
- Modify: `src/setup-config.ts`
- Test: `test/setup-config.test.ts`

- [ ] **Step 1: Append failing tests** — assert Docker /watch skill content contains `/api/watch?instance=`, `/tmp/icc-session-$PPID.token`, and `stale_token` (from sub-project C's recovery branch). Assert bare-metal /watch content contains `icc hook watch` and no `/tmp/icc-session` and no `curl`. Assert both modes include watch/snooze/wake/sync skill entries. Assert Docker /sync uses curl + Bearer, bare-metal /sync uses `icc hook sync`.

- [ ] **Step 2: Implement `buildSkillsTemplate(config)`**

Two private builders:

**`buildDockerSkills(config)`** — four skill entries (watch, snooze, wake, sync). Content strings use the base URL and authHeader. `/watch` is the current Docker skill content (currently inlined in `src/server.ts` around lines 540-606) including the sub-project C stale_token recovery branch. `/snooze` and `/wake` are short multi-step curl procedures. `/sync` is the Docker shell+jq sync procedure (Task 13 expands this).

**`buildBareMetalSkills()`** — four skill entries. `/watch` launches `icc hook watch` via `Bash run_in_background: true`, reads output for `[ICC] Mail received` / `[ICC] Stale session token` / other branches. `/snooze` runs `icc hook snooze-watcher`. `/wake` runs `icc hook wake-watcher` then relaunches. `/sync` is a thin skill that invokes `icc hook sync` via the Bash tool and relays CLI output to the user (Task 11 implements the CLI subcommand).

All skills have frontmatter with `name`, `description`, `disable-model-invocation: true`, `user-invocable: true`, and for `/watch` the `args: [--force] [--name <alt-name>]` line.

- [ ] **Step 3: Run tests, verify pass**

- [ ] **Step 4: Commit**

`git commit -m "feat(setup-config): mode-aware skills template builder"`

---

### Task 4: Wire builders into /setup/claude-code handler

**Files:**
- Modify: `src/server.ts`

- [ ] **Step 1: Add import** — `import { buildHooksTemplate, buildSkillsTemplate, detectMode } from './setup-config.ts';`

- [ ] **Step 2: Replace inline hook + skill construction** in the /setup/claude-code handler (around line 417) with calls to `buildHooksTemplate(config)` and `buildSkillsTemplate(config)`. Add `hostMode: detectMode(config)` as a top-level response field. Keep `claudeMd.content` inlined in the handler for now (it's host-agnostic and will move to setup-config.ts in Task 6).

- [ ] **Step 3: Delete superseded inline template strings** from `src/server.ts`.

- [ ] **Step 4: Run existing server tests to catch regressions** — update any tests asserting exact substrings of the old inline templates.

- [ ] **Step 5: Commit**

`git commit -m "feat(server): wire /setup/claude-code to setup-config.ts builder"`

---

## Phase 2 — Versioning + drift detection

### Task 5: Canonical JSON serializer and content hash

**Files:**
- Modify: `src/setup-config.ts`
- Test: `test/setup-config.test.ts`

- [ ] **Step 1: Append failing tests** — `canonicalJson` sorts object keys recursively, preserves array order; `hashPayload` returns stable 12-char hex; equal-but-differently-ordered objects produce the same hash; different content produces different hashes.

- [ ] **Step 2: Implement and export**

```ts
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map(canonicalJson).join(',') + ']';
  const keys = Object.keys(value as object).sort();
  const entries = keys.map((k) => JSON.stringify(k) + ':' + canonicalJson((value as any)[k]));
  return '{' + entries.join(',') + '}';
}

export function hashPayload(value: unknown): string {
  return createHash('sha256').update(canonicalJson(value), 'utf8').digest('hex').slice(0, 12);
}
```

- [ ] **Step 3: Run tests, verify pass**

- [ ] **Step 4: Commit**

`git commit -m "feat(setup-config): canonical JSON + content hash"`

---

### Task 6: `buildSetupPayload` with version + restartCategories

**Files:**
- Modify: `src/setup-config.ts`
- Test: `test/setup-config.test.ts`

- [ ] **Step 1: Append failing tests** — `buildSetupPayload(config)` returns an object with `version`, `hostMode`, `mcp`, `hooks`, `claudeMd`, `skills`, `restartCategories`, `instructions`, `postSetup`. Version is 12-char hex. Same config yields same version. Docker and bare-metal configs yield different versions. `restartCategories` has entries for `mcp`/`hooks`/`skills`/`claudeMd` each with `action` and `label`.

- [ ] **Step 2: Implement `buildSetupPayload(config)`**

The function:
1. Detects mode
2. Builds the full payload **without** the `version` field (using buildHooksTemplate, buildSkillsTemplate, and a constant CLAUDE_MD_CONTENT string moved from src/server.ts)
3. Sets the MCP entry based on mode: Docker gets `{ type: 'http', url: 'http://localhost:3178/mcp?token=<localToken>' }`, bare-metal gets `{ type: 'stdio', command: 'node', args: [...], env: {} }` (the existing bare-metal MCP shape)
4. Adds `restartCategories`:
   - `mcp`: `{ action: 'in-session', command: '/mcp', label: 'Run /mcp' }`
   - `hooks`: `{ action: 'next-session', command: null, label: 'Restart Claude Code' }`
   - `skills`: `{ action: 'immediate', command: null, label: 'No action needed' }`
   - `claudeMd`: `{ action: 'next-session', command: null, label: 'Restart Claude Code' }`
5. Computes `version = hashPayload(payloadWithoutVersion)`
6. Returns `{ version, ...payloadWithoutVersion }`

The CLAUDE_MD_CONTENT constant should be a host-agnostic markdown string covering: inbox handling rules, watcher lifecycle rules, the stale_token and config-drift behaviors. No file paths. No host-specific commands. The content currently inlined in `src/server.ts:512-540` is the starting point — extend it to mention the config-drift hint and the stale_token watcher exit.

- [ ] **Step 3: Run tests, verify pass**

- [ ] **Step 4: Commit**

`git commit -m "feat(setup-config): buildSetupPayload with version + restartCategories"`

---

### Task 7: Wire `buildSetupPayload` into /setup/claude-code + /api/hook/startup

**Files:**
- Modify: `src/server.ts`
- Test: `test/server.test.ts`

- [ ] **Step 1: Append failing tests** — /setup/claude-code returns a `version` field matching 12-char hex and a `restartCategories` with `mcp.action === 'in-session'`. /api/hook/startup POST returns `setupVersion` in its body. POST with matching `appliedVersion` in body returns `drifted: false`. POST with mismatched `appliedVersion` returns `drifted: true`. POST with no `appliedVersion` returns `drifted: false` (default).

- [ ] **Step 2: Update /setup/claude-code handler** — replace the hand-built response with `sendJSON(res, 200, buildSetupPayload(config))`.

- [ ] **Step 3: Update /api/hook/startup handler** — after reading the request body, compute `const { version: setupVersion } = buildSetupPayload(config)`, compare to `body.appliedVersion` (if a string), set `drifted` accordingly, and include both fields in the response alongside the existing `connected` and `unreadCount` fields.

- [ ] **Step 4: Run tests, verify pass**

- [ ] **Step 5: Commit**

`git commit -m "feat(server): /api/hook/startup returns setupVersion + drifted"`

---

### Task 8: Bare-metal `hook startup` reads manifest + emits drift hint

**Files:**
- Modify: `bin/icc.ts` (startup case around line 580)
- Test: `test/hooks.test.ts`

- [ ] **Step 1: Append failing tests**
   - Drift hint emitted when manifest version differs from current server version
   - No drift hint when manifest version matches
   - "Config not yet synced" hint when manifest is absent

- [ ] **Step 2: Update the startup case**

After the existing registration call, read `~/.icc/applied-config-manifest.${config.identity}.json` using `readManifest` from `src/manifest.ts` (Task 10 creates this; until then, inline the read). Extract the `version` field if present. Re-call `hookRequest('/api/hook/startup', { instance, appliedVersion })` with the applied version, receive `drifted` flag, and emit the drift hint on true or the "not yet synced" hint on missing manifest. Neither path updates the manifest — only `/sync` does that.

The single extra POST roundtrip is acceptable because startup is once per session. If concern arises, the two calls can be collapsed into one by passing `appliedVersion` on the first call and dropping the second.

- [ ] **Step 3: Run tests, verify pass**

- [ ] **Step 4: Commit**

`git commit -m "feat(hook): startup reads manifest + emits drift hint"`

---

### Task 9: Docker hook template drift detection via jq

**Files:**
- Modify: `src/setup-config.ts` (Docker startup command template)
- Test: `test/setup-config.test.ts`

- [ ] **Step 1: Append failing test** — Docker startup hook command contains `applied-config-manifest`, uses `jq`, and surfaces `drifted` in output.

- [ ] **Step 2: Update the Docker `startupCmd` template** in `buildDockerHooks` to:
   1. Read the current applied version via `APPLIED=$(ls $HOME/.icc/applied-config-manifest.*.json 2>/dev/null | head -1 | xargs -r jq -r .version 2>/dev/null)`
   2. POST to `/api/hook/startup` with `{"instance":"...","appliedVersion":"$APPLIED"}` in the body
   3. Pipe the response through `jq -r 'if .drifted == true then "[ICC] Config drifted. Run /sync to update." else empty end'`

The health pre-check guard from sub-project C still runs first. The drift-detection jq chain replaces the previous simple POST (which only produced connectivity output).

- [ ] **Step 3: Run tests, verify pass**

- [ ] **Step 4: Commit**

`git commit -m "feat(setup-config): Docker startup hook emits drift hint via jq"`

---

## Phase 3 — Manifest module and owned-region hashing

### Task 10: Create `src/manifest.ts`

**Files:**
- Create: `src/manifest.ts`
- Test: `test/manifest.test.ts`

- [ ] **Step 1: Write failing tests**

Create `test/manifest.test.ts` with test cases for:
- `readManifest(path)` returns `null` when the file is missing
- `writeManifest` + `readManifest` round-trip
- `writeManifest` is atomic (no leftover temp files in the directory after)
- `hashJsonSubtree(obj, 'mcpServers.icc')` hashes only the named subtree, ignoring sibling keys
- `hashJsonSubtree` returns 64-char hex (full SHA-256)
- `wrapClaudeMdWithMarkers` produces content with `<!-- ICC:BEGIN` and `<!-- ICC:END`
- `extractClaudeMdRegion` returns inner content when markers present, null when absent
- `hashClaudeMdRegion` produces the same hash for two files with the same inner content but different preamble/postamble
- `hashClaudeMdRegion` returns null when markers absent

- [ ] **Step 2: Implement `src/manifest.ts`**

Module exports:
- `ICC_MARKER_BEGIN` and `ICC_MARKER_END` constants
- `AppliedConfigManifest` interface: `{ version, appliedAt, files: Record<string, string> }`
- `readManifest(path): AppliedConfigManifest | null`
- `writeManifest(path, manifest): void` — atomic via tempfile + rename, mode 0600
- `hashJsonSubtree(obj, dottedPath): string` — navigates the dotted path, serializes with `canonicalJson`, returns full SHA-256 hex
- `hashFileContents(content): string`
- `extractClaudeMdRegion(fileContent): string | null` — regex matches `<!--\s*ICC:BEGIN[^>]*-->([\s\S]*?)<!--\s*ICC:END\s*-->`, returns trimmed inner content
- `hashClaudeMdRegion(fileContent): string | null` — extracts region then hashes
- `wrapClaudeMdWithMarkers(inner): string`

Atomic write: `const tmp = ${path}.tmp.${pid}.${Date.now()}; writeFileSync(tmp, JSON.stringify(manifest, null, 2) + '\n', { mode: 0o600 }); renameSync(tmp, path);`

- [ ] **Step 3: Run tests, verify pass**

- [ ] **Step 4: Commit**

`git commit -m "feat(manifest): applied-config manifest module + owned-region hashing"`

---

## Phase 4 — `icc hook sync` + CLAUDE.md migration

### Task 11: `icc hook sync` CLI subcommand (bare-metal)

**Files:**
- Modify: `bin/icc.ts` (add `case 'sync':` in the hook switch)
- Test: `test/hooks.test.ts`

- [ ] **Step 1: Write failing tests** covering:
   1. First sync (no manifest): all target files written, manifest created, summary reported
   2. Clean update: server version changed, one file auto-applied
   3. Unchanged: all files match → no-op, no manifest update
   4. Hand-edit detection: a locally-edited file is reported as skipped with a diff command
   5. Hand-edit override (simulated "apply" response via stdin): file is overwritten, manifest updated
   6. Abort safety: after collecting hand-edit prompts, simulated "abort" → no files written, manifest unchanged

- [ ] **Step 2: Implement `case 'sync':`**

The implementation follows spec Component 6 in detail. Sketch:

1. Fetch the payload via `hookGet('/setup/claude-code')` (helper from plan C)
2. Read the local manifest at `~/.icc/applied-config-manifest.${config.identity}.json`
3. Build the list of target files with their manifest keys and per-file metadata (category, current hash, server hash, proposed new content). Target files:
   - `~/.claude.json` at subtree `mcpServers.icc` (category `mcp`)
   - `~/.claude/settings.json` at subtree `hooks` (category `hooks`)
   - `~/.claude/CLAUDE.md` at region `#icc-region` (category `claudeMd`)
   - `~/.claude/skills/{watch,snooze,wake,sync}/SKILL.md` (category `skills`, one entry per skill)
4. Classify each file:
   - `unchanged`: local hash == manifest hash && server hash == manifest hash
   - `clean-update`: local hash == manifest hash && server hash != manifest hash (OR no manifest entry on first sync)
   - `hand-edited`: local hash != manifest hash (file was modified locally since last sync)
5. If any hand-edited files exist, print a summary listing them with a diff command, then prompt the user (via stdin) per file with `apply | skip | abort`. Collect all answers up front before writing anything.
6. If any answer is `abort`, print "Aborted. No files written." and exit 0 without touching the manifest.
7. Otherwise, apply all `clean-update` and `apply`-confirmed hand-edited files:
   - JSON merge targets: read existing JSON, replace the dotted-path subtree via a small `setSubtree` helper, write via tempfile + rename
   - CLAUDE.md: read existing file, run `migrateClaudeMd(existing, newInner)` (see Task 12), write via tempfile + rename
   - Skill files: write via tempfile + rename
8. Update the manifest with the new version, new timestamp, and new per-file hashes for applied files (preserve stored hashes for skipped files so they re-surface on next sync)
9. Print a summary grouped by `restartCategories[category].action`: list applied files under "Applied (N files)", list skipped under "Skipped (N files with local edits)", list restart actions under "⏳ Restart actions needed" (group by action, dedupe "No action needed")

The CLI stdin prompts can use `readline.createInterface({ input: process.stdin })` or equivalent.

- [ ] **Step 3: Run tests, iterate, verify pass**

- [ ] **Step 4: Commit**

`git commit -m "feat(hook): icc hook sync — reconcile local config against server"`

---

### Task 12: CLAUDE.md first-sync migration

**Files:**
- Modify: `src/manifest.ts` (add `migrateClaudeMd`)
- Test: `test/manifest.test.ts`

- [ ] **Step 1: Append failing tests** — migrate when markers present (replace region), migrate when only ICC headings present (find contiguous region, replace, wrap in markers), migrate when no ICC content (append new marker block), migrate empty file (create content from scratch).

- [ ] **Step 2: Implement `migrateClaudeMd(existing, newInner)`**

Logic:
- If `extractClaudeMdRegion(existing)` returns non-null: just replace the matched region via `existing.replace(MARKER_REGEX, wrapClaudeMdWithMarkers(newInner))`
- Otherwise, search for the first line matching any of `['# ICC Inbox', '# ICC Activation & Mail Watcher', '# ICC Config Drift']` (use a constant `ICC_HEADINGS` array):
  - If found: scan forward to find the end of the contiguous ICC region (end of file, or the next non-ICC H1). Replace `lines[firstIccIdx..lastIccIdx]` with `wrapClaudeMdWithMarkers(newInner)`, preserve `lines[0..firstIccIdx-1]` as "before" and `lines[lastIccIdx+1..]` as "after", join with blank lines between non-empty sections
  - If not found: append `wrapClaudeMdWithMarkers(newInner)` at the end of the file (with a blank line separator if the file is non-empty)

- [ ] **Step 3: Wire `migrateClaudeMd` into `hook sync`** — when applying the CLAUDE.md target, read the existing file (if any), run `migrateClaudeMd`, write atomically.

- [ ] **Step 4: Run tests, verify pass**

- [ ] **Step 5: Commit**

`git commit -m "feat(manifest): CLAUDE.md first-sync migration (option a)"`

---

## Phase 5 — Docker /sync shell procedure, docs, end-to-end

### Task 13: Docker /sync skill — full shell procedure

**Files:**
- Modify: `src/setup-config.ts` (`buildDockerSkills` sync content)
- Test: `test/setup-config.test.ts`

Because Docker hosts have no `icc` CLI, the Docker /sync skill must implement the full classify-apply-update loop as a shell + jq procedure embedded in the skill markdown. The Task 3 stub put a high-level description; this task fleshes it out.

- [ ] **Step 1: Append failing test** — the Docker /sync skill content references `applied-config-manifest`, uses `jq`, references `restartCategories`.

- [ ] **Step 2: Expand the Docker /sync skill content** to include step-by-step bash snippets for:
   1. `curl -sf${authHeader} ${base}/setup/claude-code > /tmp/icc-setup-fetch.json` — fetch canonical
   2. Read `hostMode` and derive the manifest path (`~/.icc/applied-config-manifest.*.json`, glob by the matching host)
   3. For each target file: compute the current hash using `jq` + `sha256sum` (for JSON subtrees, extract the subtree with `jq -c '.mcpServers.icc'` then pipe to `sha256sum`; for CLAUDE.md, use `sed` to extract the marker region then hash; for skill files, `sha256sum` directly)
   4. Compare to manifest values (extract via `jq`)
   5. Classify as unchanged/clean-update/hand-edited
   6. For hand-edited files, print the diff command and prompt the user for `apply | skip | abort` (the skill instructs the model to collect user input interactively)
   7. Apply via `jq` subtree replacement + atomic `mv`
   8. Update the manifest JSON by constructing the new object with `jq` and writing atomically
   9. Print the restart-action summary by looking up each applied file's category in `restartCategories`

Keep the skill content readable — Claude Code interprets it literally, so overly clever one-liners are counterproductive.

- [ ] **Step 3: Run tests, verify pass**

- [ ] **Step 4: Commit**

`git commit -m "feat(setup-config): Docker /sync skill — full shell procedure"`

---

### Task 14: Update docs + wizard

**Files:**
- Modify: `docs/claude-code-setup.md`
- Modify: `docs/docker.md`
- Modify: `docker/wizard.ts`

- [ ] **Step 1: Update `docs/claude-code-setup.md`** — add a banner at the top: "**As of 2026-04-07, `/setup/claude-code` is the authoritative source of truth for ICC integration files. After initial setup, use `/sync` to reconcile.** This doc is retained for readability of the manual setup flow."

   Update §3 (CLAUDE.md) to show the marker-wrapped form. Update §4 to include `/sync`.

- [ ] **Step 2: Update `docs/docker.md`** — same banner, same marker-wrapped CLAUDE.md form, `/sync` added to the skills list.

- [ ] **Step 3: Update `docker/wizard.ts`** — wizard completion page adds a line mentioning `/sync` as the way to reconcile after container updates.

- [ ] **Step 4: Commit**

`git commit -m "docs(sync): update setup docs with marker convention + /sync"`

---

### Task 15: Full suite + end-to-end verification

- [ ] **Step 1: Full test suite**

Run `node --test test/*.test.ts 2>&1 | tail -20`. Expected: all tests pass including the new setup-config, manifest, server, and hooks test files.

- [ ] **Step 2: End-to-end on um890 (bare-metal)**

1. Back up `~/.claude/CLAUDE.md`, `~/.claude/settings.json`, `~/.claude.json`, `~/.claude/skills/`
2. Delete `~/.icc/applied-config-manifest.um890.json` if present
3. Open a Claude Code session. Expect: `[ICC] Config not yet synced — run /sync to apply.`
4. Run `/sync`. Expect: all files applied, CLAUDE.md migration wraps existing content in markers, manifest created, restart actions reported
5. Run `/sync` again. Expect: no changes
6. Hand-edit a non-marker line in `~/.claude/CLAUDE.md` (outside the ICC region). Run `/sync`. Expect: no changes (hash covers only the region)
7. Hand-edit a line inside the markers. Run `/sync`. Expect: skipped with diff command, prompt offered
8. Modify a skill file. Run `/sync`. Same prompt behavior
9. After a server-side change, open a new session. Expect: `[ICC] Config drifted` hint immediately

- [ ] **Step 3: End-to-end on rpi1 (Docker) via ICC collaboration**

`send_message` to rpi1 walking them through the same nine scenarios adapted to Docker. Expect the `/sync` skill to run as a shell+jq procedure rather than `icc hook sync`. Have rpi1 report back findings. Fix anything they report (per CLAUDE.md "fix everything you find").

- [ ] **Step 4: Update project memory**

After verification succeeds:
- Create a new memory file `project_sync_skill.md` documenting the marker convention (`<!-- ICC:BEGIN -->` / `<!-- ICC:END -->`), the manifest file location (`~/.icc/applied-config-manifest.<host>.json`), the mode detection mechanism (`config.server.localhostHttpPort`), and the `/sync` flow
- Add a pointer in `MEMORY.md`
- Delete `project_rpi1_deployment.md`'s outdated update command if still present; confirm plan A's memory update from earlier in this work has already happened

---

## Self-review coverage matrix

| Spec section | Covered by |
|---|---|
| Component 1: content-hash versioning (`version` field) | Tasks 5, 6 |
| Component 2: `setupVersion` in /api/hook/startup response | Task 7 |
| Component 3: per-host manifest + owned-region hashes (3 flavors) | Task 10 |
| Component 4: CLAUDE.md sentinel marker convention | Task 10 + Task 12 |
| Component 5: `/sync` skill behavior (three-state classification, atomic apply, restart report) | Task 11 (bare-metal), Task 13 (Docker) |
| Component 6: restart categorization | Task 6 (`restartCategories` field), Task 11 + Task 13 (consumers) |
| Component 7: first-sync CLAUDE.md migration (option a) | Task 12 |
| Component 8: templates + docs updates | Task 14 |
| Drift detector in startup hook | Task 8 (bare-metal), Task 9 (Docker) |
| Amendment: mode detection (Docker vs bare-metal) | Task 1 |
| Amendment: bare-metal hooks template | Task 2 |
| Amendment: bare-metal skills template | Task 3 |
| Amendment: unified /setup/claude-code wiring | Task 4 |
| Amendment: new `icc hook sync` subcommand | Task 11 |
| Version hash per-mode (different between Docker and bare-metal) | Task 6 test |
| Unit tests: canonical JSON, hash determinism, subtree hashing, marker helpers, manifest round-trip | Tasks 5, 6, 10 |
| Unit tests: mode detection + per-mode hooks + per-mode skills | Tasks 1–3 |
| Unit tests: server version + drift endpoints | Task 7 |
| Unit tests: CLAUDE.md migration branches | Task 12 |
| Unit tests: first-sync happy path + hand-edit detection + abort safety | Task 11 |
| E2E: bare-metal on um890 (9 scenarios) | Task 15 Step 2 |
| E2E: Docker on rpi1 (parallel scenarios) | Task 15 Step 3 |
| Memory update | Task 15 Step 4 |

**Placeholder note:** Tasks 11 and 13 do not inline every line of the full /sync implementation (bare-metal CLI and Docker shell), because each runs ~200–300 lines and would triple this plan's length. The preceding tasks provide all helper primitives (manifest module, hash functions, marker handling, mode-aware templates, setup payload builder). Task 11 lists the classify-apply-update steps in the order they must occur and references the spec for any behavior ambiguity. An implementation agent following the plan in order has everything needed to write the code without further design decisions.

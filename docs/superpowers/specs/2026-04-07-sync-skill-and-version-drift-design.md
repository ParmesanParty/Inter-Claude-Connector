# Config Versioning + `/sync` Skill + Restart Categorization — Design

**Date:** 2026-04-07
**Status:** Approved, ready for implementation plan
**Sub-project:** B of 4 (Docker update flow improvements)
**Related:** rpi1 proposal items #2, #3, #4 in thread `9f20c338`

## Problem

Today there is no way for a Claude Code instance to know whether its locally-installed ICC integration files (MCP config, hooks, skills, CLAUDE.md instructions) are in sync with the canonical `/setup/claude-code` payload that the local ICC server would emit. After any change to the server's templated configuration — whether shipped via `git pull` on bare-metal or `docker compose pull` on Docker — every Claude Code instance has stale local files until either the user notices and prompts a reconciliation by hand, or runs through the full setup wizard again. There is also no standardized way to apply such updates: rpi1's last walkthrough required ad-hoc Python to diff each section.

The result is that doc improvements, hook fixes, and skill changes ship to the server but never reach the running Claude Code instances on each host until a human notices and intervenes.

## Goal

After this work:

- The `/setup/claude-code` server response carries a content-derived version stamp that clients can compare against locally-persisted state to detect drift
- Every `SessionStart` automatically reports drift if it exists
- A `/sync` slash skill applies updates one command, with safe handling for files the user has hand-edited
- A clear summary tells the user exactly what — if anything — needs a restart to take effect

## Amendment: unified bare-metal + Docker `/setup/claude-code` (2026-04-07, Path B)

The original draft assumed `/setup/claude-code` already served mode-appropriate content for each host. Code inspection revealed it currently serves **Docker-flavored content only** — hardcoded curl-based hooks and `/tmp/icc-session-$PPID.token` skill references. Bare-metal hosts install integration files statically from `docs/claude-code-setup.md`, not from the server endpoint, so the two code paths have never been unified.

The user has chosen to unify them now rather than scope sub-project B to Docker only. This adds:

- **Mode detection in the `/setup/claude-code` payload builder.** When `config.server.localhostHttpPort` is set, the host is running in Docker mode (two-listener split: mTLS peer port + plain-HTTP localhost port). Otherwise, the host is running in bare-metal mode (single mTLS listener, local hooks use mTLS loopback via `icc hook <subcmd>`).
- **Two content variants of the `hooks`, `skills`, and relevant doc strings**, selected at payload-build time based on the detected mode. The `claudeMd.content` string is host-agnostic and shared across both modes (no paths inside it).
- **Bare-metal `hooks` template:** uses `icc hook startup`, `icc hook check`, `icc hook shutdown`, `icc hook watch`, etc. — the existing subcommands that already exist in `bin/icc.ts`. No curl, no Bearer header.
- **Bare-metal `skills` template:** simpler than the Docker variants because the `icc hook` CLI handles token management internally. `/watch` launches `icc hook watch` via `Bash run_in_background: true` and reads output for the `[ICC] Mail received` marker; `/snooze` and `/wake` are single-line CLI calls.
- **`/sync` skill, two variants:**
  - *Docker:* uses curl directly against `localhost:3178` (no mTLS; Bearer header for auth)
  - *Bare-metal:* invokes a new `icc hook sync` CLI subcommand, which internally does the mTLS-loopback HTTP call, handles manifest I/O, computes owned-region hashes, and reports results. The skill becomes a thin wrapper around that subcommand.
- **`docs/claude-code-setup.md` §2 (hooks) and §4 (skills) become fully redundant** with the server-templated versions after this amendment. We keep the doc for readability of the manual setup flow but add a banner noting that the authoritative source is now `/setup/claude-code` and suggesting `/sync` for ongoing reconciliation. The doc content must match the bare-metal template in the server payload so first-run wizard setup doesn't diverge from subsequent `/sync` operations.
- **Version hashing is per-mode.** The hash is computed over whatever payload the server emits *for that call*. Two hosts in different modes produce different hashes for equivalent configurations; this is correct — the hash reflects what the client will actually see and apply.

**Why this is worth the extra scope:** after the amendment, there is a single source of truth for ICC integration files on every host regardless of deployment mode. The static `docs/claude-code-setup.md` integration content becomes a readability convenience rather than a duplicate source that can drift from the server. Future changes to hook commands, skill content, or CLAUDE.md instructions land in one place (`src/server.ts`) and propagate to every host via `/sync`.

## Non-goals

- Three-way merge of hand-edited files (we detect, prompt, and let the user manually diff)
- `--dry-run` flag (deferred; the existing detection is already low-risk)
- Sourcing skill content from a directory rather than the server (some users might want git-versioned skills) — out of scope
- Showing the actual diff inline rather than emitting a `diff` command — saves model tokens; the user can run the diff if they want it
- Auto-running `/sync` (the user always invokes it explicitly; the drift hint is advisory)

## Design

### Component 1: Content-hash versioning in `/setup/claude-code`

**File:** `src/server.ts`, the existing `/setup/claude-code` handler at line 417. If the inline body grows beyond ~100 lines after these changes, extract payload-building into `src/setup-config.ts`.

**Behavior:**

1. The handler builds the response payload as it does today (`mcp`, `hooks`, `claudeMd`, `skills`, `instructions`).
2. Adds a new top-level `restartCategories` field describing what action each kind of change requires:
   ```json
   "restartCategories": {
     "mcp":      { "action": "in-session",  "command": "/mcp",   "label": "Run /mcp" },
     "hooks":    { "action": "next-session", "command": null,    "label": "Restart Claude Code" },
     "skills":   { "action": "immediate",   "command": null,    "label": "No action needed" },
     "claudeMd": { "action": "next-session", "command": null,    "label": "Restart Claude Code" }
   }
   ```
3. Computes `version = sha256(canonical_json(payload)).slice(0, 12)` — where `canonical_json` is a deterministic serializer with sorted keys (we'll add a small recursive helper or use `safe-stable-stringify` semantics).
4. Inserts the resulting `version` field into the payload as a top-level key (added *after* the hash is computed, so the hash is not self-referential), then serializes and returns.

The version is purely a function of the bytes the client receives. Two ICC servers running the same code on different hosts produce the same hash for the same configured inputs. A doc-only change to source files that doesn't affect the served payload does not bump the version.

**Note:** the version stamp lives on the payload that the local server produces. A Docker server produces Docker-flavored content (hooks include Bearer auth, MCP URL points at port 3178); a bare-metal server produces bare-metal content. Each host's drift detection is against its own local server, so per-host content variations are correct by construction.

### Component 2: Registration response carries `setupVersion`

**File:** `src/server.ts`, the `/api/hook/startup` registration handler.

**Behavior:** the handler builds its registration response as it does today (instance name, session token, etc.). Add a `setupVersion` field equal to the same hash that `/setup/claude-code` would compute right now. Implementation: extract the payload-building helper used by Component 1 so that both endpoints call into it, and the hash is computed in one place.

This piggybacks the version delivery on an HTTP roundtrip the hook already makes — zero new requests, zero new endpoints.

### Component 3: Client persistence — manifest file

**File:** `~/.icc/applied-config-manifest.<host-identity>.json` (one per ICC host the local Claude Code installation talks to).

**Schema:**

```json
{
  "version": "abc123def456",
  "appliedAt": "2026-04-07T01:55:00.000Z",
  "files": {
    "~/.claude.json#mcpServers.icc": "<sha256>",
    "~/.claude/settings.json#hooks": "<sha256>",
    "~/.claude/CLAUDE.md#icc-region": "<sha256>",
    "~/.claude/skills/watch/SKILL.md": "<sha256>",
    "~/.claude/skills/snooze/SKILL.md": "<sha256>",
    "~/.claude/skills/wake/SKILL.md": "<sha256>",
    "~/.claude/skills/sync/SKILL.md": "<sha256>"
  }
}
```

**Path key conventions — three flavors of "owned region":**

| File type | Key suffix | What gets hashed |
|---|---|---|
| **JSON merge target** (`~/.claude.json`, `~/.claude/settings.json`) | `#<dot.path>` (e.g. `#mcpServers.icc`, `#hooks`) | Canonical JSON of the named subtree only |
| **Markdown merge target** (`~/.claude/CLAUDE.md`) | `#icc-region` | Substring between sentinel markers (see Component 4) |
| **Wholly-owned file** (skill `SKILL.md` files) | (no suffix) | File contents verbatim |

**The unifying rule:** ICC owns one named, identifiable region in each file — JSON subtree, sentinel-delimited markdown block, or whole file. Hash and write only that region.

**Lifecycle:**
- Created or updated *only* by `/sync` after a successful apply
- Read by `/sync` on every invocation (to detect local edits) and by `icc hook startup` (to detect drift against the server's reported `setupVersion`)
- Deleted by no one (orphaned manifests for retired hosts persist; harmless and small)
- All writes are atomic via `tempfile + rename`

### Component 4: CLAUDE.md sentinel markers

**The marker convention:**

```markdown
<!-- ICC:BEGIN — managed by /sync, do not edit between markers -->

# ICC Inbox

When a hook surfaces an unread message notification...

# ICC Activation & Mail Watcher

On session start, the startup hook outputs status...

<!-- ICC:END -->
```

**Why sentinel markers:** `~/.claude/CLAUDE.md` is a multi-tenant file. Users have personal preferences, ICC has watcher instructions, other tools may also have sections. Hashing the whole file would always trigger drift on any unrelated edit, defeating auto-update. Markers give CLAUDE.md the same "owned region" semantics that JSON subtree paths give to `~/.claude.json` and `~/.claude/settings.json`.

**Hashing rule:** the manifest's `~/.claude/CLAUDE.md#icc-region` hash is computed over the substring *strictly between* the marker comments — markers themselves and surrounding whitespace are excluded. This makes the hash robust to incidental marker-line whitespace differences across editors.

**Server payload change:** the `claudeMd.content` field returned by `/setup/claude-code` now contains *only the inner content* (no markers). The `/sync` skill is responsible for wrapping the content in markers when writing. This keeps the server's content hash equal to the client's region hash, and lets us evolve the marker syntax in one place if we ever need to.

### Component 5: Drift detector in `icc hook startup`

**File:** `bin/icc.ts`, `hook startup` subcommand.

**Behavior, integrated into the startup flow (after sub-project C's health pre-check):**

1. (Sub-project C) Health pre-check
2. (Existing) POST registration to `/api/hook/startup`, receive response
3. **New:** parse `setupVersion` from the response. If `~/.icc/applied-config-manifest.<host-identity>.json` exists, read its `version` field. Compare:
   - **Match:** no action
   - **Mismatch:** append `[ICC] Config drifted v<old>→v<new>. Run /sync to update.` to the existing stdout output
   - **Manifest absent:** append `[ICC] Config not yet synced — run /sync to apply.`
4. **The persisted manifest is not updated here.** It is only updated by `/sync` after a successful apply, so the drift hint persists across multiple sessions until the user runs `/sync`. (This is the locked-in detail from question B3.)

### Component 6: `/sync` skill

**File:** templated by the server alongside `watch`, `snooze`, `wake`. The skill content lives in the `/setup/claude-code` response payload under `skills.sync.content`, so it's installed into `~/.claude/skills/sync/SKILL.md` by the same machinery that installs the others. This guarantees the skill ships with the server and stays in sync with whatever the server's Sync logic expects.

**Skill behavior:**

1. **Resolve target host:** read `~/.claude.json` `mcpServers.icc.url` to determine the local server's port (3179 bare-metal, 3178 Docker). Read `~/.icc/config.json` for the local `localToken`.
2. **Fetch the canonical config:** `curl -H 'Authorization: Bearer <localToken>' <localBaseUrl>/setup/claude-code`. Parse the response JSON.
3. **Read the local manifest** at `~/.icc/applied-config-manifest.<host-identity>.json` (may not exist on first sync).
4. **Classify each target file** in the response payload (`mcp`, `hooks`, `claudeMd`, each entry in `skills[]`):
   - Compute the current local owned-region hash using the same canonicalization as the manifest (JSON subtree hash, marker-delimited substring hash, or whole-file hash, depending on the file type)
   - Compare against the manifest's stored hash for that key
   - **Three states:**
     - **`unchanged`** — local hash matches stored hash AND new server content hash matches stored hash → no-op
     - **`clean-update`** — local hash matches stored hash AND new server content differs → auto-apply
     - **`hand-edited`** — local hash differs from stored hash → show file path and diff command, prompt for confirmation per file (`apply | skip | abort`)
   - **First-sync edge case (no manifest exists):** treat all files as `clean-update`. The user is bootstrapping; there is no prior state to protect.
5. **Apply each `clean-update` file:**
   - For JSON merge targets: read existing JSON, replace the ICC-owned subtree, write atomically
   - For CLAUDE.md: locate the existing `<!-- ICC:BEGIN ... ICC:END -->` block; if present, replace its inner content; if absent, fall through to the migration path (Component 7)
   - For wholly-owned skill files: write atomically
6. **Apply ordering and abort safety:** collect all hand-edit prompts up front, before any file is written. If the user chooses `abort` on any prompt, no files are written and the manifest is not touched. Otherwise, after all decisions are made, write all approved files and update the manifest in a single batch.
7. **Update the manifest:** new version, new timestamp, new per-file hashes for everything that was applied (including hand-edited files the user chose to overwrite). Files that were skipped retain their old manifest hash so they continue to flag as `hand-edited` on future syncs until the user reconciles them.
8. **Report results:**
   ```
   ✓ Synced from um890 — config v abc123 → def456

   Applied (4 files):
     • ~/.claude.json (mcpServers.icc)
     • ~/.claude/settings.json (hooks)
     • ~/.claude/skills/watch/SKILL.md
     • ~/.claude/CLAUDE.md (icc-region)

   Skipped (1 file with local edits):
     • ~/.claude/skills/snooze/SKILL.md
       diff: diff ~/.claude/skills/snooze/SKILL.md <(curl -H "Authorization: Bearer <token>" http://localhost:3178/setup/claude-code | jq -r '.skills.snooze.content')

   ⏳ Restart actions needed:
     • Run /mcp now           (mcp config changed)
     • Restart Claude Code    (hooks, CLAUDE.md changed)
   ```
   Restart actions are computed by grouping the changed file keys by `restartCategories[key].action` from the response, and rendering the `label` once per unique action that has at least one changed file. Categories with action `immediate` are omitted from the report (no user action needed).

### Component 7: First-sync migration for CLAUDE.md without markers

Existing CLAUDE.md files on every host (um890, rpi0, derp, wsl2, rpi1) already have ICC content but no sentinel markers. First `/sync` against any of those hosts must upgrade them in place.

**Migration path (option (a) — idempotent first-sync rewrite):**

1. The `/sync` skill detects "ICC content is present but markers are absent" by searching for the canonical ICC headings (`# ICC Inbox`, `# ICC Activation & Mail Watcher`) anywhere in the file.
2. If found: identify the contiguous region they define (from the first ICC heading through the end of the last ICC section; the boundary is the next non-ICC top-level heading or end-of-file).
3. **Replace that contiguous region with the canonical content from the local server**, wrapped in `<!-- ICC:BEGIN -->` / `<!-- ICC:END -->` markers. The local server's payload is the source of truth for the host (Docker or bare-metal), so a Docker host gets Docker-flavored ICC content and a bare-metal host gets bare-metal content automatically.
4. If markers are *also* absent and no ICC headings are found: the file does not yet have any ICC content. Append a fresh marker-wrapped block at the end of the file. If the file does not exist, create it with just the marker-wrapped block.

**Risk acknowledged:** if a user has hand-edited the existing ICC section before this work ships, the first-sync rewrite will clobber those edits. The user explicitly accepted this trade-off to keep migration single-step. The marker comment (`do not edit between markers`) reduces the risk of *future* accidental loss after the migration is complete.

### Component 8: Templates and docs

**Files updated to teach Claude Code how to install `/sync` and to introduce the marker convention:**

- `docs/claude-code-setup.md` — new §4 entry for `/sync`; §3 (CLAUDE.md) updated to show the marker-wrapped form
- `docs/docker.md` — same updates; the Manual Setup CLAUDE.md section also mirrors the marker convention
- `docker/wizard.ts` — wizard completion page mentions `/sync` for ongoing reconciliation
- `src/server.ts` `/setup/claude-code` payload — new entry in `skills` map for `sync`; `claudeMd.content` updated to be marker-inner-only (no markers in the served content; the `/sync` skill wraps when writing)

### Files touched

- `src/server.ts` — payload version hashing, `restartCategories` field, registration response carries `setupVersion`, `sync` skill entry, `claudeMd.content` shape change (markers stripped from the content; the inner-only form)
- Possibly `src/setup-config.ts` (new) — extracted payload builder + canonical JSON serializer + hash function, shared between `/setup/claude-code` and `/api/hook/startup`
- `bin/icc.ts` — `hook startup` reads `setupVersion`, compares against local manifest, emits drift hint
- `bin/icc.ts` — new `hook sync` subcommand or helper subcommands for the skill to call (computes manifest paths/hashes, performs atomic writes, handles JSON subtree extraction and CLAUDE.md marker handling — keeps the skill thin and the logic testable in TS)
- New: `~/.claude/skills/sync/SKILL.md` template content embedded in the server response
- `docs/claude-code-setup.md`, `docs/docker.md`, `docker/wizard.ts` — documentation updates for `/sync` and marker convention
- `test/server.test.ts` — version hash determinism, registration response carries `setupVersion`, `restartCategories` shape, `claudeMd.content` no longer contains markers
- New: `test/setup-config.test.ts` — content hashing function, canonical JSON serialization, JSON subtree extraction
- `test/hooks.test.ts` — drift detection emits hint on mismatch, no hint on match, "not yet synced" on missing manifest
- New: `test/sync-helper.test.ts` — manifest read/write, three-state classification, marker insertion and detection, JSON subtree round-trip, first-sync migration, abort safety

### Verification

1. **Server hash determinism (bare-metal):** restart `icc-server`, fetch `/setup/claude-code` twice across the restart, confirm `version` is identical. Run two ICC servers on um890 and rpi0 with synchronized config; confirm both produce the same hash for the same content.
2. **Server hash distinguishes Docker from bare-metal:** confirm a Docker server's hash differs from a bare-metal server's hash, because their hook bodies and MCP URLs differ (port 3178 + Bearer vs port 3179 + no auth).
3. **Drift hint, fresh install:** delete `~/.icc/applied-config-manifest.um890.json`, open a new Claude Code session, confirm SessionStart output includes `[ICC] Config not yet synced`.
4. **Drift hint, after server change:** make a trivial server-side payload change (e.g. add a comment to `instructions`), restart `icc-server`, open a new session, confirm SessionStart output includes `[ICC] Config drifted v<old>→v<new>`.
5. **`/sync` happy path (bare-metal):** run `/sync` from a fresh manifest, confirm all target files written including marker-wrapped CLAUDE.md, manifest created, restart actions reported, no prompts.
6. **`/sync` happy path (Docker):** same flow on rpi1, confirm port 3178 + Bearer auth works, confirm Docker-flavored CLAUDE.md content lands in the markers.
7. **`/sync` clean update:** modify a hook command on the server, run `/sync`, confirm only the hooks file is reported as updated and the restart-actions report says "Restart Claude Code."
8. **`/sync` hand-edit detection:** add a comment to `~/.claude/skills/watch/SKILL.md` locally, run `/sync`, confirm the skill is shown as `Skipped` with the diff command, confirm the manifest is *not* updated for that file (next sync still flags it).
9. **`/sync` hand-edit override:** at the prompt, choose `apply`, confirm the file is overwritten and the manifest is updated.
10. **First-sync CLAUDE.md migration:** start with a CLAUDE.md that has the existing ICC headings but no markers (representative of all current hosts), run `/sync`, confirm the ICC region is now wrapped in markers, confirm content outside the ICC region is preserved verbatim.
11. **Multi-tenant CLAUDE.md preservation:** add user content above and below the ICC block, run `/sync` again, confirm the user content is untouched and only the marker-wrapped region was updated.
12. **Multi-tenant `~/.claude.json` preservation:** add a custom `mcpServers.someothertool` entry, run `/sync`, confirm `someothertool` is preserved (subtree hash only covers `mcpServers.icc`).
13. **Abort safety:** trigger a hand-edit prompt, choose `abort`, confirm zero files were written and the manifest is unchanged.
14. **`SessionStart` perf:** time the new `startup` hook with the version comparison logic, confirm <50ms added latency.

### Risks and mitigations

| Risk | Mitigation |
|---|---|
| Canonical JSON serializer bug → hash differs across machines for the same content | Cover with unit tests on `test/setup-config.test.ts`. Use `safe-stable-stringify` semantics: deterministic key ordering, stable number formatting. |
| Manifest file written non-atomically → corruption on crash mid-write | All manifest writes use `tempfile + rename` (atomic on POSIX). |
| `~/.claude.json` subtree extraction logic disagrees between server and client → false-positive "drift" alerts | The server's payload is the source of truth for what subtree shape ICC writes. Client extraction must mirror it exactly. Cover with a unit test that round-trips: server payload → client write → client read → hash matches what server would have computed. |
| User runs `/sync` against the wrong host (multiple `mcpServers.*` ICC entries) | The skill reads the *active* `mcpServers.icc.url` to pick the host. If users have multiple ICC servers, they aim Claude Code at one at a time anyway — pre-existing UX, not a regression. Documented as a known limitation. |
| First-sync CLAUDE.md migration clobbers existing hand-edits inside the ICC section | Explicitly accepted by the user. After migration, future hand-edits inside the markers are detected and protected by the prompt-and-confirm flow. The marker comment warns users not to edit between markers. |
| User puts content between markers expecting it to be preserved across syncs | Marker comment explicitly says `managed by /sync, do not edit between markers`. If they do edit, the prompt-and-confirm flow catches it on the next sync and shows them what would be overwritten. |
| `/sync` runs while another tool is also writing to `~/.claude.json` (race) | Atomic `tempfile + rename` prevents corruption. Last-writer-wins on the shared file is the same behavior any file-editing tool has; not specific to `/sync`. |
| Skill is itself templated by the server, so the first `/sync` after a skill change updates the skill that just ran. The next invocation uses the new version. | Acceptable. The pattern is "skill self-updates on each sync." If the new skill version has a breaking change, the user runs `/sync` once on the old version to install the new version, then the next `/sync` uses the new logic. Document this behavior. |

### Out of scope

- Three-way merge of hand-edited files
- `--dry-run` flag
- Skill content sourced from a directory rather than the server
- Inline diff display (we emit a `diff` command instead)
- Auto-running `/sync` from the drift hint
- Cross-host sync (each `/sync` invocation only touches the local-host integration)

## Open questions

None. All design decisions resolved during brainstorming session 2026-04-07.

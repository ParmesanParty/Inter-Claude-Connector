// Setup-config module: builds the /setup/claude-code payload, detects host
// mode (Docker vs bare-metal), and provides hash helpers for version drift
// detection.
//
// Mode detection rationale: Docker hosts run the ICC server inside a
// container with TLS terminated on a localhost-only HTTP listener bound to
// ICC_LOCALHOST_HTTP_PORT (default 3178). Bare-metal hosts have no such
// listener — the ICC CLI talks straight to the TLS port. config.server
// .localhostHttpPort is populated by loadConfig from the env var, so this
// becomes a stateless config-based discriminator that works without probing
// /.dockerenv or running shell commands.
import { createHash } from 'node:crypto';
import type { ICCConfig } from './types.ts';

/**
 * Recursive key-sorted JSON serializer. Used as the canonical input to
 * hashPayload so that equivalent objects with different key orders produce
 * identical hashes.
 */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map(canonicalJson).join(',') + ']';
  const keys = Object.keys(value as object).sort();
  const entries = keys.map((k) => JSON.stringify(k) + ':' + canonicalJson((value as Record<string, unknown>)[k]));
  return '{' + entries.join(',') + '}';
}

/**
 * 12-char SHA-256 truncated content hash. Truncated because this is the
 * user-facing setup payload `version` field — short matters more than
 * collision-proof. Manifest entries (in src/manifest.ts) use the full 64-char
 * hash because byte-exact equality matters there.
 */
export function hashPayload(value: unknown): string {
  return createHash('sha256').update(canonicalJson(value), 'utf8').digest('hex').slice(0, 12);
}

export type HostMode = 'docker' | 'bare-metal';

export function detectMode(config: ICCConfig): HostMode {
  return config.server.localhostHttpPort != null ? 'docker' : 'bare-metal';
}

export interface HookEntry {
  type: 'command';
  command: string;
  timeout?: number;
}

export interface MatcherGroup {
  matcher: string;
  hooks: HookEntry[];
}

export interface UnmatchedGroup {
  hooks: HookEntry[];
}

export interface HooksTemplate {
  target: string;
  mergeKey: string;
  config: {
    SessionStart: MatcherGroup[];
    UserPromptSubmit: UnmatchedGroup[];
    PreToolUse: MatcherGroup[];
    SessionEnd: UnmatchedGroup[];
  };
}

export function buildHooksTemplate(config: ICCConfig): HooksTemplate {
  return detectMode(config) === 'docker'
    ? buildDockerHooks(config)
    : buildBareMetalHooks(config);
}

function buildDockerHooks(config: ICCConfig): HooksTemplate {
  const localBaseUrl = `http://localhost:${config.server.localhostHttpPort}`;
  const authHeader = config.server.localToken ? ` -H 'Authorization: Bearer ${config.server.localToken}'` : '';
  const manifestPath = `/home/icc/.icc/applied-config-manifest.${config.identity}.json`;
  // Existence check is done with `test -f` first because docker exec runtime
  // errors (container stopped, jq missing, etc.) print to STDOUT, not stderr,
  // so `2>/dev/null || echo null` does NOT catch them — the OCI error text
  // would be captured into APPLIED instead of falling through. The if-then
  // wrapping uses the test command's exit code, which IS distinct from runc
  // failures, and we discard both streams so nothing leaks.
  const startupCmd = `curl -sf -m 1${authHeader} ${localBaseUrl}/api/health > /dev/null 2>&1 || { echo 'ICC: server not reachable. Run /mcp to reconnect, then /watch to activate.'; exit 0; }; if docker exec icc test -f ${manifestPath} > /dev/null 2>&1; then APPLIED=$(docker exec icc jq -r .version ${manifestPath} 2>/dev/null || echo null); else APPLIED=null; fi; if [ "$APPLIED" = "null" ]; then BODY="{\\"instance\\":\\"$(basename $PWD)\\",\\"appliedVersion\\":null}"; else BODY="{\\"instance\\":\\"$(basename $PWD)\\",\\"appliedVersion\\":\\"$APPLIED\\"}"; fi; RESPONSE=$(curl -sf -X POST ${localBaseUrl}/api/hook/startup${authHeader} -H 'Content-Type: application/json' -d "$BODY"); echo "$RESPONSE" | jq -r 'if .drifted == true then "[ICC] Config drifted. Run /sync to update." else empty end'; [ "$APPLIED" = "null" ] && echo "[ICC] Config not yet synced — run /sync to apply."; true`;
  const heartbeatCmd = `ST=$(cat /tmp/icc-session-$PPID.token 2>/dev/null); [ -n "$ST" ] && curl -sf --max-time 1 -X POST ${localBaseUrl}/api/hook/heartbeat${authHeader} -H 'Content-Type: application/json' -d "{\\"sessionToken\\":\\"$ST\\"}" || { [ -n "$ST" ] && echo "[ICC] Server unreachable — reconnect MCP with /mcp"; true; }`;
  return {
    target: '~/.claude/settings.json',
    mergeKey: 'hooks',
    config: {
      SessionStart: [
        { matcher: 'startup', hooks: [{ type: 'command', command: startupCmd }] },
        { matcher: 'resume', hooks: [{ type: 'command', command: startupCmd }] },
        { matcher: 'compact', hooks: [{ type: 'command', command: heartbeatCmd }] },
        { matcher: 'clear', hooks: [{ type: 'command', command: startupCmd }] },
      ],
      UserPromptSubmit: [
        { hooks: [{ type: 'command', command: heartbeatCmd }] },
      ],
      PreToolUse: [
        {
          matcher: 'Bash',
          hooks: [{ type: 'command', command: `cat | curl -sf -X POST ${localBaseUrl}/api/hook/pre-bash${authHeader} -H 'Content-Type: application/json' -d @-` }],
        },
        {
          matcher: 'mcp__icc__send_message|mcp__icc__respond_to_message',
          hooks: [{ type: 'command', command: `cat | curl -sf -X POST ${localBaseUrl}/api/hook/pre-icc-message${authHeader} -H 'Content-Type: application/json' -d @-` }],
        },
      ],
      SessionEnd: [
        {
          hooks: [{
            type: 'command',
            command: `ST=$(cat /tmp/icc-session-$PPID.token 2>/dev/null); [ -n "$ST" ] && curl -sf -X POST ${localBaseUrl}/api/hook/session-end${authHeader} -H 'Content-Type: application/json' -d "{\\"sessionToken\\":\\"$ST\\"}" || true; rm -f /tmp/icc-session-$PPID.token`,
          }],
        },
      ],
    },
  };
}

export interface SkillEntry {
  target: string;
  content: string;
}

export interface SkillsTemplate {
  watch: SkillEntry;
  snooze: SkillEntry;
  wake: SkillEntry;
  sync: SkillEntry;
}

export function buildSkillsTemplate(config: ICCConfig): SkillsTemplate {
  return detectMode(config) === 'docker'
    ? buildDockerSkills(config)
    : buildBareMetalSkills(config);
}

function buildDockerSkills(config: ICCConfig): SkillsTemplate {
  const localBaseUrl = `http://localhost:${config.server.localhostHttpPort}`;
  const authHeader = config.server.localToken ? ` -H 'Authorization: Bearer ${config.server.localToken}'` : '';
  return {
    watch: {
      target: '~/.claude/skills/watch/SKILL.md',
      content: `---
name: watch
description: Activate ICC — register instance with server and launch mail watcher
disable-model-invocation: true
user-invocable: true
args: [--force] [--name <alt-name>]
---

# ICC Activation (Docker)

Register this instance with the ICC server and launch the mail watcher.
This is the activation point for a session — startup only checks status,
\`/watch\` activates.

## Steps

1. **Check if a watcher is already running.** Use \`TaskOutput\` with
   \`block: false\` on any known watcher task ID, or list background
   tasks with \`/tasks\`. If a watcher task exists and is still running,
   tell the user it's already active and do nothing else.

2. **Resolve the instance name.** Run \`basename $PWD\` using the Bash tool
   and save the result as INSTANCE. Use this literal value in all subsequent
   steps — do NOT use \`$(basename $PWD)\` command substitution in later
   commands, as it triggers user confirmation prompts that break the
   automatic watcher lifecycle.

3. **Register with the server.** Run this using the Bash tool:
   \`\`\`bash
   curl -sf -X POST ${localBaseUrl}/api/hook/watch${authHeader} \\
     -H 'Content-Type: application/json' \\
     -d '{"instance":"INSTANCE","pid":0}'
   \`\`\`
   (Replace INSTANCE with the value from step 2.)
   Add \`,"force":true\` to the JSON if user passed \`--force\`.
   Add \`,"name":"<alt>"\` if user passed \`--name\`.

4. **Parse the response and handle:**
   - If \`status\` is \`"deferred"\`: show the conflict to the user with options:
     - \`/watch --force\` — evict the other session and take over
     - \`/watch --name <alt>\` — register under a different name
     - Cancel
   - If \`status\` is \`"active"\`: save the session token:
     \`\`\`bash
     echo "SESSION_TOKEN_VALUE" > /tmp/icc-session-$PPID.token
     \`\`\`
     (Replace SESSION_TOKEN_VALUE with the \`sessionToken\` from the response.)

5. **Launch the watcher.** Use the Bash tool with \`run_in_background: true\`
   and \`timeout: 600000\`:
   \`\`\`bash
   curl -s${authHeader} "${localBaseUrl}/api/watch?instance=INSTANCE&sessionToken=TOKEN"
   \`\`\`
   (Replace INSTANCE and TOKEN with the values from steps 2 and 4.)

6. **Confirm activation:** "ICC activated. Watching for messages."

7. When the background task completes later, read its output and handle:
   - If output contains \`"stale_token"\`: the session token was invalidated
     (likely because the ICC container was restarted). Delete the stale
     token file with \`rm -f /tmp/icc-session-$PPID.token\`, then silently
     re-run this skill from step 3 (re-register) to acquire a fresh token
     and relaunch the watcher. Do not tell the user — recovery is automatic.
   - If output contains \`"mail"\`: call \`check_messages\` MCP tool, then
     relaunch from step 5 (the existing token is still valid).
   - Otherwise (connection dropped, process killed): silently relaunch
     from step 5 (the existing token is still valid; the connection just
     dropped transiently).`,
    },
    snooze: {
      target: '~/.claude/skills/snooze/SKILL.md',
      content: `---
name: snooze
description: Suppress automatic ICC mail watcher launches for this session
disable-model-invocation: true
user-invocable: true
---

# ICC Watcher Snooze (Docker)

Suppress automatic watcher launches and deregister from the server.

## Steps

1. Read the session token:
   \`\`\`bash
   cat /tmp/icc-session-$PPID.token
   \`\`\`

2. Deregister with the server:
   \`\`\`bash
   curl -sf -X POST ${localBaseUrl}/api/hook/snooze${authHeader} \\
     -H 'Content-Type: application/json' \\
     -d '{"sessionToken":"TOKEN"}'
   \`\`\`
   (Replace TOKEN with the value from step 1.)

3. Remove the token file:
   \`\`\`bash
   rm -f /tmp/icc-session-$PPID.token
   \`\`\`

4. Confirm: "ICC watcher snoozed. Use \`/wake\` to re-enable."`,
    },
    wake: {
      target: '~/.claude/skills/wake/SKILL.md',
      content: `---
name: wake
description: Re-enable ICC mail watcher after snoozing
disable-model-invocation: true
user-invocable: true
---

# ICC Watcher Wake (Docker)

Re-register with the server and launch the watcher.

## Steps

1. **Resolve the instance name.** Run \`basename $PWD\` using the Bash tool
   and save the result as INSTANCE. Use this literal value in all subsequent
   steps — do NOT use \`$(basename $PWD)\` command substitution in later
   commands, as it triggers user confirmation prompts that break the
   automatic watcher lifecycle.

2. **Re-register with the server:**
   \`\`\`bash
   curl -sf -X POST ${localBaseUrl}/api/hook/watch${authHeader} \\
     -H 'Content-Type: application/json' \\
     -d '{"instance":"INSTANCE","pid":0,"force":true}'
   \`\`\`
   (Replace INSTANCE with the value from step 1.)

3. **Save the new session token** from the response:
   \`\`\`bash
   echo "SESSION_TOKEN_VALUE" > /tmp/icc-session-$PPID.token
   \`\`\`

4. **Launch the watcher.** Use the Bash tool with \`run_in_background: true\`
   and \`timeout: 600000\`:
   \`\`\`bash
   curl -s${authHeader} "${localBaseUrl}/api/watch?instance=INSTANCE&sessionToken=TOKEN"
   \`\`\`
   (Replace INSTANCE and TOKEN with the values from steps 1 and 3.)

5. Confirm: "ICC watcher re-activated."`,
    },
    sync: {
      target: '~/.claude/skills/sync/SKILL.md',
      content: `---
name: sync
description: Reconcile local ICC config files against the server's canonical /setup/claude-code payload (Docker mode)
disable-model-invocation: true
user-invocable: true
---

# ICC Sync (Docker)

Reconcile local ICC config files against the server's canonical \`/setup/claude-code\` payload. This is a hand-driven classify-apply-update procedure because Docker hosts have no \`icc\` CLI.

## Background

Managed files (each with its own "owned region"):
- \`~/.claude.json\` — JSON subtree \`mcpServers.icc\`
- \`~/.claude/settings.json\` — JSON subtree \`hooks\`
- \`~/.claude/CLAUDE.md\` — region between \`<!-- ICC:BEGIN -->\` and \`<!-- ICC:END -->\` markers
- \`~/.claude/skills/watch/SKILL.md\`, \`~/.claude/skills/snooze/SKILL.md\`, \`~/.claude/skills/wake/SKILL.md\`, \`~/.claude/skills/sync/SKILL.md\` — whole files under \`~/.claude/skills/\`

The applied-config manifest is stored INSIDE the ICC container at \`/home/icc/.icc/applied-config-manifest.<IDENTITY>.json\` (persisted in the existing \`icc-data\` volume — same volume that holds the container's \`config.json\` and \`inbox.db\`). **The host has zero ICC state** — the manifest is read and written via \`docker exec icc\`. This skill assumes the container is named \`icc\` (the default in \`docker-compose.yml\`). The manifest tracks which version of each file was last applied. The sync skill classifies each file as:
- **unchanged** — current local matches manifest matches server → nothing to do
- **clean-update** — current local matches manifest but server has a newer version → auto-apply
- **hand-edited** — current local differs from manifest → prompt the user (apply / skip / abort)

## Steps

1. **Sanity check the container is running.** All manifest reads/writes go through \`docker exec icc\`, so a stopped container would fail later in confusing ways. Bail out early with a clear message:
   \`\`\`bash
   docker inspect -f '{{.State.Running}}' icc 2>/dev/null | grep -q true || { echo "ICC container 'icc' is not running. Start it with: docker compose up -d"; exit 1; }
   \`\`\`

2. **Fetch the canonical payload** via the Bash tool:
   \`\`\`bash
   curl -sf -H 'Authorization: Bearer ${config.server.localToken}' ${localBaseUrl}/setup/claude-code > /tmp/icc-setup-fetch.json
   \`\`\`
   If this fails, stop and tell the user the server is unreachable.

3. **Extract identity and manifest path.** The host identity is baked into the setup payload by the server. The manifest path points INSIDE the container (no host-side state):
   \`\`\`bash
   IDENTITY=$(jq -r .identity /tmp/icc-setup-fetch.json)
   MANIFEST_PATH="/home/icc/.icc/applied-config-manifest.$IDENTITY.json"
   VERSION=$(jq -r .version /tmp/icc-setup-fetch.json)
   echo "server version: $VERSION"
   echo "manifest path (inside container): $MANIFEST_PATH"
   \`\`\`
   The manifest lives in the container's existing \`icc-data\` volume, alongside \`config.json\` and \`inbox.db\`. **No directory or file is created on the host.** All manifest reads/writes go through \`docker exec icc\`.

4. **Read the stored manifest from inside the container** (may not exist on first sync):
   \`\`\`bash
   STORED_MANIFEST=$(docker exec icc cat "$MANIFEST_PATH" 2>/dev/null || echo '')
   if [ -n "$STORED_MANIFEST" ]; then
     STORED_VERSION=$(echo "$STORED_MANIFEST" | jq -r .version 2>/dev/null || echo null)
   else
     STORED_VERSION=null
   fi
   echo "stored version: $STORED_VERSION"
   \`\`\`
   If \`STORED_VERSION\` equals \`VERSION\`, the config is already at the server version — but still proceed to per-file classification in case files were hand-edited.

5. **For each managed file, compute three SHA-256 hashes:**
   - **local hash** — the current content of the local "owned region" (JSON subtree, marker-delimited region, or whole file)
   - **stored hash** — per-file hash recorded in the in-container manifest under \`.files["<path>"].hash\` (or empty on first sync). Read it from \`$STORED_MANIFEST\` (already cat'd from the container in step 3).
   - **server hash** — hash of the server's proposed content from \`/tmp/icc-setup-fetch.json\`

   For JSON subtrees, hash a canonical representation. Example for \`~/.claude.json\`:
   \`\`\`bash
   LOCAL=$(jq -cS '.mcpServers.icc // {}' ~/.claude.json 2>/dev/null || echo '{}')
   LOCAL_HASH=$(printf '%s' "$LOCAL" | sha256sum | awk '{print $1}')
   SERVER=$(jq -cS '.mcp.config' /tmp/icc-setup-fetch.json)
   SERVER_HASH=$(printf '%s' "$SERVER" | sha256sum | awk '{print $1}')
   STORED_HASH=$(echo "$STORED_MANIFEST" | jq -r '.files["~/.claude.json"].hash // ""' 2>/dev/null || echo "")
   \`\`\`

   For \`~/.claude/settings.json\`, the same pattern applies on the \`.hooks\` subtree (use \`.hooks.config\` from the fetched payload as the server side).

   For \`~/.claude/CLAUDE.md\`, the "owned region" is the content **between** \`<!-- ICC:BEGIN -->\` and \`<!-- ICC:END -->\` — **EXCLUSIVE of the marker lines themselves**. This matches \`hashClaudeMdRegion\` in \`src/manifest.ts\` and the case-1 awk replacement in step 9. Worked example:
   \`\`\`bash
   # Extract the inner region (exclusive of marker lines), trim leading/trailing blanks
   LOCAL_INNER=$(awk '/<!-- ICC:BEGIN/{flag=1; next} /<!-- ICC:END/{flag=0} flag' ~/.claude/CLAUDE.md 2>/dev/null | sed -e :a -e '/^$/{$d;N;ba' -e '}' | sed -e :a -e '/^$/{N;ba' -e '}' || echo '')
   LOCAL_HASH=$(printf '%s' "$LOCAL_INNER" | sha256sum | awk '{print $1}')
   # Server side: jq returns the canonical inner content already
   SERVER=$(jq -r '.claudeMd.content' /tmp/icc-setup-fetch.json)
   SERVER_HASH=$(printf '%s' "$SERVER" | sha256sum | awk '{print $1}')
   STORED_HASH=$(echo "$STORED_MANIFEST" | jq -r '.files["~/.claude/CLAUDE.md"].hash // ""' 2>/dev/null || echo "")
   \`\`\`
   On first sync (no markers in the file yet) the awk extraction returns empty, so \`LOCAL_HASH\` is the SHA-256 of the empty string — unique and distinct from \`SERVER_HASH\`, so the file classifies as \`clean-update\` correctly.

   For each skill file under \`~/.claude/skills/\`, the owned region is the WHOLE file (we wrote it from scratch). Just \`sha256sum\` the file directly:
   \`\`\`bash
   LOCAL_HASH=$(sha256sum ~/.claude/skills/watch/SKILL.md 2>/dev/null | awk '{print $1}' || echo "")
   SERVER_HASH=$(jq -r '.skills.watch.content' /tmp/icc-setup-fetch.json | sha256sum | awk '{print $1}')
   STORED_HASH=$(echo "$STORED_MANIFEST" | jq -r '.files["~/.claude/skills/watch/SKILL.md"].hash // ""' 2>/dev/null || echo "")
   \`\`\`
   Repeat for snooze, wake, sync.

6. **Classify each file** based on the three hashes:
   - \`local == server\` → **unchanged** (no-op)
   - \`local == stored && stored != server\` → **clean-update** (auto-apply)
   - \`local != stored\` → **hand-edited** (prompt user)
   - On first sync (\`STORED_VERSION == null\`): if \`local == server\` treat as unchanged; if file is absent or empty treat as clean-update; otherwise treat as hand-edited.

7. **For each hand-edited file**, print the file path, a short diff hint (e.g. \`diff <(...) <(...)\`), and ask the user one of: \`apply\` / \`skip\` / \`abort\`. Collect ALL answers before writing anything.

8. **If any answer is \`abort\`**, print "Aborted. No files written." and exit without touching the manifest.

9. **Otherwise, apply all clean-update and apply-confirmed files** using atomic tempfile + mv:

   - **\`~/.claude.json\`** — replace \`mcpServers.icc\` subtree:
     \`\`\`bash
     NEW=$(jq -c '.mcp.config' /tmp/icc-setup-fetch.json)
     jq --argjson new "$NEW" '.mcpServers.icc = $new' ~/.claude.json > ~/.claude.json.tmp && mv ~/.claude.json.tmp ~/.claude.json
     \`\`\`

   - **\`~/.claude/settings.json\`** — replace \`hooks\` subtree:
     \`\`\`bash
     NEW=$(jq -c '.hooks.config' /tmp/icc-setup-fetch.json)
     jq --argjson new "$NEW" '.hooks = $new' ~/.claude/settings.json > ~/.claude/settings.json.tmp && mv ~/.claude/settings.json.tmp ~/.claude/settings.json
     \`\`\`

   - **\`~/.claude/CLAUDE.md\`** — migrate the file using the four-case rule that mirrors \`migrateClaudeMd\` in \`src/manifest.ts\`. Run the following bash block (it handles all four cases: marker-replace, canonical-H1-replace, fuzzy-warn-and-append, plain-append):
     \`\`\`bash
     NEW_INNER=$(jq -r '.claudeMd.content' /tmp/icc-setup-fetch.json)
     EXISTING=$(cat ~/.claude/CLAUDE.md 2>/dev/null || true)
     if printf '%s' "$EXISTING" | grep -q '<!-- ICC:BEGIN'; then
       # Case 1: markers already present — replace the region
       awk -v new="$NEW_INNER" '
         /<!-- ICC:BEGIN/ { print "<!-- ICC:BEGIN -->"; print new; print "<!-- ICC:END -->"; in_region=1; next }
         /<!-- ICC:END/ { in_region=0; next }
         !in_region { print }
       ' ~/.claude/CLAUDE.md > ~/.claude/CLAUDE.md.tmp
     elif printf '%s' "$EXISTING" | grep -qE '^# ICC (Inbox|Activation|Config Drift)'; then
       # Case 2: canonical ICC H1 region present — replace contiguous region with marker block
       FIRST=$(printf '%s' "$EXISTING" | grep -nE '^# ICC (Inbox|Activation|Config Drift)' | head -1 | cut -d: -f1)
       LAST=$(printf '%s' "$EXISTING" | awk -v start="$FIRST" 'NR>start && /^# / && !/^# ICC/ {print NR-1; exit}')
       if [ -z "$LAST" ]; then LAST=$(printf '%s' "$EXISTING" | wc -l); fi
       {
         printf '%s' "$EXISTING" | sed -n "1,$((FIRST-1))p" | sed -e :a -e '/^$/{$d;N;ba' -e '}'
         echo
         echo "<!-- ICC:BEGIN -->"
         printf '%s\\n' "$NEW_INNER"
         echo "<!-- ICC:END -->"
         printf '%s' "$EXISTING" | sed -n "$((LAST+1)),\\\$p" | sed '/./,$!d'
       } > ~/.claude/CLAUDE.md.tmp
     elif printf '%s' "$EXISTING" | grep -qE '^#{1,6}[[:space:]]+ICC\\b'; then
       # Case 3: fuzzy ICC heading at non-canonical level — append + warn
       echo "[ICC] Possible ICC content detected outside marker region — please remove old content manually if duplicated." >&2
       {
         printf '%s\\n' "$EXISTING"
         echo
         echo "<!-- ICC:BEGIN -->"
         printf '%s\\n' "$NEW_INNER"
         echo "<!-- ICC:END -->"
       } > ~/.claude/CLAUDE.md.tmp
     else
       # Case 4: no ICC content at all — append (or create from scratch)
       {
         if [ -n "$EXISTING" ]; then printf '%s\\n\\n' "$EXISTING"; fi
         echo "<!-- ICC:BEGIN -->"
         printf '%s\\n' "$NEW_INNER"
         echo "<!-- ICC:END -->"
       } > ~/.claude/CLAUDE.md.tmp
     fi
     mv ~/.claude/CLAUDE.md.tmp ~/.claude/CLAUDE.md
     \`\`\`
     This block is intentionally verbose because shell-based heading detection has no equivalent of TypeScript's \`migrateClaudeMd\` — the four cases must be unrolled inline. The behavior matches \`src/manifest.ts:migrateClaudeMd\` byte-for-byte where it matters: H1 ICC regions get replaced (not duplicated), non-canonical headings get a stderr warning instead of silent clobber, and re-running /sync is idempotent because case 1 (markers present) becomes the path on the second run.

   - **Skill files** under \`~/.claude/skills/\` — write the whole file (content is in \`.skills.<name>.content\` in the fetched payload):
     \`\`\`bash
     mkdir -p ~/.claude/skills/sync
     jq -r '.skills.sync.content' /tmp/icc-setup-fetch.json > ~/.claude/skills/sync/SKILL.md.tmp && mv ~/.claude/skills/sync/SKILL.md.tmp ~/.claude/skills/sync/SKILL.md
     \`\`\`
     Repeat for watch, snooze, wake.

10. **Update the manifest atomically inside the container** with two-level semantics. The manifest lives at \`$MANIFEST_PATH\` inside the \`icc\` container; all reads and writes go through \`docker exec\`.
   - **Per-file hashes:** advance \`.files["<path>"].hash\` for each successful write; preserve the prior hash for skipped/failed files.
   - **Top-level \`version\`:** advance to \`$VERSION\` only if EVERY file succeeded AND no hand-edited files were skipped; otherwise leave the top-level version unchanged.
   - **Build the new manifest in the host's shell** (using jq on \`$STORED_MANIFEST\` plus the per-file hashes you computed in step 4), then **stream it INTO the container** via \`tee\`. Example shape:
     \`\`\`bash
     # If first sync, seed an empty manifest in shell
     if [ -z "$STORED_MANIFEST" ]; then STORED_MANIFEST='{"version":null,"files":{}}'; fi

     # Build the new manifest by chaining jq updates for each successfully-written file.
     # (Adjust the .files[...].hash assignments to match the files you actually applied.)
     NEW_MANIFEST=$(echo "$STORED_MANIFEST" | jq \\
       --arg v "$VERSION" \\
       --arg claudeJsonHash "$CLAUDEJSON_HASH" \\
       --arg settingsHash "$SETTINGS_HASH" \\
       --arg claudeMdHash "$CLAUDEMD_HASH" \\
       --arg watchHash "$WATCH_HASH" \\
       --arg snoozeHash "$SNOOZE_HASH" \\
       --arg wakeHash "$WAKE_HASH" \\
       --arg syncHash "$SYNC_HASH" \\
       '.version = $v
        | .files["~/.claude.json"].hash = $claudeJsonHash
        | .files["~/.claude/settings.json"].hash = $settingsHash
        | .files["~/.claude/CLAUDE.md"].hash = $claudeMdHash
        | .files["~/.claude/skills/watch/SKILL.md"].hash = $watchHash
        | .files["~/.claude/skills/snooze/SKILL.md"].hash = $snoozeHash
        | .files["~/.claude/skills/wake/SKILL.md"].hash = $wakeHash
        | .files["~/.claude/skills/sync/SKILL.md"].hash = $syncHash
        | .appliedAt = (now | todateiso8601)')

     # Atomic-ish write inside the container: write to tempfile then mv
     echo "$NEW_MANIFEST" | docker exec -i icc tee "$MANIFEST_PATH.tmp" > /dev/null
     docker exec icc mv "$MANIFEST_PATH.tmp" "$MANIFEST_PATH"
     \`\`\`
     If a particular file was not successfully applied (skipped or failed), use the prior hash from \`$STORED_MANIFEST\` for that entry instead of the new hash. The two-level rule for the top-level \`.version\` field still applies: advance only on full reconciliation.

11. **Print a summary** grouped by \`restartCategories[category].action\` from the payload:
    - Applied (N files)
    - Skipped (N files with local edits)
    - Failed (N files — re-run \`/sync\` to retry)
    - Restart actions needed: group by action. For each distinct \`action\` in the applied categories, print the category \`label\` (e.g. "Run /mcp", "Restart Claude Code"). Tell the user which action to take now vs. after the session.

## Notes

- Use \`Authorization: Bearer ${config.server.localToken}\` on the initial curl.
- Shell variables (\`$IDENTITY\`, \`$MANIFEST_PATH\`, \`$VERSION\`, \`$STORED_MANIFEST\`, \`$STORED_VERSION\`, \`$LOCAL_HASH\`, etc.) are evaluated at step execution time — do not try to precompute them.
- The container is assumed to be named \`icc\` (the default in \`docker-compose.yml\`). If you renamed it, adjust every \`docker exec icc ...\` invocation in this skill OR rename your container back to match.
- Always write via tempfile + mv so a failed write never corrupts the target file.
- If any step fails, stop immediately and report the failure — do NOT advance the manifest.`,
    },
  };
}

function buildBareMetalSkills(_config: ICCConfig): SkillsTemplate {
  return {
    watch: {
      target: '~/.claude/skills/watch/SKILL.md',
      content: `---
name: watch
description: Activate ICC — register instance with server and launch mail watcher
disable-model-invocation: true
user-invocable: true
args: [--force] [--name <alt-name>]
---

# ICC Activation (Bare-metal)

Register this instance with the ICC server and launch the mail watcher.

## Steps

1. **Check if a watcher is already running.** Use \`TaskOutput\` with \`block: false\` on any known watcher task ID. If a watcher task exists and is still running, tell the user it's already active and do nothing else.

2. **Launch the watcher** via the Bash tool with \`run_in_background: true\` and \`timeout: 600000\`:
   \`\`\`bash
   icc hook watch
   \`\`\`
   Add \`--force\` if the user passed \`--force\`. Add \`--name <alt>\` if the user passed \`--name\`.

3. **Confirm activation:** "ICC activated. Watching for messages."

4. When the background task completes later, read its output and handle:
   - If output contains \`[ICC] Stale session token\`: silently re-run this skill from step 2 (the watcher CLI handles re-registration internally; just relaunch).
   - If output contains \`[ICC] Mail received\`: call \`check_messages\` MCP tool, then relaunch from step 2.
   - Otherwise (connection dropped, process killed): silently relaunch from step 2.`,
    },
    snooze: {
      target: '~/.claude/skills/snooze/SKILL.md',
      content: `---
name: snooze
description: Suppress automatic ICC mail watcher launches for this session
disable-model-invocation: true
user-invocable: true
---

# ICC Watcher Snooze (Bare-metal)

Suppress automatic watcher launches.

## Steps

1. Run via the Bash tool:
   \`\`\`bash
   icc hook snooze-watcher
   \`\`\`

2. Confirm: "ICC watcher snoozed. Use \`/wake\` to re-enable."`,
    },
    wake: {
      target: '~/.claude/skills/wake/SKILL.md',
      content: `---
name: wake
description: Re-enable ICC mail watcher after snoozing
disable-model-invocation: true
user-invocable: true
---

# ICC Watcher Wake (Bare-metal)

Re-enable the watcher after a snooze.

## Steps

1. Run via the Bash tool:
   \`\`\`bash
   icc hook wake-watcher
   \`\`\`

2. **Launch the watcher** via the Bash tool with \`run_in_background: true\` and \`timeout: 600000\`:
   \`\`\`bash
   icc hook watch
   \`\`\`

3. Confirm: "ICC watcher re-activated."`,
    },
    sync: {
      target: '~/.claude/skills/sync/SKILL.md',
      content: `---
name: sync
description: Reconcile local ICC config files against the server's canonical /setup/claude-code payload
disable-model-invocation: true
user-invocable: true
---

# ICC Sync (Bare-metal)

Reconcile local ICC config files (\`~/.claude.json\`, \`~/.claude/settings.json\`, \`~/.claude/CLAUDE.md\`, \`~/.claude/skills/{watch,snooze,wake,sync}/SKILL.md\`) against the server's canonical \`/setup/claude-code\` payload.

## Steps

1. Run via the Bash tool (interactive — it may prompt you for hand-edited files):
   \`\`\`bash
   icc hook sync
   \`\`\`

2. Read the output to the user verbatim. It includes:
   - Files applied
   - Files skipped (with local edits)
   - Failed files (if any)
   - Restart actions needed

3. If the user sees "Restart Claude Code" in the output, remind them to restart Claude Code when they're done with the current conversation.

4. If the user sees "Run /mcp" in the output, offer to do it after this skill completes.`,
    },
  };
}

function buildBareMetalHooks(_config: ICCConfig): HooksTemplate {
  const startup: HookEntry = { type: 'command', command: 'icc hook startup 2>/dev/null || true', timeout: 10 };
  const check: HookEntry = { type: 'command', command: 'icc hook check 2>/dev/null || true', timeout: 5 };
  return {
    target: '~/.claude/settings.json',
    mergeKey: 'hooks',
    config: {
      SessionStart: [
        { matcher: 'startup', hooks: [startup] },
        { matcher: 'resume', hooks: [startup] },
        { matcher: 'compact', hooks: [check] },
        { matcher: 'clear', hooks: [startup] },
      ],
      UserPromptSubmit: [
        { hooks: [check] },
      ],
      PreToolUse: [
        { matcher: 'Bash', hooks: [{ type: 'command', command: 'icc hook pre-bash 2>/dev/null || true', timeout: 3 }] },
        { matcher: 'mcp__icc__send_message|mcp__icc__respond_to_message', hooks: [{ type: 'command', command: 'icc hook pre-icc-message 2>/dev/null || true', timeout: 2 }] },
      ],
      SessionEnd: [
        { hooks: [{ type: 'command', command: 'icc hook session-end 2>/dev/null || true', timeout: 5 }] },
      ],
    },
  };
}

// ─────────────────────────────────────────────────────────────────────────
// Setup payload — composes hooks + skills + mcp + claudeMd + version
// ─────────────────────────────────────────────────────────────────────────

/**
 * Host-agnostic CLAUDE.md content. Moved verbatim from src/server.ts so the
 * /setup/claude-code endpoint and the manifest hashing both source from one
 * place. Update this when the content needs to change — do NOT keep two
 * copies in sync by hand.
 */
export const CLAUDE_MD_CONTENT = `# ICC Inbox

When a hook surfaces an unread message notification (e.g. "You have N unread messages"), you **must**:
1. Call \`check_messages\` (MCP tool) to read them
2. Briefly acknowledge the messages to the user
3. Use \`respond_to_message\` if a reply is warranted
4. Follow message conventions: prefix with \`[TOPIC: x]\`, and set the \`status\`
   parameter on \`send_message\`/\`respond_to_message\` (preferred) or suffix with
   \`[STATUS: WAITING_FOR_REPLY|FYI_ONLY|ACTION_NEEDED|RESOLVED]\` in body text

# ICC Activation & Mail Watcher

On session start, the startup hook outputs status: "ICC: connected, N unread.
Run /watch to activate." Do NOT auto-launch the watcher on startup. The user
or model invokes \`/watch\` to activate.

**Subagents (spawned via the Agent tool) must NOT launch or manage mail
watchers.** Only the root conversation handles the watcher lifecycle.

When the background watcher task completes, read its output and silently re-launch after handling:
- If output contains \`[ICC] Mail received\`: call \`check_messages\` MCP tool, then re-launch
- Otherwise (connection dropped, process killed): silently re-launch
Do not announce or comment on watcher restarts to the user.

The watcher has no cycling timer — it runs for the full session and only exits on mail receipt, session end, or unexpected process death. If the \`icc hook check\` safety net emits \`[ICC] Watcher not running\` on a later prompt, re-launch unless the watcher is snoozed.

If a watcher launch is denied by a hook or returns \`[ICC] Watcher already active\`, do nothing — another watcher is already handling this instance. Do not retry.

Known limitation: \`/clear\` kills the watcher — the model loses the background task ID and can't receive the completion notification. Recovery is automatic: \`SessionStart clear\` hook re-fires startup, and \`icc hook check\` on the next prompt emits \`[ICC] Watcher not running\`.`;

export interface McpEntry {
  target: string;        // '~/.claude.json'
  mergeKey: string;      // 'mcpServers.icc'
  config: Record<string, unknown>;
}

export interface ClaudeMdEntry {
  target: string;        // '~/.claude/CLAUDE.md'
  append: boolean;
  content: string;
}

export type RestartAction = 'in-session' | 'next-session' | 'immediate';

export interface RestartCategory {
  action: RestartAction;
  command: string | null;
  label: string;
}

export interface RestartCategories {
  mcp: RestartCategory;
  hooks: RestartCategory;
  skills: RestartCategory;
  claudeMd: RestartCategory;
}

export interface SetupPayload {
  version: string;             // 12-char content hash
  identity: string;            // host identity (so Docker /sync can read it without ~/.icc/config.json on host)
  hostMode: HostMode;
  instructions: string;
  mcp: McpEntry;
  hooks: HooksTemplate;
  claudeMd: ClaudeMdEntry;
  skills: SkillsTemplate;
  restartCategories: RestartCategories;
  postSetup: string;
}

const RESTART_CATEGORIES: RestartCategories = {
  mcp: { action: 'in-session', command: '/mcp', label: 'Run /mcp' },
  hooks: { action: 'next-session', command: null, label: 'Restart Claude Code' },
  skills: { action: 'immediate', command: null, label: 'No action needed' },
  claudeMd: { action: 'next-session', command: null, label: 'Restart Claude Code' },
};

const INSTRUCTIONS = 'Apply these configurations to integrate Claude Code with this ICC server. For each config file: create parent directories if needed, merge into existing content (do not overwrite unrelated keys). Write each skill file to the specified target path (create directories as needed). After writing all files, tell the user to restart Claude Code for MCP changes to take effect.';

const POST_SETUP = 'Restart Claude Code for MCP changes to take effect. After restart, the SessionStart hook will confirm ICC connectivity. Run /watch to activate the mail watcher.';

function buildMcpEntry(config: ICCConfig, mode: HostMode): McpEntry {
  if (mode === 'docker') {
    const port = config.server.localhostHttpPort;
    const tokenQuery = config.server.localToken ? `?token=${config.server.localToken}` : '';
    return {
      target: '~/.claude.json',
      mergeKey: 'mcpServers.icc',
      config: { type: 'http', url: `http://localhost:${port}/mcp${tokenQuery}` },
    };
  }
  // Bare-metal: stdio MCP via the icc CLI
  return {
    target: '~/.claude.json',
    mergeKey: 'mcpServers.icc',
    config: { type: 'stdio', command: 'icc', args: ['mcp'] },
  };
}

/**
 * Composes the full /setup/claude-code payload for this host. The version
 * field is a content hash of EVERYTHING ELSE in the payload, so any change
 * to mcp/hooks/skills/claudeMd causes the version to drift, and clients
 * (sub-project B's /sync skill) detect the drift via /api/hook/startup.
 *
 * IMPORTANT: version is per-host, NOT portable across the mesh. Both the
 * Docker mcp.url and the bare-metal mcp.args embed the host's localToken (or
 * lack thereof), so two structurally identical hosts will produce different
 * version hashes. This is by design — manifests are self-comparison only.
 * Do not introduce any code path that compares version across peers.
 */
export function buildSetupPayload(config: ICCConfig): SetupPayload {
  const hostMode = detectMode(config);
  const payloadWithoutVersion = {
    identity: config.identity,
    hostMode,
    instructions: INSTRUCTIONS,
    mcp: buildMcpEntry(config, hostMode),
    hooks: buildHooksTemplate(config),
    claudeMd: {
      target: '~/.claude/CLAUDE.md',
      append: true,
      content: CLAUDE_MD_CONTENT,
    },
    skills: buildSkillsTemplate(config),
    restartCategories: RESTART_CATEGORIES,
    postSetup: POST_SETUP,
  };
  const version = hashPayload(payloadWithoutVersion);
  return { version, ...payloadWithoutVersion };
}

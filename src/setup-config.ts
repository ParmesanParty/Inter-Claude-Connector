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
  const startupCmd = `curl -sf -m 1${authHeader} ${localBaseUrl}/api/health > /dev/null 2>&1 || { echo 'ICC: server not reachable. Run /mcp to reconnect, then /watch to activate.'; exit 0; }; curl -sf -X POST ${localBaseUrl}/api/hook/startup${authHeader} -H 'Content-Type: application/json' -d '{"instance":"'"$(basename $PWD)"'"}'`;
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
  // sync? added in B11/B13
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

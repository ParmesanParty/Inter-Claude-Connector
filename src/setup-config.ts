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
import type { ICCConfig } from './types.ts';

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

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

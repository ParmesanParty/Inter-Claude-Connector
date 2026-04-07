import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { detectMode, type HostMode } from '../src/setup-config.ts';
import type { ICCConfig } from '../src/types.ts';

function baseConfig(serverOverrides: Partial<ICCConfig['server']> = {}): ICCConfig {
  return {
    identity: 'test-host',
    instance: null,
    server: {
      port: 3179,
      host: '127.0.0.1',
      localToken: 'tok',
      peerTokens: {},
      tls: { enabled: false, certPath: null, keyPath: null, caPath: null },
      enrollPort: 4179,
      ...serverOverrides,
    },
    remotes: {},
    web: { host: '127.0.0.1', port: 3180 },
    tls: { ca: null },
    transport: { httpTimeout: 5000, healthCheckInterval: 30000 },
    security: {
      readfileEnabled: false,
      execEnabled: false,
      allowedPaths: [],
      allowedCommands: [],
      allowedSubcommands: {},
      maxExecTimeout: 30000,
    },
    claude: {
      outputFormat: 'text',
      noSessionPersistence: false,
      permissionMode: 'default',
      maxBudgetUsd: null,
      systemPromptAppend: null,
    } as ICCConfig['claude'],
  };
}

describe('setup-config: detectMode', () => {
  it('returns "docker" when localhostHttpPort is set', () => {
    const config = baseConfig({ localhostHttpPort: 3178 });
    const mode: HostMode = detectMode(config);
    assert.equal(mode, 'docker');
  });

  it('returns "bare-metal" when localhostHttpPort is not set', () => {
    assert.equal(detectMode(baseConfig()), 'bare-metal');
  });

  it('returns "bare-metal" when localhostHttpPort is explicitly null', () => {
    assert.equal(detectMode(baseConfig({ localhostHttpPort: null })), 'bare-metal');
  });
});

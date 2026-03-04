import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { isPathAllowed, isCommandAllowed, isSubcommandAllowed, safeReadFile, safeExec } from '../src/util/exec.ts';
import { clearConfigCache, loadConfig } from '../src/config.ts';
import { createICCServer } from '../src/server.ts';
import { reset as resetLog } from '../src/log.ts';
import { reset as resetInbox, init as initInbox } from '../src/inbox.ts';
import { request, type IncomingMessage } from 'node:http';
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

process.env.ICC_IDENTITY = 'test-host';
process.env.ICC_AUTH_TOKEN = 'test-token-123';
process.env.ICC_READFILE_ENABLED = 'false';
process.env.ICC_EXEC_ENABLED = 'false';

// Redirect log and inbox to temp directories so tests don't pollute ~/.icc/
const testLogDir = mkdtempSync(join(tmpdir(), 'icc-test-'));
resetLog(testLogDir);
resetInbox(testLogDir);
initInbox();

beforeEach(() => {
  clearConfigCache();
});

function httpRequest(port: number, method: string, path: string, body: any = null, token: string | null = 'test-token-123'): Promise<{ status: number | undefined; data: any }> {
  return new Promise((resolve, reject) => {
    const payload = body ? JSON.stringify(body) : null;
    const req = request(`http://127.0.0.1:${port}${path}`, {
      method,
      headers: {
        ...(payload && { 'Content-Type': 'application/json' }),
        ...(token && { 'Authorization': `Bearer ${token}` }),
      },
    }, (res: IncomingMessage) => {
      let data = '';
      res.on('data', (chunk: Buffer) => { data += chunk; });
      res.on('end', () => {
        resolve({
          status: res.statusCode,
          data: data ? JSON.parse(data) : null,
        });
      });
    });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

// --- Unit tests for validation helpers ---

describe('Path validation', () => {
  const allowed = ['~/code', '~/Code', '/tmp'];

  it('allows paths under ~/code', () => {
    assert.ok(isPathAllowed('~/code/project/file.js', allowed));
  });

  it('allows paths under /tmp', () => {
    assert.ok(isPathAllowed('/tmp/test.txt', allowed));
  });

  it('rejects paths outside allowed list', () => {
    assert.ok(!isPathAllowed('/etc/passwd', allowed));
    assert.ok(!isPathAllowed('~/secret/data', allowed));
  });

  it('rejects path traversal attempts', () => {
    assert.ok(!isPathAllowed('~/code/../.ssh/id_rsa', allowed));
  });

  it('allows exact prefix match', () => {
    assert.ok(isPathAllowed('~/code', allowed));
  });
});

describe('Command validation', () => {
  const allowed = ['ls', 'cat', 'head', 'tail', 'find', 'grep', 'git'];

  it('allows commands in the list', () => {
    assert.ok(isCommandAllowed('ls', allowed));
    assert.ok(isCommandAllowed('git', allowed));
  });

  it('rejects commands not in the list', () => {
    assert.ok(!isCommandAllowed('rm', allowed));
    assert.ok(!isCommandAllowed('curl', allowed));
    assert.ok(!isCommandAllowed('ssh', allowed));
    assert.ok(!isCommandAllowed('node', allowed));
    assert.ok(!isCommandAllowed('npm', allowed));
  });

  it('handles full paths by extracting base command', () => {
    assert.ok(isCommandAllowed('/usr/bin/git', allowed));
    assert.ok(!isCommandAllowed('/usr/bin/rm', allowed));
  });
});

describe('Subcommand validation', () => {
  const allowedSubs: Record<string, string[]> = {
    git: ['status', 'log', 'diff', 'show', 'branch', 'tag', 'blame', 'rev-parse', 'ls-files'],
  };

  it('allows read-only git subcommands', () => {
    assert.ok(isSubcommandAllowed('git', ['status'], allowedSubs));
    assert.ok(isSubcommandAllowed('git', ['log', '--oneline', '-10'], allowedSubs));
    assert.ok(isSubcommandAllowed('git', ['diff', 'HEAD~1'], allowedSubs));
    assert.ok(isSubcommandAllowed('git', ['branch', '-a'], allowedSubs));
  });

  it('rejects write git subcommands', () => {
    assert.ok(!isSubcommandAllowed('git', ['push'], allowedSubs));
    assert.ok(!isSubcommandAllowed('git', ['commit', '-m', 'msg'], allowedSubs));
    assert.ok(!isSubcommandAllowed('git', ['checkout', 'main'], allowedSubs));
    assert.ok(!isSubcommandAllowed('git', ['reset', '--hard'], allowedSubs));
    assert.ok(!isSubcommandAllowed('git', ['add', '.'], allowedSubs));
    assert.ok(!isSubcommandAllowed('git', ['merge', 'feature'], allowedSubs));
    assert.ok(!isSubcommandAllowed('git', ['rebase', 'main'], allowedSubs));
    assert.ok(!isSubcommandAllowed('git', ['rm', 'file.txt'], allowedSubs));
    assert.ok(!isSubcommandAllowed('git', ['clean', '-fd'], allowedSubs));
    assert.ok(!isSubcommandAllowed('git', ['stash'], allowedSubs));
  });

  it('allows bare command with only flags', () => {
    assert.ok(isSubcommandAllowed('git', ['--version'], allowedSubs));
    assert.ok(isSubcommandAllowed('git', ['-C', '/tmp'], allowedSubs));
  });

  it('skips leading flags to find subcommand', () => {
    assert.ok(isSubcommandAllowed('git', ['-C', '/tmp', 'status'], allowedSubs));
    assert.ok(!isSubcommandAllowed('git', ['-C', '/tmp', 'push'], allowedSubs));
  });

  it('allows any subcommand for unrestricted commands', () => {
    assert.ok(isSubcommandAllowed('ls', ['-la', '/tmp'], allowedSubs));
    assert.ok(isSubcommandAllowed('grep', ['-r', 'pattern', '.'], allowedSubs));
  });

  it('handles full paths by extracting base command', () => {
    assert.ok(isSubcommandAllowed('/usr/bin/git', ['status'], allowedSubs));
    assert.ok(!isSubcommandAllowed('/usr/bin/git', ['push'], allowedSubs));
  });
});

// --- Integration tests: disabled-by-default ---

describe('Security: disabled by default', () => {
  it('safeReadFile rejects when readfileEnabled=false', async () => {
    await assert.rejects(
      () => safeReadFile('/tmp/test.txt'),
      /disabled/
    );
  });

  it('safeExec rejects when execEnabled=false', async () => {
    await assert.rejects(
      () => safeExec('ls', []),
      /disabled/
    );
  });

  it('safeExec returns numeric exitCode for failed command', async () => {
    process.env.ICC_EXEC_ENABLED = 'true';
    clearConfigCache();
    const result = await safeExec('ls', ['/nonexistent-path-that-does-not-exist-12345']);
    assert.equal(typeof result.exitCode, 'number');
    assert.ok(result.exitCode > 0);
    process.env.ICC_EXEC_ENABLED = 'false';
    clearConfigCache();
  });
});

// --- Server endpoint tests ---

describe('Server: /api/readfile', () => {
  it('returns 403 when readfile is disabled', async () => {
    clearConfigCache();
    const config = loadConfig();
    config.remotes = {};
    config.server.tls = { enabled: false, certPath: null, keyPath: null, caPath: null };
    config.server.localToken = null;
    config.server.peerTokens = {};
    const s = createICCServer({ host: '127.0.0.1', port: 0 });
    const info = await s.start();
    try {
      const res = await httpRequest(info.port, 'POST', '/api/readfile', { path: '/tmp/test' });
      assert.equal(res.status, 403);
      assert.ok(res.data.error.includes('disabled'));
    } finally {
      await s.stop();
    }
  });

  it('returns 400 when path is missing', async () => {
    clearConfigCache();
    const config = loadConfig();
    config.remotes = {};
    config.server.tls = { enabled: false, certPath: null, keyPath: null, caPath: null };
    config.server.localToken = null;
    config.server.peerTokens = {};
    const s = createICCServer({ host: '127.0.0.1', port: 0 });
    const info = await s.start();
    try {
      const res = await httpRequest(info.port, 'POST', '/api/readfile', {});
      assert.equal(res.status, 400);
    } finally {
      await s.stop();
    }
  });
});

describe('Server: /api/exec', () => {
  it('returns 403 when exec is disabled', async () => {
    clearConfigCache();
    const config = loadConfig();
    config.remotes = {};
    config.server.tls = { enabled: false, certPath: null, keyPath: null, caPath: null };
    config.server.localToken = null;
    config.server.peerTokens = {};
    const s = createICCServer({ host: '127.0.0.1', port: 0 });
    const info = await s.start();
    try {
      const res = await httpRequest(info.port, 'POST', '/api/exec', { command: 'ls' });
      assert.equal(res.status, 403);
      assert.ok(res.data.error.includes('disabled'));
    } finally {
      await s.stop();
    }
  });

  it('returns 400 when command is missing', async () => {
    clearConfigCache();
    const config = loadConfig();
    config.remotes = {};
    config.server.tls = { enabled: false, certPath: null, keyPath: null, caPath: null };
    config.server.localToken = null;
    config.server.peerTokens = {};
    const s = createICCServer({ host: '127.0.0.1', port: 0 });
    const info = await s.start();
    try {
      const res = await httpRequest(info.port, 'POST', '/api/exec', {});
      assert.equal(res.status, 400);
    } finally {
      await s.stop();
    }
  });
});

// --- MCP tool handler tests ---

describe('MCP tools: read_remote_file', () => {
  it('returns file content on success', async () => {
    const { createToolHandlers } = await import('../src/mcp.ts');
    const mockPeerAPI = async (_peer: string, _method: string, _path: string, body: any) => ({
      content: 'file content here',
      path: body.path,
      size: 17,
    });
    const handlers = createToolHandlers({} as any, mockPeerAPI);
    const result = await handlers.readRemoteFile({ path: '~/code/file.txt', peer: 'peerA' });
    assert.equal(result.content[0]!.text, 'file content here');
    assert.ok(!result.isError);
  });

  it('returns error on failure', async () => {
    const { createToolHandlers } = await import('../src/mcp.ts');
    const mockPeerAPI = async () => { throw new Error('File reading is disabled'); };
    const handlers = createToolHandlers({} as any, mockPeerAPI);
    const result = await handlers.readRemoteFile({ path: '/etc/passwd', peer: 'peerA' });
    assert.ok(result.content[0]!.text.includes('disabled'));
    assert.ok(result.isError);
  });
});

describe('MCP tools: run_remote_command', () => {
  it('returns command output on success', async () => {
    const { createToolHandlers } = await import('../src/mcp.ts');
    const mockPeerAPI = async () => ({
      stdout: 'file1.txt\nfile2.txt\n',
      stderr: '',
      exitCode: 0,
    });
    const handlers = createToolHandlers({} as any, mockPeerAPI);
    const result = await handlers.runRemoteCommand({ command: 'ls', args: ['-la'], peer: 'peerA' });
    assert.ok(result.content[0]!.text.includes('file1.txt'));
    assert.ok(result.content[0]!.text.includes('exit code: 0'));
  });

  it('returns error on failure', async () => {
    const { createToolHandlers } = await import('../src/mcp.ts');
    const mockPeerAPI = async () => { throw new Error('Command not in allowed list: rm'); };
    const handlers = createToolHandlers({} as any, mockPeerAPI);
    const result = await handlers.runRemoteCommand({ command: 'rm', args: ['-rf', '/'], peer: 'peerA' });
    assert.ok(result.content[0]!.text.includes('not in allowed'));
    assert.ok(result.isError);
  });
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, writeFileSync, existsSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  ICC_MARKER_BEGIN,
  ICC_MARKER_END,
  readManifest,
  writeManifest,
  hashJsonSubtree,
  hashFileContents,
  extractClaudeMdRegion,
  hashClaudeMdRegion,
  wrapClaudeMdWithMarkers,
  type AppliedConfigManifest,
} from '../src/manifest.ts';

function tmp(): string {
  return mkdtempSync(join(tmpdir(), 'icc-manifest-test-'));
}

test('readManifest returns null when file missing', () => {
  const dir = tmp();
  assert.equal(readManifest(join(dir, 'nope.json')), null);
});

test('readManifest returns null on malformed JSON (does not throw)', () => {
  const dir = tmp();
  const p = join(dir, 'bad.json');
  writeFileSync(p, '{ not json');
  assert.equal(readManifest(p), null);
});

test('writeManifest + readManifest round-trip', () => {
  const dir = tmp();
  const p = join(dir, 'm.json');
  const m: AppliedConfigManifest = {
    version: 'abc123',
    appliedAt: '2026-04-07T00:00:00Z',
    files: { '~/.claude.json': 'deadbeef' },
  };
  writeManifest(p, m);
  assert.deepEqual(readManifest(p), m);
});

test('writeManifest is atomic (no leftover temp files)', () => {
  const dir = tmp();
  const p = join(dir, 'm.json');
  writeManifest(p, { version: 'v', appliedAt: 't', files: {} });
  const entries = readdirSync(dir);
  assert.deepEqual(entries, ['m.json']);
});

test('writeManifest writes mode 0600 with trailing newline', () => {
  const dir = tmp();
  const p = join(dir, 'm.json');
  writeManifest(p, { version: 'v', appliedAt: 't', files: {} });
  const content = readFileSync(p, 'utf8');
  assert.ok(content.endsWith('\n'));
  const mode = statSync(p).mode & 0o777;
  assert.equal(mode, 0o600);
});

test('hashJsonSubtree hashes only the named subtree, ignoring siblings', () => {
  const base = {
    mcpServers: {
      icc: { command: 'icc', args: ['serve'] },
      someOtherServer: { command: 'foo' },
    },
    someUnrelatedKey: { x: 1 },
  };
  const h1 = hashJsonSubtree(base, 'mcpServers.icc');

  const mutated1 = {
    mcpServers: {
      icc: { command: 'icc', args: ['serve'] },
      someOtherServer: { command: 'CHANGED' },
    },
    someUnrelatedKey: { x: 1 },
  };
  const mutated2 = {
    mcpServers: {
      icc: { command: 'icc', args: ['serve'] },
      someOtherServer: { command: 'foo' },
    },
    someUnrelatedKey: { x: 999, y: 'added' },
  };
  const mutated3 = {
    mcpServers: {
      icc: { command: 'icc', args: ['serve'] },
    },
  };
  assert.equal(hashJsonSubtree(mutated1, 'mcpServers.icc'), h1);
  assert.equal(hashJsonSubtree(mutated2, 'mcpServers.icc'), h1);
  assert.equal(hashJsonSubtree(mutated3, 'mcpServers.icc'), h1);
});

test('hashJsonSubtree returns 64-char hex', () => {
  const h = hashJsonSubtree({ a: { b: 1 } }, 'a');
  assert.match(h, /^[0-9a-f]{64}$/);
});

test('hashJsonSubtree differs when subtree contents differ', () => {
  const a = hashJsonSubtree({ a: { b: 1 } }, 'a');
  const b = hashJsonSubtree({ a: { b: 2 } }, 'a');
  assert.notEqual(a, b);
});

test('wrapClaudeMdWithMarkers produces content with begin/end markers', () => {
  const out = wrapClaudeMdWithMarkers('hello world');
  assert.ok(out.includes('<!-- ICC:BEGIN'));
  assert.ok(out.includes('<!-- ICC:END'));
  assert.equal(ICC_MARKER_BEGIN, '<!-- ICC:BEGIN -->');
  assert.equal(ICC_MARKER_END, '<!-- ICC:END -->');
});

test('extractClaudeMdRegion returns inner when present, null when absent', () => {
  const wrapped = wrapClaudeMdWithMarkers('inner content here');
  const full = `# Preamble\n\n${wrapped}\n\n# Postamble`;
  assert.equal(extractClaudeMdRegion(full), 'inner content here');
  assert.equal(extractClaudeMdRegion('# no markers here'), null);
});

test('hashClaudeMdRegion identical for byte-identical inner with different surroundings', () => {
  const inner = 'shared inner content\nline2';
  const wrapped = wrapClaudeMdWithMarkers(inner);
  const file1 = `# Preamble A\nstuff\n${wrapped}\nfooter A here\n`;
  const file2 = `Totally different preamble\n\nmore lines\n\n${wrapped}\n\nDifferent postamble entirely\n`;
  const h1 = hashClaudeMdRegion(file1);
  const h2 = hashClaudeMdRegion(file2);
  assert.ok(h1);
  assert.equal(h1, h2);
  assert.match(h1!, /^[0-9a-f]{64}$/);
});

test('hashClaudeMdRegion returns null when markers absent', () => {
  assert.equal(hashClaudeMdRegion('no markers anywhere'), null);
});

test('hashFileContents returns 64-char hex', () => {
  const h = hashFileContents('some content');
  assert.match(h, /^[0-9a-f]{64}$/);
});

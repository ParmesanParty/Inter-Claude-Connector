import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, writeFileSync, readFileSync, statSync } from 'node:fs';
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
  migrateClaudeMd,
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

const NEW_INNER = '# ICC Inbox\n\nNew inbox rules here.';

test('migrateClaudeMd: replaces inner when markers already present', () => {
  const existing = `# Preamble\n\n<!-- ICC:BEGIN -->\n# Old ICC\nold stuff\n<!-- ICC:END -->\n\n# Postamble`;
  const result = migrateClaudeMd(existing, NEW_INNER);
  assert.ok(result.includes('# Preamble'));
  assert.ok(result.includes('# Postamble'));
  assert.ok(!result.includes('old stuff'));
  assert.ok(result.includes('New inbox rules here.'));
  assert.ok(result.includes(ICC_MARKER_BEGIN));
  assert.ok(result.includes(ICC_MARKER_END));
});

test('migrateClaudeMd: replaces ICC H1 region when markers absent but canonical headings present', () => {
  const existing = `# Preamble\n\nSome intro.\n\n# ICC Inbox\n\nOld content.\n\n# ICC Activation & Mail Watcher\n\nOld watcher content.`;
  const result = migrateClaudeMd(existing, NEW_INNER);
  assert.ok(result.includes('# Preamble'));
  assert.ok(result.includes('Some intro.'));
  assert.ok(!result.includes('Old content.'));
  assert.ok(!result.includes('Old watcher content.'));
  assert.ok(result.includes('New inbox rules here.'));
  assert.ok(result.includes(ICC_MARKER_BEGIN));
  const extracted = extractClaudeMdRegion(result);
  assert.ok(extracted);
  assert.ok(extracted!.includes('New inbox rules here.'));
});

test('migrateClaudeMd: preserves non-ICC H1 sections that follow the ICC region', () => {
  const existing = `# Intro\n\n# ICC Inbox\n\nold inbox\n\n# My Other Section\n\nmine.`;
  const result = migrateClaudeMd(existing, NEW_INNER);
  assert.ok(result.includes('# Intro'));
  assert.ok(result.includes('# My Other Section'));
  assert.ok(result.includes('mine.'));
  assert.ok(!result.includes('old inbox'));
  assert.ok(result.includes('New inbox rules here.'));
});

test('migrateClaudeMd: appends wrapped block with warning when ICC-ish non-canonical heading is present', () => {
  const origWrite = process.stderr.write.bind(process.stderr);
  const captured: string[] = [];
  (process.stderr as any).write = (s: string | Buffer) => {
    captured.push(String(s));
    return true;
  };
  try {
    const existing = `# My Doc\n\n## ICC Inbox\n\nsomething.`;
    const result = migrateClaudeMd(existing, NEW_INNER);
    assert.ok(result.includes('## ICC Inbox'));
    assert.ok(result.includes('something.'));
    assert.ok(result.includes(ICC_MARKER_BEGIN));
    assert.ok(result.includes('New inbox rules here.'));
    assert.ok(captured.some((line) => line.includes('Possible ICC content detected')));
  } finally {
    (process.stderr as any).write = origWrite;
  }
});

test('migrateClaudeMd: appends wrapped block with no warning when file has no ICC content', () => {
  const origWrite = process.stderr.write.bind(process.stderr);
  const captured: string[] = [];
  (process.stderr as any).write = (s: string | Buffer) => {
    captured.push(String(s));
    return true;
  };
  try {
    const existing = `# My Doc\n\nNothing ICC-related here.`;
    const result = migrateClaudeMd(existing, NEW_INNER);
    assert.ok(result.includes('# My Doc'));
    assert.ok(result.includes('Nothing ICC-related here.'));
    assert.ok(result.includes(ICC_MARKER_BEGIN));
    assert.ok(result.includes('New inbox rules here.'));
    assert.ok(!captured.some((line) => line.includes('Possible ICC content')));
  } finally {
    (process.stderr as any).write = origWrite;
  }
});

test('migrateClaudeMd: creates content from scratch when file is empty', () => {
  const result = migrateClaudeMd('', NEW_INNER);
  assert.ok(result.includes(ICC_MARKER_BEGIN));
  assert.ok(result.includes(ICC_MARKER_END));
  assert.ok(result.includes('New inbox rules here.'));
});

test('migrateClaudeMd: is idempotent — migrate(migrate(x)) === migrate(x)', () => {
  const existing = `# Preamble\n\nstuff.`;
  const once = migrateClaudeMd(existing, NEW_INNER);
  const twice = migrateClaudeMd(once, NEW_INNER);
  assert.equal(extractClaudeMdRegion(once), extractClaudeMdRegion(twice));
  const beginMatches = (twice.match(/<!-- ICC:BEGIN/g) || []).length;
  const endMatches = (twice.match(/<!-- ICC:END/g) || []).length;
  assert.equal(beginMatches, 1);
  assert.equal(endMatches, 1);
});

test('migrateClaudeMd: preserves H2 ICC headings without replacement (fuzzy fall-through)', () => {
  const origWrite = process.stderr.write.bind(process.stderr);
  (process.stderr as any).write = () => true;
  try {
    const existing = `## ICC Inbox\n\nH2 not H1.`;
    const result = migrateClaudeMd(existing, NEW_INNER);
    assert.ok(result.includes('## ICC Inbox'));
    assert.ok(result.includes('H2 not H1.'));
  } finally {
    (process.stderr as any).write = origWrite;
  }
});

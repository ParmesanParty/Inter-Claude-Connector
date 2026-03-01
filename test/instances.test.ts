import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { sanitize, resolve, listAll, loadIndex, reset } from '../src/instances.ts';

// Each test group gets its own temp dir
function freshDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'icc-instances-test-'));
  reset(dir);
  return dir;
}

// --- sanitize() ---

describe('sanitize', () => {
  it('lowercases input', () => {
    assert.equal(sanitize('MyProject'), 'myproject');
  });

  it('replaces non-alphanum with hyphens and strips trailing ones', () => {
    // '!' becomes '-', then trailing '-' is stripped
    assert.equal(sanitize('my project!'), 'my-project');
  });

  it('collapses consecutive hyphens', () => {
    assert.equal(sanitize('a---b'), 'a-b');
  });

  it('strips leading and trailing hyphens', () => {
    assert.equal(sanitize('---hello---'), 'hello');
  });

  it('truncates to 32 characters', () => {
    const long = 'a'.repeat(50);
    assert.equal(sanitize(long).length, 32);
  });

  it('returns "default" for empty/whitespace-only strings', () => {
    assert.equal(sanitize(''), 'default');
    assert.equal(sanitize('   '), 'default');
    assert.equal(sanitize('---'), 'default');
  });

  it('preserves underscores', () => {
    assert.equal(sanitize('my_project'), 'my_project');
  });

  it('preserves already-valid names', () => {
    assert.equal(sanitize('inter-claude-connector'), 'inter-claude-connector');
  });
});

// --- resolve() ---

describe('resolve: basic', () => {
  beforeEach(freshDir);

  it('derives name from directory basename', () => {
    const name = resolve('/home/user/my-project');
    assert.equal(name, 'my-project');
  });

  it('returns the same name on repeated calls for the same path', () => {
    const a = resolve('/home/user/my-project');
    const b = resolve('/home/user/my-project');
    assert.equal(a, b);
  });

  it('persists the mapping to disk', () => {
    resolve('/home/user/my-project');
    const index = loadIndex();
    assert.equal(index['my-project'], '/home/user/my-project');
  });

  it('sanitizes the basename', () => {
    // 'My Project!' → sanitize → 'my-project' (trailing hyphen from '!' is stripped)
    const name = resolve('/home/user/My Project!');
    assert.equal(name, 'my-project');
  });
});

describe('resolve: collision handling', () => {
  beforeEach(freshDir);

  it('suffixes with -2 when name is taken by different path', () => {
    const first = resolve('/home/user/alpha/project');
    const second = resolve('/home/user/beta/project');
    assert.equal(first, 'project');
    assert.equal(second, 'project-2');
  });

  it('suffixes with -3 when -2 is also taken', () => {
    resolve('/home/user/alpha/project');
    resolve('/home/user/beta/project');
    const third = resolve('/home/user/gamma/project');
    assert.equal(third, 'project-3');
  });

  it('returns existing name when same path re-registered after collision', () => {
    const first = resolve('/home/user/alpha/project');
    resolve('/home/user/beta/project');
    const again = resolve('/home/user/alpha/project');
    assert.equal(again, first); // not project-3
  });
});

// --- listAll() ---

describe('listAll', () => {
  beforeEach(freshDir);

  it('returns empty array when no entries', () => {
    assert.deepEqual(listAll(), []);
  });

  it('returns all entries as { name, path } objects', () => {
    resolve('/home/user/project-a');
    resolve('/home/user/project-b');
    const entries = listAll();
    assert.equal(entries.length, 2);
    assert.ok(entries.every(e => 'name' in e && 'path' in e));
    const names = entries.map(e => e.name).sort();
    assert.deepEqual(names, ['project-a', 'project-b']);
  });
});

// --- reset() ---

describe('reset', () => {
  it('redirects index path to a new temp dir', () => {
    const dir1 = mkdtempSync(join(tmpdir(), 'icc-instances-reset-a-'));
    const dir2 = mkdtempSync(join(tmpdir(), 'icc-instances-reset-b-'));

    reset(dir1);
    resolve('/home/user/foo');
    assert.equal(listAll().length, 1);

    reset(dir2);
    assert.equal(listAll().length, 0); // fresh dir, nothing there

    reset(dir1);
    assert.equal(listAll().length, 1); // back to dir1
  });
});

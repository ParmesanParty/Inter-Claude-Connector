import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { parseAddress, buildAddress, addressMatches } from '../src/address.ts';

describe('parseAddress', () => {
  it('parses host/instance address', () => {
    const result = parseAddress('alpha/webapp');
    assert.deepEqual(result, { host: 'alpha', instance: 'webapp' });
  });

  it('parses bare hostname (no instance)', () => {
    const result = parseAddress('alpha');
    assert.deepEqual(result, { host: 'alpha', instance: null });
  });

  it('handles empty string', () => {
    const result = parseAddress('');
    assert.deepEqual(result, { host: null, instance: null });
  });

  it('handles null/undefined', () => {
    assert.deepEqual(parseAddress(null as unknown as string), { host: null, instance: null });
    assert.deepEqual(parseAddress(undefined as unknown as string), { host: null, instance: null });
  });

  it('handles trailing slash (empty instance)', () => {
    const result = parseAddress('alpha/');
    assert.deepEqual(result, { host: 'alpha', instance: null });
  });

  it('only splits on first slash', () => {
    const result = parseAddress('alpha/webapp/extra');
    assert.deepEqual(result, { host: 'alpha', instance: 'webapp/extra' });
  });
});

describe('buildAddress', () => {
  it('builds host/instance address', () => {
    assert.equal(buildAddress('alpha', 'webapp'), 'alpha/webapp');
  });

  it('builds bare hostname when no instance', () => {
    assert.equal(buildAddress('alpha', null), 'alpha');
    assert.equal(buildAddress('alpha', ''), 'alpha');
  });

  it('returns empty string when no host', () => {
    assert.equal(buildAddress('', 'webapp'), '');
    assert.equal(buildAddress(null as unknown as string, 'webapp'), '');
  });
});

describe('addressMatches', () => {
  it('broadcast message matches any instance on same host', () => {
    // Message to "alpha" (broadcast) should match "alpha/webapp"
    assert.ok(addressMatches('alpha', 'alpha/webapp', 'alpha'));
  });

  it('broadcast message matches bare hostname query', () => {
    assert.ok(addressMatches('alpha', 'alpha', 'alpha'));
  });

  it('instance-targeted message matches exact instance', () => {
    assert.ok(addressMatches('alpha/webapp', 'alpha/webapp', 'alpha'));
  });

  it('instance-targeted message does NOT match different instance', () => {
    assert.ok(!addressMatches('alpha/webapp', 'alpha/dashboard', 'alpha'));
  });

  it('instance-targeted message matches bare hostname query (sees all)', () => {
    // Query without instance sees everything for that host
    assert.ok(addressMatches('alpha/webapp', 'alpha', 'alpha'));
  });

  it('message for different host does not match', () => {
    assert.ok(!addressMatches('bravo/webapp', 'alpha/webapp', 'alpha'));
  });

  it('broadcast for different host does not match', () => {
    assert.ok(!addressMatches('bravo', 'alpha/webapp', 'alpha'));
  });
});

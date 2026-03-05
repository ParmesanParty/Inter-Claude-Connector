import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { createTmpHome, runCLI } from './helpers.ts';

// Each test group creates its own tmpHome to avoid cross-contamination.

describe('CLI guardrails', () => {

  // ── tls init ──────────────────────────────────────────────────────

  describe('tls init', () => {
    let tmpHome: string;
    let cleanup: () => void;

    before(() => {
      ({ tmpHome, cleanup } = createTmpHome('guard-tls-init'));
    });
    after(() => cleanup());

    it('blocks when ca.key already exists', () => {
      const tlsDir = join(tmpHome, '.icc', 'tls');
      mkdirSync(tlsDir, { recursive: true });
      writeFileSync(join(tlsDir, 'ca.key'), 'dummy');

      const r = runCLI(['tls', 'init'], { HOME: tmpHome });
      assert.equal(r.exitCode, 1);
      assert.match(r.stderr, /CA already initialized/);
    });

    it('proceeds with --force when ca.key exists', () => {
      const tlsDir = join(tmpHome, '.icc', 'tls');
      mkdirSync(tlsDir, { recursive: true });
      writeFileSync(join(tlsDir, 'ca.key'), 'dummy');

      const r = runCLI(['tls', 'init', '--force'], { HOME: tmpHome });
      assert.equal(r.exitCode, 0);
      assert.match(r.stdout, /CA initialized/);
    });

    it('blocks when host is enrolled as CA client', () => {
      const home2 = createTmpHome('guard-tls-init-client');
      writeFileSync(join(home2.tmpHome, '.icc', 'config.json'), JSON.stringify({
        identity: 'test-host',
        tls: { ca: 'remote-ca' },
        server: {},
      }));

      const r = runCLI(['tls', 'init'], { HOME: home2.tmpHome });
      assert.equal(r.exitCode, 1);
      assert.match(r.stderr, /enrolled as a client/);
      home2.cleanup();
    });
  });

  // ── tls enroll ────────────────────────────────────────────────────

  describe('tls enroll', () => {
    let tmpHome: string;
    let cleanup: () => void;

    before(() => {
      ({ tmpHome, cleanup } = createTmpHome('guard-tls-enroll'));
      writeFileSync(join(tmpHome, '.icc', 'config.json'), JSON.stringify({
        identity: 'test-host',
        tls: { ca: 'some-ca' },
        server: {},
        remotes: { 'some-ca': { httpUrl: 'http://1.2.3.4:3179' } },
      }));
    });
    after(() => cleanup());

    it('blocks when server.key already exists', () => {
      const tlsDir = join(tmpHome, '.icc', 'tls');
      mkdirSync(tlsDir, { recursive: true });
      writeFileSync(join(tlsDir, 'server.key'), 'dummy');

      const r = runCLI(['tls', 'enroll'], { HOME: tmpHome });
      assert.equal(r.exitCode, 1);
      assert.match(r.stderr, /Server key\/certificate already exist/);
    });
  });

  // ── tls enroll-self ───────────────────────────────────────────────

  describe('tls enroll-self', () => {
    let tmpHome: string;
    let cleanup: () => void;

    before(() => {
      ({ tmpHome, cleanup } = createTmpHome('guard-tls-enroll-self'));
    });
    after(() => cleanup());

    it('blocks when server.key already exists (and ca.key present)', () => {
      const tlsDir = join(tmpHome, '.icc', 'tls');
      mkdirSync(tlsDir, { recursive: true });
      // ca.key must exist for enroll-self to proceed past the first guard
      writeFileSync(join(tlsDir, 'ca.key'), 'dummy-ca-key');
      writeFileSync(join(tlsDir, 'server.key'), 'dummy-server-key');

      const r = runCLI(['tls', 'enroll-self'], { HOME: tmpHome });
      assert.equal(r.exitCode, 1);
      assert.match(r.stderr, /Server key already exists/);
    });
  });

  // ── invite ────────────────────────────────────────────────────────

  describe('invite', () => {
    let tmpHome: string;
    let cleanup: () => void;

    before(() => {
      ({ tmpHome, cleanup } = createTmpHome('guard-invite'));
      writeFileSync(join(tmpHome, '.icc', 'config.json'), JSON.stringify({
        identity: 'this-host',
        server: { localToken: 'tok123' },
        remotes: { 'existing-peer': { httpUrl: 'http://1.2.3.4:3179' } },
      }));
    });
    after(() => cleanup());

    it('blocks self-invite', () => {
      const r = runCLI(['invite', 'this-host', '--ip', '1.2.3.4'], {
        HOME: tmpHome, ICC_IDENTITY: 'this-host',
      });
      assert.equal(r.exitCode, 1);
      assert.match(r.stderr, /Cannot invite yourself/);
    });

    it('blocks when peer already exists', () => {
      const r = runCLI(['invite', 'existing-peer', '--ip', '5.6.7.8'], {
        HOME: tmpHome, ICC_IDENTITY: 'this-host',
      });
      assert.equal(r.exitCode, 1);
      assert.match(r.stderr, /already exists in remotes/);
    });
  });

  // ── join ──────────────────────────────────────────────────────────

  describe('join', () => {
    let tmpHome: string;
    let cleanup: () => void;

    before(() => {
      ({ tmpHome, cleanup } = createTmpHome('guard-join'));
      writeFileSync(join(tmpHome, '.icc', 'config.json'), JSON.stringify({
        identity: 'this-host',
        server: { tls: { enabled: true } },
        remotes: { 'peer-a': { httpUrl: 'https://1.2.3.4:3179' } },
      }));
    });
    after(() => cleanup());

    it('blocks self-join', () => {
      const r = runCLI(['join', '--ca', 'this-host', '--token', 'abc123'], {
        HOME: tmpHome, ICC_IDENTITY: 'this-host',
      });
      assert.equal(r.exitCode, 1);
      assert.match(r.stderr, /matches this host/);
    });

    it('blocks when mesh config already exists', () => {
      const r = runCLI(['join', '--ca', 'other-ca', '--token', 'abc123', '--url', 'http://1.2.3.4:4179'], {
        HOME: tmpHome, ICC_IDENTITY: 'this-host',
      });
      assert.equal(r.exitCode, 1);
      assert.match(r.stderr, /already has mesh configuration/);
    });
  });

  // ── init --identity ───────────────────────────────────────────────

  describe('init --identity', () => {
    let tmpHome: string;
    let cleanup: () => void;

    before(() => {
      ({ tmpHome, cleanup } = createTmpHome('guard-init-identity'));
      writeFileSync(join(tmpHome, '.icc', 'config.json'), JSON.stringify({
        identity: 'old-name',
        server: { localToken: 'tok123' },
        remotes: { 'peer-a': { httpUrl: 'https://1.2.3.4:3179' } },
      }));
    });
    after(() => cleanup());

    it('blocks identity change when peers exist', () => {
      const r = runCLI(['init', '--identity', 'new-name'], {
        HOME: tmpHome, ICC_IDENTITY: 'old-name',
      });
      assert.equal(r.exitCode, 1);
      assert.match(r.stderr, /break mTLS CN verification/);
    });

    it('allows same identity (no-op)', () => {
      const r = runCLI(['init', '--identity', 'old-name'], {
        HOME: tmpHome, ICC_IDENTITY: 'old-name',
      });
      assert.equal(r.exitCode, 0);
    });
  });
});

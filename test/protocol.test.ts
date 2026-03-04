import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  createPing, createPong,
  validate, serialize, deserialize,
} from '../src/protocol.ts';
import { clearConfigCache } from '../src/config.ts';

beforeEach(() => {
  process.env.ICC_IDENTITY = 'test-host';
  clearConfigCache();
});

describe('createPing / createPong', () => {
  it('creates valid ping and pong messages', () => {
    const ping = createPing();
    assert.equal(ping.type, 'ping');
    assert.ok(validate(ping));

    const pong = createPong(ping.id);
    assert.equal(pong.type, 'pong');
    assert.equal(pong.replyTo, ping.id);
    assert.ok(validate(pong));
  });
});

describe('validate', () => {
  it('accepts valid messages', () => {
    assert.ok(validate(createPing()));
    assert.ok(validate(createPong('id')));
  });

  it('rejects null/undefined', () => {
    assert.equal(validate(null), false);
    assert.equal(validate(undefined), false);
  });

  it('rejects wrong version', () => {
    const msg = createPing();
    msg.version = '99';
    assert.equal(validate(msg), false);
  });

  it('rejects invalid type', () => {
    const msg = createPing();
    (msg as unknown as Record<string, unknown>).type = 'invalid';
    assert.equal(validate(msg), false);
  });

  it('rejects non-objects', () => {
    assert.equal(validate('string'), false);
    assert.equal(validate(42), false);
    assert.equal(validate([]), false);
  });
});

describe('serialize / deserialize', () => {
  it('round-trips a message', () => {
    const original = createPing();
    const json = serialize(original);
    const restored = deserialize(json);

    assert.deepEqual(restored, original);
  });

  it('deserialize rejects invalid JSON', () => {
    assert.throws(() => deserialize('not json'), /Unexpected token/);
  });

  it('deserialize rejects invalid messages', () => {
    assert.throws(() => deserialize('{"version":"99"}'), /Invalid ICC message/);
  });
});

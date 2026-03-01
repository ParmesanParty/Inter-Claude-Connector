import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  createRequest, createResponse, createError,
  createPing, createPong,
  validate, serialize, deserialize,
} from '../src/protocol.ts';
import { clearConfigCache } from '../src/config.ts';

// Set a test identity so protocol can create messages
process.env.ICC_IDENTITY = 'test-host';

beforeEach(() => {
  clearConfigCache();
});

describe('createRequest', () => {
  it('creates a valid request message', () => {
    const msg = createRequest('Hello remote', { key: 'value' });
    assert.equal(msg.version, '1');
    assert.equal(msg.type, 'request');
    assert.equal(msg.from, 'test-host');
    assert.equal((msg.payload as Record<string, unknown>).prompt, 'Hello remote');
    assert.deepEqual((msg.payload as Record<string, unknown>).context, { key: 'value' });
    assert.ok(msg.id);
    assert.ok(msg.timestamp);
  });
});

describe('createResponse', () => {
  it('creates a valid response message', () => {
    const msg = createResponse('req-123', { answer: 42 });
    assert.equal(msg.type, 'response');
    assert.equal(msg.replyTo, 'req-123');
    assert.deepEqual((msg.payload as Record<string, unknown>).result, { answer: 42 });
  });
});

describe('createError', () => {
  it('creates a valid error message', () => {
    const msg = createError('req-123', 'Something broke');
    assert.equal(msg.type, 'error');
    assert.equal(msg.replyTo, 'req-123');
    assert.equal((msg.payload as Record<string, unknown>).error, 'Something broke');
  });
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
    assert.ok(validate(createRequest('test')));
    assert.ok(validate(createResponse('id', 'result')));
    assert.ok(validate(createError('id', 'err')));
    assert.ok(validate(createPing()));
    assert.ok(validate(createPong('id')));
  });

  it('rejects null/undefined', () => {
    assert.equal(validate(null), false);
    assert.equal(validate(undefined), false);
  });

  it('rejects wrong version', () => {
    const msg = createRequest('test');
    msg.version = '99';
    assert.equal(validate(msg), false);
  });

  it('rejects invalid type', () => {
    const msg = createRequest('test');
    (msg as unknown as Record<string, unknown>).type = 'invalid';
    assert.equal(validate(msg), false);
  });

  it('rejects request without prompt', () => {
    const msg = createRequest('test');
    delete (msg.payload as Record<string, unknown>).prompt;
    assert.equal(validate(msg), false);
  });

  it('rejects response without replyTo', () => {
    const msg = createResponse('id', 'result');
    delete msg.replyTo;
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
    const original = createRequest('round trip test', { data: [1, 2, 3] });
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

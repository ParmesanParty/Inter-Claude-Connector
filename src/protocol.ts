import { randomUUID } from 'node:crypto';
import { loadConfig, getFullAddress } from './config.ts';
import type { Message, MessageType, MessagePayload } from './types.ts';

const VALID_TYPES: readonly string[] = ['error', 'ping', 'pong'];
const PROTOCOL_VERSION = '1';

function makeMessage(type: MessageType, payload: MessagePayload = {}, extra: Record<string, unknown> = {}): Message {
  const config = loadConfig();
  return {
    version: PROTOCOL_VERSION,
    id: randomUUID(),
    type,
    from: getFullAddress(config),
    timestamp: new Date().toISOString(),
    payload,
    ...extra,
  };
}

export function createPing(): Message {
  return makeMessage('ping');
}

export function createPong(replyTo: string): Message {
  return makeMessage('pong', {}, { replyTo });
}

export function validate(message: unknown): message is Message {
  if (!message || typeof message !== 'object') return false;
  const msg = message as Record<string, unknown>;
  if (msg.version !== PROTOCOL_VERSION) return false;
  if (typeof msg.id !== 'string' || !msg.id) return false;
  if (!VALID_TYPES.includes(msg.type as string)) return false;
  if (typeof msg.from !== 'string' || !msg.from) return false;
  if (typeof msg.timestamp !== 'string' || !msg.timestamp) return false;
  if (!msg.payload || typeof msg.payload !== 'object') return false;

  // Type-specific validation
  if (msg.type === 'error' && typeof msg.replyTo !== 'string') return false;
  if (msg.type === 'pong' && typeof msg.replyTo !== 'string') return false;

  return true;
}

export function serialize(message: Message): string {
  return JSON.stringify(message);
}

export function deserialize(str: string): Message {
  const message: unknown = JSON.parse(str);
  if (!validate(message)) {
    throw new Error('Invalid ICC message');
  }
  return message;
}

/**
 * Address utilities for per-instance inbox addressing.
 *
 * Address format: "hostname/instance" (e.g. "mars/myapp", "jupiter/dashboard")
 * Bare hostname (no slash) = broadcast to all instances on that host.
 */

import type { ParsedAddress } from './types.ts';

export function parseAddress(address: string): ParsedAddress {
  if (!address || typeof address !== 'string') {
    return { host: null, instance: null };
  }
  const slashIndex = address.indexOf('/');
  if (slashIndex === -1) {
    return { host: address, instance: null };
  }
  return {
    host: address.slice(0, slashIndex),
    instance: address.slice(slashIndex + 1) || null,
  };
}

export function buildAddress(host: string, instance: string | null): string {
  if (!host) return '';
  if (!instance) return host;
  return `${host}/${instance}`;
}

export function addressMatches(messageTo: string, fullAddress: string, serverIdentity: string): boolean {
  const msg = parseAddress(messageTo);
  const addr = parseAddress(fullAddress);

  // Host must match (or message is for this server)
  if (msg.host !== addr.host && msg.host !== serverIdentity) return false;

  // If querying address has no instance, it sees everything for its host
  if (!addr.instance) return true;

  // Broadcast message (no instance in `to`) matches all instances
  if (!msg.instance) return true;

  // Instance-targeted: must match exactly
  return msg.instance === addr.instance;
}

/**
 * Shared type definitions for ICC.
 *
 * Only types used across multiple modules live here.
 * Module-internal types stay in their own files.
 */

// ── Protocol ────────────────────────────────────────────────────────

export type MessageType = 'error' | 'ping' | 'pong';

export interface ErrorPayload {
  error: string;
}

export type MessagePayload = ErrorPayload | Record<string, unknown>;

export interface Message {
  version: string;
  id: string;
  type: MessageType;
  from: string;
  timestamp: string;
  payload: MessagePayload;
  replyTo?: string;
  transport?: string;
}

// ── Config ──────────────────────────────────────────────────────────

export interface TlsConfig {
  enabled: boolean;
  certPath: string | null;
  keyPath: string | null;
  caPath: string | null;
}

export interface ServerConfig {
  port: number;
  host: string;
  localToken: string | null;
  peerTokens: Record<string, string>;
  tls: TlsConfig;
  enrollPort: number;
  corsOrigins?: string[];
}

export interface WebConfig {
  host: string;
  port: number;
}

export interface TransportConfig {
  httpTimeout: number;
  healthCheckInterval: number;
}

export interface SecurityConfig {
  readfileEnabled: boolean;
  execEnabled: boolean;
  allowedPaths: string[];
  allowedCommands: string[];
  allowedSubcommands: Record<string, string[]>;
  maxExecTimeout: number;
}

export interface ClaudeConfig {
  outputFormat: string;
  noSessionPersistence: boolean;
  permissionMode: string;
  maxBudgetUsd: number | null;
  systemPromptAppend: string | null;
}

export interface RemoteConfig {
  httpUrl?: string;
  token?: string;
}

export interface ICCConfig {
  identity: string;
  instance: string | null;
  remotes: Record<string, RemoteConfig>;
  server: ServerConfig;
  web: WebConfig;
  tls: { ca: string | null };
  transport: TransportConfig;
  security: SecurityConfig;
  claude: ClaudeConfig;
}

// ── Transport ───────────────────────────────────────────────────────

export interface Transport {
  send(message: Message): Promise<Message>;
  isAvailable(): Promise<boolean>;
}

// ── Registry ────────────────────────────────────────────────────────

export interface RegistryEntry {
  address: string;
  instance: string;
  pid: number;
  registeredAt: string;
  lastSeen: string;
}

// ── Inbox ───────────────────────────────────────────────────────────

export type InboxMessageStatus = 'WAITING_FOR_REPLY' | 'FYI_ONLY' | 'ACTION_NEEDED' | 'RESOLVED';

export interface MessageMeta {
  type?: string;
  originalId?: string;
  readAt?: string;
  recipients?: string[];
}

export interface InboxMessage {
  id: string;
  from: string;
  to: string;
  timestamp: string;
  body: string;
  replyTo: string | null;
  threadId: string | null;
  status: InboxMessageStatus | null;
  _meta: MessageMeta | null;
  read: boolean;
}

// ── Instances ───────────────────────────────────────────────────────

export interface InstanceEntry {
  name: string;
  path: string;
}

// ── Address ─────────────────────────────────────────────────────────

export interface ParsedAddress {
  host: string | null;
  instance: string | null;
}

// ── Auth ────────────────────────────────────────────────────────────

export interface AuthResult {
  authenticated: boolean;
  identity: string | null;
}

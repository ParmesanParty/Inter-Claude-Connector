/**
 * Shared type definitions for ICC.
 *
 * Only types used across multiple modules live here.
 * Module-internal types stay in their own files.
 */

// ── Protocol ────────────────────────────────────────────────────────

export type MessageType = 'request' | 'response' | 'error' | 'ping' | 'pong';

export interface RequestPayload {
  prompt: string;
  context?: Record<string, unknown>;
}

export interface ResponsePayload {
  result: unknown;
}

export interface ErrorPayload {
  error: string;
}

export type MessagePayload = RequestPayload | ResponsePayload | ErrorPayload | Record<string, unknown>;

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
  authToken: string | null;
  localToken: string | null;
  peerTokens: Record<string, string>;
  tls: TlsConfig;
  enrollPort: number;
}

export interface TransportConfig {
  order: TransportName[];
  sshTimeout: number;
  httpTimeout: number;
  healthCheckInterval: number;
}

export interface SecurityConfig {
  readfileEnabled: boolean;
  execEnabled: boolean;
  allowedPaths: string[];
  allowedCommands: string[];
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
  sshHost?: string;
  projectDir?: string;
  token?: string;
  wolMac?: string;
}

export interface ICCConfig {
  identity: string;
  instance: string | null;
  remotes: Record<string, RemoteConfig>;
  server: ServerConfig;
  tls: { ca: string | null };
  transport: TransportConfig;
  security: SecurityConfig;
  claude: ClaudeConfig;
}

// ── Transport ───────────────────────────────────────────────────────

export type TransportName = 'http' | 'ssh';

export interface TransportConnectivityResult {
  available: boolean;
  latencyMs: number | null;
}

export type ConnectivityResults = Record<string, TransportConnectivityResult>;

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

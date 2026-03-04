export interface Logger {
  debug(message: string, data?: unknown): void;
  info(message: string, data?: unknown): void;
  warn(message: string, data?: unknown): void;
  error(message: string, data?: unknown): void;
}

type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const LEVELS: Record<LogLevel, number> = { debug: 0, info: 1, warn: 2, error: 3 };
let minLevel = LEVELS[(process.env.ICC_LOG_LEVEL as LogLevel)] ?? LEVELS.info;

const TOKEN_PATTERN = /("?(?:localToken|peerToken|token)"?\s*[:=]\s*)"[^"]+"/gi;

function redact(str: string): string;
function redact(str: unknown): unknown;
function redact(str: unknown): unknown {
  if (typeof str !== 'string') return str;
  return str.replace(TOKEN_PATTERN, '$1"[REDACTED]"');
}

function format(level: string, component: string, message: string, data?: unknown): string {
  const ts = new Date().toISOString();
  const prefix = `${ts} [${level.toUpperCase()}] [${component}]`;
  const msg = redact(typeof message === 'string' ? message : JSON.stringify(message));
  if (data !== undefined) {
    const d = redact(typeof data === 'string' ? data : JSON.stringify(data));
    return `${prefix} ${msg} ${d}`;
  }
  return `${prefix} ${msg}`;
}

export function createLogger(component: string): Logger {
  // All log output goes to stderr so stdout stays clean for protocol messages
  // (critical for `icc handle` where stdout IS the transport)
  return {
    debug(message: string, data?: unknown) {
      if (minLevel <= LEVELS.debug) process.stderr.write(format('debug', component, message, data) + '\n');
    },
    info(message: string, data?: unknown) {
      if (minLevel <= LEVELS.info) process.stderr.write(format('info', component, message, data) + '\n');
    },
    warn(message: string, data?: unknown) {
      if (minLevel <= LEVELS.warn) process.stderr.write(format('warn', component, message, data) + '\n');
    },
    error(message: string, data?: unknown) {
      if (minLevel <= LEVELS.error) process.stderr.write(format('error', component, message, data) + '\n');
    },
  };
}

export function setLogLevel(level: string): void {
  if (level in LEVELS) minLevel = LEVELS[level as LogLevel];
}

import { execFile } from 'node:child_process';
import { resolve } from 'node:path';
import { homedir } from 'node:os';
import { loadConfig } from '../config.ts';
import { createLogger } from './logger.ts';

const log = createLogger('exec');

interface ExecOptions {
  timeout?: number;
  cwd?: string;
}

interface ExecResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

interface ReadFileResult {
  content: string;
  path: string;
  size: number;
}

function expandHome(p: string): string {
  return p.startsWith('~/') ? resolve(homedir(), p.slice(2)) : p;
}

export function isPathAllowed(filePath: string, allowedPaths: string[]): boolean {
  const resolved = resolve(expandHome(filePath));
  return allowedPaths.some(prefix => {
    const resolvedPrefix = resolve(expandHome(prefix));
    return resolved === resolvedPrefix || resolved.startsWith(resolvedPrefix + '/');
  });
}

export function isCommandAllowed(command: string, allowedCommands: string[]): boolean {
  // Extract the base command (handle paths like /usr/bin/git → git)
  const base = command.split('/').pop();
  return allowedCommands.includes(base!);
}

// Git global flags that consume the next argument as a value
const GIT_FLAGS_WITH_VALUE = new Set(['-C', '-c', '--git-dir', '--work-tree', '--namespace', '--super-prefix', '--config-env']);

export function isSubcommandAllowed(command: string, args: string[], allowedSubcommands: Record<string, string[]>): boolean {
  const base = command.split('/').pop()!;
  const restricted = allowedSubcommands[base];
  if (!restricted) return true; // no subcommand restrictions for this command

  // Find subcommand: skip flags and their values
  let i = 0;
  while (i < args.length) {
    const arg = args[i]!;
    if (!arg.startsWith('-')) return restricted.includes(arg);
    // Skip flags that consume the next arg as a value
    if (GIT_FLAGS_WITH_VALUE.has(arg)) i++; // skip the value too
    i++;
  }

  return true; // bare command with only flags (e.g. `git --version`)
}

export async function safeReadFile(filePath: string): Promise<ReadFileResult> {
  const config = loadConfig();
  const { readfileEnabled, allowedPaths } = config.security;

  if (!readfileEnabled) {
    throw new Error('File reading is disabled. Set security.readfileEnabled=true in ~/.icc/config.json');
  }

  if (!isPathAllowed(filePath, allowedPaths)) {
    throw new Error(`Path not in allowed list: ${filePath}. Allowed: ${allowedPaths.join(', ')}`);
  }

  const { readFileSync } = await import('node:fs');
  const resolved = resolve(expandHome(filePath));
  const content = readFileSync(resolved, 'utf-8');
  log.info(`Read file: ${resolved} (${content.length} bytes)`);
  return { content, path: resolved, size: content.length };
}

export function safeExec(command: string, args: string[] = [], options: ExecOptions = {}): Promise<ExecResult> {
  const config = loadConfig();
  const { execEnabled, allowedCommands, maxExecTimeout } = config.security;

  if (!execEnabled) {
    return Promise.reject(new Error('Command execution is disabled. Set security.execEnabled=true in ~/.icc/config.json'));
  }

  if (!isCommandAllowed(command, allowedCommands)) {
    return Promise.reject(new Error(`Command not in allowed list: ${command}. Allowed: ${allowedCommands.join(', ')}`));
  }

  const { allowedSubcommands } = config.security;
  if (!isSubcommandAllowed(command, args, allowedSubcommands)) {
    const base = command.split('/').pop()!;
    const sub = args.find(a => !a.startsWith('-'));
    return Promise.reject(new Error(`Subcommand not allowed: ${base} ${sub}. Allowed: ${allowedSubcommands[base]!.join(', ')}`));
  }

  const timeout = Math.min(options.timeout || maxExecTimeout, maxExecTimeout);

  return new Promise((resolve, reject) => {
    log.info(`Executing: ${command} ${args.join(' ')}`);
    execFile(command, args, {
      timeout,
      maxBuffer: 1024 * 1024, // 1MB
      cwd: options.cwd || homedir(),
    }, (err, stdout, stderr) => {
      if (err && err.killed) {
        reject(new Error(`Command timed out after ${timeout}ms`));
        return;
      }
      resolve({
        stdout: stdout || '',
        stderr: stderr || '',
        exitCode: err ? (typeof err.code === 'number' ? err.code : 1) : 0,
      });
    });
  });
}

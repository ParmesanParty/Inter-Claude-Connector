import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { loadConfig } from './config.ts';
import { createLogger } from './util/logger.ts';

const log = createLogger('claude');

interface ClaudeInvokeOptions {
  maxBudgetUsd?: number;
  systemPromptAppend?: string;
  permissionMode?: string;
  timeout?: number;
}

export async function invokeClaudeCLI(prompt: string, options: ClaudeInvokeOptions = {}): Promise<unknown> {
  const config = loadConfig();
  const claudeConfig = config.claude;

  const args = ['-p', '--output-format', claudeConfig.outputFormat || 'json'];

  if (claudeConfig.noSessionPersistence !== false) {
    args.push('--no-session-persistence');
  }

  if (options.maxBudgetUsd ?? claudeConfig.maxBudgetUsd) {
    args.push('--max-budget-usd', String(options.maxBudgetUsd ?? claudeConfig.maxBudgetUsd));
  }

  const systemPrompt = options.systemPromptAppend ?? claudeConfig.systemPromptAppend;
  if (systemPrompt) {
    args.push('--append-system-prompt', systemPrompt);
  }

  const permMode = options.permissionMode ?? claudeConfig.permissionMode;
  if (permMode && permMode !== 'default') {
    args.push('--permission-mode', permMode);
  }

  args.push(prompt);

  const timeout = options.timeout ?? 120_000;

  log.info(`Invoking claude CLI`, { promptLength: prompt.length, timeout });

  return new Promise((resolve, reject) => {
    const env = { ...process.env };
    // Critical: unset CLAUDECODE to allow nested invocation
    delete env.CLAUDECODE;
    // Ensure ~/.local/bin is in PATH (claude is installed there but
    // non-interactive SSH sessions may not have it)
    const localBin = join(homedir(), '.local', 'bin');
    if (!env.PATH?.includes(localBin)) {
      env.PATH = `${localBin}:${env.PATH || ''}`;
    }

    const child = spawn('claude', args, {
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout,
    });

    let stdout = '';
    let stderr = '';

    child.stdout.on('data', (chunk: Buffer) => { stdout += chunk; });
    child.stderr.on('data', (chunk: Buffer) => { stderr += chunk; });

    const timer = setTimeout(() => {
      child.kill('SIGTERM');
      reject(new Error(`Claude CLI timed out after ${timeout}ms`));
    }, timeout);

    child.on('close', (code: number | null) => {
      clearTimeout(timer);

      if (stderr) {
        log.debug('Claude CLI stderr', stderr.trim());
      }

      if (code !== 0) {
        log.error(`Claude CLI exited with code ${code}`, stderr.trim());
        reject(new Error(`Claude CLI exited with code ${code}: ${stderr.trim()}`));
        return;
      }

      try {
        const result = JSON.parse(stdout);
        log.info('Claude CLI responded successfully');
        resolve(result);
      } catch {
        // If output-format is json but parsing fails, return raw
        log.warn('Claude CLI output was not valid JSON, returning raw');
        resolve({ result: stdout.trim() });
      }
    });

    child.on('error', (err: Error) => {
      clearTimeout(timer);
      log.error('Failed to spawn claude CLI', err.message);
      reject(new Error(`Failed to spawn claude CLI: ${err.message}`));
    });
  });
}

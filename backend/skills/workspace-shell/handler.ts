import { spawn } from 'child_process';
import path from 'path';
import type { SkillExecutionResult, SkillHandler } from '../../src/skills/types';

export const inputSchema = {
  type: 'object',
  properties: {
    command: {
      type: 'string',
      enum: ['rg', 'ls', 'cat', 'sed', 'head', 'tail', 'wc', 'git', 'npm', 'pnpm', 'yarn'],
    },
    args: {
      type: 'array',
      items: { type: 'string', maxLength: 300 },
      maxItems: 30,
    },
    cwd: { type: 'string', minLength: 1 },
    timeoutMs: { type: 'integer', minimum: 200, maximum: 15000 },
  },
  required: ['command'],
  additionalProperties: false,
};

interface ProcessResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  durationMs: number;
}

const MAX_OUTPUT_CHARS = 24_000;
const DEFAULT_TIMEOUT_MS = 5000;

const ALLOWED_COMMANDS = new Set([
  'rg',
  'ls',
  'cat',
  'sed',
  'head',
  'tail',
  'wc',
  'git',
  'npm',
  'pnpm',
  'yarn',
]);

const ALLOWED_GIT_SUBCOMMANDS = new Set([
  'status',
  'diff',
  'log',
  'show',
  'branch',
  'rev-parse',
  'ls-files',
  'describe',
]);

const ALLOWED_PACKAGE_SCRIPTS = new Set([
  'build',
  'test',
  'lint',
  'typecheck',
  'format',
  'dev',
  'start',
  'check',
]);

function toStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];

  return value
    .filter((item): item is string => typeof item === 'string')
    .map((item) => item.trim())
    .filter(Boolean);
}

function isInsideRoot(targetPath: string, rootPath: string): boolean {
  const relative = path.relative(rootPath, targetPath);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function appendChunk(current: string, chunk: string): string {
  const next = current + chunk;
  if (next.length <= MAX_OUTPUT_CHARS) return next;
  return `${next.slice(0, MAX_OUTPUT_CHARS)}\n...[truncated]`;
}

function validateCommandPolicy(command: string, args: string[]): string | null {
  if (!ALLOWED_COMMANDS.has(command)) {
    return `Command "${command}" is not allowed.`;
  }

  if (command === 'git') {
    const subcommand = args[0] || '';
    if (!ALLOWED_GIT_SUBCOMMANDS.has(subcommand)) {
      return `git subcommand "${subcommand || '(none)'}" is not allowed.`;
    }
  }

  if (command === 'npm' || command === 'pnpm' || command === 'yarn') {
    const first = args[0] || '';
    const second = args[1] || '';

    if (first === 'test') {
      return null;
    }

    if (first === 'run' || first === 'run-script') {
      if (!ALLOWED_PACKAGE_SCRIPTS.has(second)) {
        return `Script "${second || '(none)'}" is not allowed for ${command}.`;
      }
      return null;
    }

    return `Package manager command "${first || '(none)'}" is not allowed for ${command}.`;
  }

  return null;
}

async function runProcess(
  command: string,
  args: string[],
  cwd: string,
  timeoutMs: number
): Promise<ProcessResult> {
  const started = Date.now();

  return new Promise<ProcessResult>((resolve, reject) => {
    const proc = spawn(command, args, {
      cwd,
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { PATH: process.env.PATH || '' },
    });

    let stdout = '';
    let stderr = '';
    let timedOut = false;

    const timer = setTimeout(() => {
      timedOut = true;
      proc.kill('SIGKILL');
    }, timeoutMs);

    proc.stdout.on('data', (chunk: Buffer) => {
      stdout = appendChunk(stdout, chunk.toString('utf8'));
    });

    proc.stderr.on('data', (chunk: Buffer) => {
      stderr = appendChunk(stderr, chunk.toString('utf8'));
    });

    proc.on('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });

    proc.on('close', (exitCode) => {
      clearTimeout(timer);
      resolve({
        exitCode,
        stdout: stdout.trim(),
        stderr: stderr.trim(),
        timedOut,
        durationMs: Date.now() - started,
      });
    });
  });
}

export const handler: SkillHandler = async (input, context): Promise<SkillExecutionResult> => {
  const payload = (input || {}) as Record<string, unknown>;
  const command = String(payload.command || '').trim();
  const args = toStringArray(payload.args);
  const requestedTimeout = Number(payload.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  const timeoutMs = Number.isFinite(requestedTimeout)
    ? Math.max(200, Math.min(15000, Math.floor(requestedTimeout)))
    : DEFAULT_TIMEOUT_MS;

  const backendRoot = path.resolve(process.cwd());
  const repoRoot = context.workspaceRoot;

  const requestedCwd = String(payload.cwd || '').trim();
  const resolvedCwd = requestedCwd
    ? (path.isAbsolute(requestedCwd) ? path.resolve(requestedCwd) : path.resolve(repoRoot, requestedCwd))
    : repoRoot;

  const cwdAllowed =
    isInsideRoot(resolvedCwd, repoRoot) ||
    isInsideRoot(resolvedCwd, backendRoot);

  if (!command) {
    return {
      success: false,
      summary: 'Shell command failed: command is required.',
      data: { command, args, cwd: resolvedCwd },
      error: 'command is required',
    };
  }

  if (!cwdAllowed) {
    return {
      success: false,
      summary: 'Shell command denied: cwd is outside allowed workspace roots.',
      data: { command, args, cwd: resolvedCwd },
      error: 'cwd outside allowed roots',
    };
  }

  const policyError = validateCommandPolicy(command, args);
  if (policyError) {
    return {
      success: false,
      summary: `Shell command denied: ${policyError}`,
      data: { command, args, cwd: resolvedCwd },
      error: policyError,
    };
  }

  try {
    const result = await runProcess(command, args, resolvedCwd, timeoutMs);
    const success = !result.timedOut && result.exitCode === 0;
    const summary = result.timedOut
      ? `Command timed out after ${timeoutMs}ms.`
      : success
        ? `Command completed in ${result.durationMs}ms.`
        : `Command exited with code ${result.exitCode}.`;

    return {
      success,
      summary,
      data: {
        command,
        args,
        cwd: resolvedCwd,
        timeoutMs,
        durationMs: result.durationMs,
        exitCode: result.exitCode,
        timedOut: result.timedOut,
        stdout: result.stdout,
        stderr: result.stderr,
      },
      error: success ? undefined : result.stderr || summary,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      success: false,
      summary: `Shell command failed: ${message}`,
      data: {
        command,
        args,
        cwd: resolvedCwd,
      },
      error: message,
    };
  }
};

import { spawn } from 'child_process';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import type { SkillExecutionResult, SkillHandler } from '../../src/skills/types';

export const inputSchema = {
  type: 'object',
  properties: {
    language: { type: 'string', enum: ['javascript', 'python'] },
    code: { type: 'string', minLength: 1 },
    timeoutMs: { type: 'integer', minimum: 200, maximum: 10000 },
  },
  required: ['language', 'code'],
  additionalProperties: false,
};

interface ProcessResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  durationMs: number;
}

const MAX_OUTPUT_CHARS = 20_000;
const MAX_CODE_CHARS = 8_000;

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
      stdio: ['ignore', 'pipe', 'pipe'],
      env: {
        PATH: process.env.PATH || '',
      },
    });

    let stdout = '';
    let stderr = '';
    let timedOut = false;

    const timer = setTimeout(() => {
      timedOut = true;
      proc.kill('SIGKILL');
    }, timeoutMs);

    proc.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf8');
      if (stdout.length > MAX_OUTPUT_CHARS) {
        stdout = `${stdout.slice(0, MAX_OUTPUT_CHARS)}\n...[truncated]`;
      }
    });

    proc.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8');
      if (stderr.length > MAX_OUTPUT_CHARS) {
        stderr = `${stderr.slice(0, MAX_OUTPUT_CHARS)}\n...[truncated]`;
      }
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

function parseInput(input: unknown): {
  language: 'javascript' | 'python';
  code: string;
  timeoutMs: number;
} {
  const payload = (input || {}) as Record<string, unknown>;
  const language = payload.language === 'python' ? 'python' : 'javascript';
  const code = String(payload.code || '');
  const requestedTimeout = Number(payload.timeoutMs ?? 4000);
  const timeoutMs = Number.isFinite(requestedTimeout)
    ? Math.max(200, Math.min(10_000, Math.floor(requestedTimeout)))
    : 4000;

  return { language, code, timeoutMs };
}

export const handler: SkillHandler = async (input): Promise<SkillExecutionResult> => {
  const { language, code, timeoutMs } = parseInput(input);

  if (!code.trim()) {
    return {
      success: false,
      summary: 'Execution failed: code is required.',
      data: { exitCode: null, stdout: '', stderr: 'Code is empty.' },
      error: 'code is required',
    };
  }

  if (code.length > MAX_CODE_CHARS) {
    return {
      success: false,
      summary: `Execution blocked: code exceeds ${MAX_CODE_CHARS} characters.`,
      data: { exitCode: null, stdout: '', stderr: 'Code too large.' },
      error: 'code too large',
    };
  }

  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-skill-code-'));
  const scriptName = language === 'python' ? 'snippet.py' : 'snippet.js';
  const scriptPath = path.join(tempDir, scriptName);

  try {
    await fs.writeFile(scriptPath, code, 'utf8');

    const result = await runProcess(
      language === 'python' ? 'python3' : 'node',
      [scriptPath],
      tempDir,
      timeoutMs
    );

    const success = !result.timedOut && result.exitCode === 0;
    const summary = result.timedOut
      ? `Execution timed out after ${timeoutMs}ms.`
      : success
        ? `Execution completed successfully in ${result.durationMs}ms.`
        : `Execution failed with exit code ${result.exitCode}.`;

    return {
      success,
      summary,
      data: {
        language,
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
      summary: `Execution failed: ${message}`,
      data: {
        language,
        timeoutMs,
        exitCode: null,
        timedOut: false,
        stdout: '',
        stderr: message,
      },
      error: message,
    };
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
};

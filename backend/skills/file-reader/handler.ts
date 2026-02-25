import fs from 'fs/promises';
import path from 'path';
import type { SkillExecutionResult, SkillHandler } from '../../src/skills/types';

export const inputSchema = {
  type: 'object',
  properties: {
    path: { type: 'string', minLength: 1 },
    startLine: { type: 'integer', minimum: 1 },
    endLine: { type: 'integer', minimum: 1 },
    maxLines: { type: 'integer', minimum: 1, maximum: 500 },
  },
  required: ['path'],
  additionalProperties: false,
};

const MAX_FILE_BYTES = 1_000_000;
const DEFAULT_MAX_LINES = 200;

function isInsideRoot(targetPath: string, rootPath: string): boolean {
  const relative = path.relative(rootPath, targetPath);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function toPositiveInteger(value: unknown, fallback: number): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(1, Math.floor(parsed));
}

export const handler: SkillHandler = async (input, context): Promise<SkillExecutionResult> => {
  const payload = (input || {}) as Record<string, unknown>;
  const requestedPath = String(payload.path || '').trim();

  if (!requestedPath) {
    return {
      success: false,
      summary: 'File read failed: path is required.',
      data: { path: requestedPath },
      error: 'path is required',
    };
  }

  const backendRoot = path.resolve(process.cwd());
  const repoRoot = context.workspaceRoot;

  const resolvedPath = path.isAbsolute(requestedPath)
    ? path.resolve(requestedPath)
    : path.resolve(repoRoot, requestedPath);

  const allowed =
    isInsideRoot(resolvedPath, repoRoot) ||
    isInsideRoot(resolvedPath, backendRoot);

  if (!allowed) {
    return {
      success: false,
      summary: 'File read denied: path is outside allowed workspace roots.',
      data: { path: resolvedPath },
      error: 'path outside allowed roots',
    };
  }

  try {
    const stats = await fs.stat(resolvedPath);
    if (!stats.isFile()) {
      return {
        success: false,
        summary: 'File read failed: path is not a file.',
        data: { path: resolvedPath },
        error: 'not a file',
      };
    }

    if (stats.size > MAX_FILE_BYTES) {
      return {
        success: false,
        summary: `File read blocked: file exceeds ${MAX_FILE_BYTES} bytes.`,
        data: { path: resolvedPath, size: stats.size },
        error: 'file too large',
      };
    }

    const raw = await fs.readFile(resolvedPath, 'utf8');
    if (raw.includes('\u0000')) {
      return {
        success: false,
        summary: 'File read failed: binary-like content detected.',
        data: { path: resolvedPath },
        error: 'binary content',
      };
    }

    const lines = raw.split(/\r?\n/);
    const requestedStart = toPositiveInteger(payload.startLine, 1);
    const requestedEnd = toPositiveInteger(payload.endLine, lines.length);
    const maxLines = Math.min(
      500,
      toPositiveInteger(payload.maxLines, DEFAULT_MAX_LINES)
    );

    const startLine = Math.min(requestedStart, lines.length);
    const maxEndFromStart = startLine + maxLines - 1;
    const endLine = Math.min(lines.length, Math.max(startLine, Math.min(requestedEnd, maxEndFromStart)));

    const selectedLines = lines.slice(startLine - 1, endLine);
    const content = selectedLines
      .map((line, index) => `${startLine + index}: ${line}`)
      .join('\n');

    return {
      success: true,
      summary: `Read ${selectedLines.length} line(s) from ${resolvedPath}.`,
      data: {
        path: resolvedPath,
        startLine,
        endLine,
        totalLines: lines.length,
        content,
      },
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      success: false,
      summary: `File read failed: ${message}`,
      data: { path: resolvedPath },
      error: message,
    };
  }
};

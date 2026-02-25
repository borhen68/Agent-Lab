import { constants as fsConstants } from 'fs';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import logger from '../logger';
import { toGeminiSchema } from '../llm/provider';
import {
  SkillDefinition,
  SkillExecutionResult,
  SkillHandler,
  SkillHandlerContext,
  SkillManifest,
  SkillMetadata,
  SkillOpenClawMetadata,
  SkillRequirements,
  SkillSource,
  SkillToolCallRecord,
} from './types';

import {
  handler as webSearchHandler,
  inputSchema as webSearchInputSchema,
} from '../../skills/web-search/handler';
import {
  handler as codeExecutorHandler,
  inputSchema as codeExecutorInputSchema,
} from '../../skills/code-executor/handler';
import {
  handler as calculatorHandler,
  inputSchema as calculatorInputSchema,
} from '../../skills/calculator/handler';
import {
  handler as fileReaderHandler,
  inputSchema as fileReaderInputSchema,
} from '../../skills/file-reader/handler';
import {
  handler as workspaceShellHandler,
  inputSchema as workspaceShellInputSchema,
} from '../../skills/workspace-shell/handler';

interface SkillHandlerModule {
  inputSchema: Record<string, unknown>;
  handler: SkillHandler;
}

export interface SkillRootPaths {
  workspace: string;
  managed: string;
  bundled: string | null;
}

export interface SkillRegistryCreateOptions {
  activeSkillNames?: string[];
  includeIneligible?: boolean;
}

interface SkillRootEntry {
  source: SkillSource;
  rootPath: string;
}

const HANDLER_MAP: Record<string, SkillHandlerModule> = {
  'web-search': {
    inputSchema: webSearchInputSchema,
    handler: webSearchHandler,
  },
  'code-executor': {
    inputSchema: codeExecutorInputSchema,
    handler: codeExecutorHandler,
  },
  calculator: {
    inputSchema: calculatorInputSchema,
    handler: calculatorHandler,
  },
  'file-reader': {
    inputSchema: fileReaderInputSchema,
    handler: fileReaderHandler,
  },
  'workspace-shell': {
    inputSchema: workspaceShellInputSchema,
    handler: workspaceShellHandler,
  },
};

const binaryLookupCache = new Map<string, Promise<boolean>>();

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

async function pathExists(targetPath: string): Promise<boolean> {
  try {
    await fs.access(targetPath);
    return true;
  } catch {
    return false;
  }
}

async function directoryExists(targetPath: string): Promise<boolean> {
  try {
    const stats = await fs.stat(targetPath);
    return stats.isDirectory();
  } catch {
    return false;
  }
}

function trimString(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function normalizeOptionalPath(value: string | undefined): string | undefined {
  const trimmed = trimString(value);
  if (!trimmed) return undefined;
  return path.resolve(trimmed);
}

async function resolveWorkspaceDefaultRoot(): Promise<string> {
  const cwd = process.cwd();
  const backendSkills = path.resolve(cwd, 'backend', 'skills');
  const runningFromRepoRoot = await directoryExists(backendSkills);

  return runningFromRepoRoot
    ? path.resolve(cwd, 'skills')
    : path.resolve(cwd, '..', 'skills');
}

async function resolveBundledSkillsRoot(): Promise<string | null> {
  const override = normalizeOptionalPath(process.env.AGENT_LAB_BUNDLED_SKILLS_DIR);
  if (override) return override;

  const cwd = process.cwd();
  const candidates = [
    path.resolve(cwd, 'backend', 'skills'),
    path.resolve(cwd, 'skills'),
  ];

  for (const candidate of candidates) {
    if (await directoryExists(candidate)) {
      return candidate;
    }
  }

  return null;
}

export async function resolveSkillRoots(): Promise<SkillRootPaths> {
  const workspaceOverride = normalizeOptionalPath(process.env.AGENT_LAB_WORKSPACE_SKILLS_DIR);
  const managedOverride = normalizeOptionalPath(process.env.AGENT_LAB_MANAGED_SKILLS_DIR);
  const bundledRoot = await resolveBundledSkillsRoot();

  return {
    workspace: workspaceOverride || (await resolveWorkspaceDefaultRoot()),
    managed: managedOverride || path.join(os.homedir(), '.agent-lab', 'skills'),
    bundled: bundledRoot,
  };
}

async function discoverSkillRootsByPrecedence(): Promise<SkillRootEntry[]> {
  const roots = await resolveSkillRoots();
  const ordered: SkillRootEntry[] = [
    { source: 'workspace', rootPath: roots.workspace },
    { source: 'managed', rootPath: roots.managed },
    ...(roots.bundled ? [{ source: 'bundled' as const, rootPath: roots.bundled }] : []),
  ];

  const seen = new Set<string>();
  const discovered: SkillRootEntry[] = [];

  for (const entry of ordered) {
    const normalized = path.resolve(entry.rootPath);
    if (seen.has(normalized)) continue;
    seen.add(normalized);

    if (await directoryExists(normalized)) {
      discovered.push({ source: entry.source, rootPath: normalized });
    }
  }

  return discovered;
}

function parseFrontmatter(raw: string): {
  meta: Record<string, string | string[]>;
  body: string;
} {
  const match = raw.match(/^---\s*\n([\s\S]*?)\n---\s*\n?([\s\S]*)$/);
  if (!match) {
    return { meta: {}, body: raw.trim() };
  }

  const metaBlock = match[1];
  const body = match[2].trim();
  const meta: Record<string, string | string[]> = {};
  let currentListKey: string | null = null;

  for (const line of metaBlock.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    const keyValueMatch = trimmed.match(/^([a-zA-Z0-9_-]+)\s*:\s*(.*)$/);
    if (keyValueMatch) {
      const key = keyValueMatch[1];
      const value = keyValueMatch[2];

      if (!value) {
        meta[key] = [];
        currentListKey = key;
      } else {
        meta[key] = value;
        currentListKey = null;
      }
      continue;
    }

    if (currentListKey && trimmed.startsWith('- ')) {
      const current = meta[currentListKey];
      if (!Array.isArray(current)) {
        meta[currentListKey] = [];
      }
      (meta[currentListKey] as string[]).push(trimmed.slice(2).trim());
    }
  }

  return { meta, body };
}

function toStringArray(value: string | string[] | undefined): string[] {
  if (!value) return [];

  const values = Array.isArray(value) ? value : [value];
  return values.map((item) => item.trim()).filter(Boolean);
}

function toStringArrayFromUnknown(value: unknown): string[] {
  if (!Array.isArray(value)) return [];

  return value
    .filter((item): item is string => typeof item === 'string')
    .map((item) => item.trim())
    .filter(Boolean);
}

function parseSkillMetadata(rawMetadata: string | string[] | undefined, skillName: string): SkillMetadata | undefined {
  const raw = Array.isArray(rawMetadata)
    ? rawMetadata.join('\n').trim()
    : (rawMetadata || '').trim();

  if (!raw) return undefined;

  try {
    const parsed = JSON.parse(raw);
    if (!isRecord(parsed)) return undefined;

    const metadata: SkillMetadata = {};
    const openclawRaw = parsed.openclaw;

    if (isRecord(openclawRaw)) {
      const openclaw: SkillOpenClawMetadata = {};
      const requiresRaw = openclawRaw.requires;

      if (typeof openclawRaw.emoji === 'string' && openclawRaw.emoji.trim()) {
        openclaw.emoji = openclawRaw.emoji.trim();
      }

      if (typeof openclawRaw.primaryEnv === 'string' && openclawRaw.primaryEnv.trim()) {
        openclaw.primaryEnv = openclawRaw.primaryEnv.trim();
      }

      if (isRecord(requiresRaw)) {
        const requires: SkillRequirements = {};
        const bins = toStringArrayFromUnknown(requiresRaw.bins);
        const anyBins = toStringArrayFromUnknown(requiresRaw.anyBins);
        const env = toStringArrayFromUnknown(requiresRaw.env);
        const os = toStringArrayFromUnknown(requiresRaw.os);

        if (bins.length > 0) requires.bins = bins;
        if (anyBins.length > 0) requires.anyBins = anyBins;
        if (env.length > 0) requires.env = env;
        if (os.length > 0) requires.os = os;
        if (Object.keys(requires).length > 0) openclaw.requires = requires;
      }

      if (Object.keys(openclaw).length > 0) {
        metadata.openclaw = openclaw;
      }
    }

    return Object.keys(metadata).length > 0 ? metadata : undefined;
  } catch (error) {
    logger.warn(`Skill metadata parse failed for ${skillName}: ${error instanceof Error ? error.message : String(error)}`);
    return undefined;
  }
}

async function binaryExists(bin: string): Promise<boolean> {
  const key = `${process.platform}:${process.env.PATH || ''}:${bin}`;
  const existing = binaryLookupCache.get(key);
  if (existing) return existing;

  const lookupPromise = (async () => {
    const pathValue = process.env.PATH || '';
    if (!pathValue) return false;

    const suffixes =
      process.platform === 'win32'
        ? ['', '.exe', '.cmd', '.bat']
        : [''];

    for (const segment of pathValue.split(path.delimiter)) {
      const candidateDir = segment.trim();
      if (!candidateDir) continue;

      for (const suffix of suffixes) {
        const candidatePath = path.join(candidateDir, `${bin}${suffix}`);
        try {
          await fs.access(candidatePath, fsConstants.X_OK);
          return true;
        } catch {
          continue;
        }
      }
    }

    return false;
  })();

  binaryLookupCache.set(key, lookupPromise);
  return lookupPromise;
}

function dedupe(items: string[] | undefined): string[] {
  if (!items || items.length === 0) return [];
  return Array.from(new Set(items.map((item) => item.trim()).filter(Boolean)));
}

async function evaluateEligibility(manifest: SkillManifest): Promise<string[]> {
  const reasons: string[] = [];
  const requires = manifest.metadata?.openclaw?.requires;
  if (!requires) return reasons;

  const supportedOs = dedupe(requires.os);
  if (supportedOs.length > 0 && !supportedOs.includes(process.platform)) {
    reasons.push(`unsupported OS (${process.platform}); allowed: ${supportedOs.join(', ')}`);
  }

  const requiredEnv = dedupe(requires.env);
  if (requiredEnv.length > 0) {
    const missingEnv = requiredEnv.filter((key) => {
      const value = process.env[key];
      return typeof value !== 'string' || value.trim().length === 0;
    });
    if (missingEnv.length > 0) {
      reasons.push(`missing env vars: ${missingEnv.join(', ')}`);
    }
  }

  const allBins = dedupe(requires.bins);
  if (allBins.length > 0) {
    const checks = await Promise.all(allBins.map(async (bin) => ({
      bin,
      ok: await binaryExists(bin),
    })));
    const missing = checks.filter((entry) => !entry.ok).map((entry) => entry.bin);
    if (missing.length > 0) {
      reasons.push(`missing binaries: ${missing.join(', ')}`);
    }
  }

  const anyBins = dedupe(requires.anyBins);
  if (anyBins.length > 0) {
    const checks = await Promise.all(anyBins.map((bin) => binaryExists(bin)));
    if (!checks.some(Boolean)) {
      reasons.push(`requires one of binaries: ${anyBins.join(', ')}`);
    }
  }

  return reasons;
}

async function discoverSkillDefinitions(
  options: SkillRegistryCreateOptions
): Promise<SkillDefinition[]> {
  const activeSkillNames = options.activeSkillNames;
  const includeIneligible = options.includeIneligible ?? false;
  const explicitSelection = Array.isArray(activeSkillNames);
  const requested = new Set((activeSkillNames || []).map((name) => name.trim()).filter(Boolean));

  if (explicitSelection && requested.size === 0) {
    return [];
  }

  const roots = await discoverSkillRootsByPrecedence();
  if (roots.length === 0) {
    logger.warn('No skills directory found. Skills are disabled.');
    return [];
  }

  const definitions: SkillDefinition[] = [];
  const claimedNames = new Set<string>();

  for (const root of roots) {
    let entries: Array<{ isDirectory(): boolean; name: string }>;
    try {
      entries = await fs.readdir(root.rootPath, { withFileTypes: true, encoding: 'utf8' });
    } catch (error) {
      logger.warn(`Failed to read skills root ${root.rootPath}:`, error);
      continue;
    }

    for (const entry of entries) {
      if (!entry.isDirectory()) continue;

      const directory = entry.name;
      const skillDir = path.join(root.rootPath, directory);
      const skillMdPath = path.join(skillDir, 'SKILL.md');

      if (!(await pathExists(skillMdPath))) continue;

      try {
        const raw = await fs.readFile(skillMdPath, 'utf8');
        const { meta, body } = parseFrontmatter(raw);
        const name = (typeof meta.name === 'string' && meta.name.trim()) || directory;

        if (claimedNames.has(name)) {
          continue;
        }

        if (requested.size > 0 && !requested.has(name)) {
          continue;
        }

        const module = HANDLER_MAP[name] || HANDLER_MAP[directory];
        if (!module) {
          logger.warn(`Skill ${name} has no handler; skipping`);
          continue;
        }

        const metadata = parseSkillMetadata(meta.metadata, name);
        const [hasScripts, hasReferences, hasAssets] = await Promise.all([
          directoryExists(path.join(skillDir, 'scripts')),
          directoryExists(path.join(skillDir, 'references')),
          directoryExists(path.join(skillDir, 'assets')),
        ]);

        const manifest: SkillManifest = {
          name,
          version:
            (typeof meta.version === 'string' && meta.version.trim()) ||
            '1.0.0',
          description:
            (typeof meta.description === 'string' && meta.description.trim()) ||
            'No description provided.',
          trigger:
            (typeof meta.trigger === 'string' && meta.trigger.trim()) ||
            'Use when helpful for task completion.',
          inputs: toStringArray(meta.inputs),
          outputs: toStringArray(meta.outputs),
          instructions: body,
          directory,
          source: root.source,
          location: skillMdPath,
          scriptsPath: hasScripts ? path.join(skillDir, 'scripts') : undefined,
          referencesPath: hasReferences ? path.join(skillDir, 'references') : undefined,
          assetsPath: hasAssets ? path.join(skillDir, 'assets') : undefined,
          metadata,
          eligible: true,
          disabledReasons: [],
        };

        const disabledReasons = await evaluateEligibility(manifest);
        manifest.disabledReasons = disabledReasons;
        manifest.eligible = disabledReasons.length === 0;

        // Higher-precedence sources reserve skill names even if ineligible.
        claimedNames.add(name);

        if (!manifest.eligible && !includeIneligible) {
          logger.info(`Skill ${name} filtered by gating (${disabledReasons.join('; ')})`);
          continue;
        }

        definitions.push({
          manifest,
          inputSchema: module.inputSchema,
          handler: module.handler,
        });
      } catch (error) {
        logger.warn(`Failed to load skill from ${skillMdPath}:`, error);
      }
    }
  }

  definitions.sort((a, b) => a.manifest.name.localeCompare(b.manifest.name));
  return definitions;
}

export class SkillRegistry {
  private readonly skillsByName: Map<string, SkillDefinition>;

  private constructor(definitions: SkillDefinition[]) {
    this.skillsByName = new Map(definitions.map((definition) => [definition.manifest.name, definition]));
  }

  static async create(options?: string[] | SkillRegistryCreateOptions): Promise<SkillRegistry> {
    const normalized: SkillRegistryCreateOptions = Array.isArray(options)
      ? { activeSkillNames: options }
      : (options || {});

    const definitions = await discoverSkillDefinitions(normalized);
    return new SkillRegistry(definitions);
  }

  list(): SkillManifest[] {
    return Array.from(this.skillsByName.values()).map((definition) => definition.manifest);
  }

  names(): string[] {
    return this.list().map((manifest) => manifest.name);
  }

  toAnthropicTools(): Array<Record<string, unknown>> {
    return Array.from(this.skillsByName.values()).map((definition) => ({
      name: definition.manifest.name,
      description: `${definition.manifest.description} Trigger: ${definition.manifest.trigger}`,
      input_schema: definition.inputSchema,
    }));
  }

  toGeminiTools(): Array<Record<string, unknown>> {
    const declarations = Array.from(this.skillsByName.values()).map((definition) => ({
      name: definition.manifest.name,
      description: `${definition.manifest.description} Trigger: ${definition.manifest.trigger}`,
      parameters: toGeminiSchema(definition.inputSchema),
    }));

    if (declarations.length === 0) return [];

    return [
      {
        functionDeclarations: declarations,
      },
    ];
  }

  toOpenAITools(): Array<Record<string, unknown>> {
    return Array.from(this.skillsByName.values()).map((definition) => ({
      type: 'function',
      function: {
        name: definition.manifest.name,
        description: `${definition.manifest.description} Trigger: ${definition.manifest.trigger}`,
        parameters: definition.inputSchema,
      },
    }));
  }

  buildSystemPromptSection(): string {
    const manifests = this.list();
    if (manifests.length === 0) {
      return 'No external skills are currently enabled. Solve the task without tools.';
    }

    const details = manifests
      .map((manifest) => {
        const inputText = manifest.inputs.length > 0 ? manifest.inputs.join('; ') : 'none';
        const outputText = manifest.outputs.length > 0 ? manifest.outputs.join('; ') : 'none';
        const resources = [
          manifest.scriptsPath ? 'scripts' : null,
          manifest.referencesPath ? 'references' : null,
          manifest.assetsPath ? 'assets' : null,
        ].filter(Boolean).join(', ') || 'none';

        return [
          `Skill: ${manifest.name} (v${manifest.version})`,
          `Description: ${manifest.description}`,
          `Trigger: ${manifest.trigger}`,
          `Inputs: ${inputText}`,
          `Outputs: ${outputText}`,
          `Source: ${manifest.source}`,
          `Location: ${manifest.location}`,
          `Resources: ${resources}`,
        ].join('\n');
      })
      .join('\n\n');

    return `You can use the following tools when useful:\n\n${details}`;
  }

  async execute(
    name: string,
    input: unknown,
    context: Omit<SkillHandlerContext, 'workspaceRoot'>
  ): Promise<SkillExecutionResult & { durationMs: number; record: SkillToolCallRecord }> {
    const definition = this.skillsByName.get(name);
    const workspaceRoot = path.resolve(process.cwd(), '..');
    const startedAt = Date.now();

    if (!definition) {
      const durationMs = Date.now() - startedAt;
      return {
        success: false,
        summary: `Skill ${name} is not registered.`,
        data: { error: `Skill ${name} is not registered.` },
        error: `Skill ${name} is not registered.`,
        durationMs,
        record: {
          name,
          input,
          success: false,
          summary: `Skill ${name} is not registered.`,
          durationMs,
          timestamp: new Date().toISOString(),
          turnIndex: 0,
          callIndex: 0,
        },
      };
    }

    try {
      const result = await definition.handler(input, {
        ...context,
        workspaceRoot,
      });
      const durationMs = Date.now() - startedAt;

      return {
        ...result,
        durationMs,
        record: {
          name,
          input,
          success: result.success,
          summary: result.summary,
          durationMs,
          timestamp: new Date().toISOString(),
          turnIndex: 0,
          callIndex: 0,
        },
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const durationMs = Date.now() - startedAt;

      return {
        success: false,
        summary: `Skill ${name} failed: ${message}`,
        data: { error: message },
        error: message,
        durationMs,
        record: {
          name,
          input,
          success: false,
          summary: `Skill ${name} failed: ${message}`,
          durationMs,
          timestamp: new Date().toISOString(),
          turnIndex: 0,
          callIndex: 0,
        },
      };
    }
  }
}

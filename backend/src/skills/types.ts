export type SkillSource = 'workspace' | 'managed' | 'bundled';

export interface SkillRequirements {
  bins?: string[];
  anyBins?: string[];
  env?: string[];
  os?: string[];
}

export interface SkillOpenClawMetadata {
  emoji?: string;
  primaryEnv?: string;
  requires?: SkillRequirements;
}

export interface SkillMetadata {
  openclaw?: SkillOpenClawMetadata;
}

export interface SkillManifest {
  name: string;
  version: string;
  description: string;
  trigger: string;
  inputs: string[];
  outputs: string[];
  instructions: string;
  directory: string;
  source: SkillSource;
  location: string;
  scriptsPath?: string;
  referencesPath?: string;
  assetsPath?: string;
  metadata?: SkillMetadata;
  eligible: boolean;
  disabledReasons: string[];
}

export interface SkillHandlerContext {
  agentId: string;
  taskPrompt: string;
  workspaceRoot: string;
}

export interface SkillExecutionResult {
  success: boolean;
  summary: string;
  data: unknown;
  error?: string;
}

export type SkillHandler = (
  input: unknown,
  context: SkillHandlerContext
) => Promise<SkillExecutionResult>;

export interface SkillDefinition {
  manifest: SkillManifest;
  inputSchema: Record<string, unknown>;
  handler: SkillHandler;
}

export interface SkillToolCallRecord {
  name: string;
  input: unknown;
  success: boolean;
  summary: string;
  durationMs: number;
  timestamp: string;
  turnIndex: number;
  callIndex: number;
}

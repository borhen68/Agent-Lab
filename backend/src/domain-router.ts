import {
  DEFAULT_CRITERIA_WEIGHTS,
  JudgeWeights,
  normalizeJudgeWeights,
} from './judge';
import { categorizePrompt, TaskCategory } from './task-category';

export type ObjectiveJudgeMode = 'none' | 'coding-v1';
export type DomainJudgeMode = 'single' | 'consensus';

export interface DomainProfile {
  id: TaskCategory;
  label: string;
  description: string;
  defaultSkills: string[];
  defaultJudgeWeights: JudgeWeights;
  defaultJudgeMode: DomainJudgeMode;
  objectiveMode: ObjectiveJudgeMode;
  promptHints: string[];
}

export interface DomainResolutionInput {
  taskPrompt: string;
  taskCategory?: TaskCategory;
  activeSkillNames?: string[];
  judgeMode?: string;
  criteriaWeights?: Partial<JudgeWeights>;
}

export interface ResolvedDomainPlan {
  profile: DomainProfile;
  taskCategory: TaskCategory;
  activeSkillNames: string[] | undefined;
  judgeMode: DomainJudgeMode;
  criteriaWeights: JudgeWeights;
  promptHints: string[];
}

const CODING_WEIGHTS = normalizeJudgeWeights({
  accuracy: 0.45,
  completeness: 0.25,
  clarity: 0.1,
  insight: 0.2,
});

const FINANCE_WEIGHTS = normalizeJudgeWeights({
  accuracy: 0.4,
  completeness: 0.25,
  clarity: 0.1,
  insight: 0.25,
});

const RESEARCH_WEIGHTS = normalizeJudgeWeights({
  accuracy: 0.35,
  completeness: 0.25,
  clarity: 0.2,
  insight: 0.2,
});

const MATH_WEIGHTS = normalizeJudgeWeights({
  accuracy: 0.45,
  completeness: 0.25,
  clarity: 0.15,
  insight: 0.15,
});

const DOMAIN_PROFILES: Record<TaskCategory, DomainProfile> = {
  coding: {
    id: 'coding',
    label: 'Coding',
    description: 'Code changes with executable verification and repo-aware reasoning.',
    defaultSkills: ['workspace-shell', 'code-executor', 'file-reader', 'calculator'],
    defaultJudgeWeights: CODING_WEIGHTS,
    defaultJudgeMode: 'single',
    objectiveMode: 'coding-v1',
    promptHints: [
      'Treat this as a coding task. Prefer concrete, patchable implementation details.',
      'Run verification commands when tools are available and report actual outcomes.',
      'Do not claim tests/lint pass unless you executed verification.',
    ],
  },
  finance: {
    id: 'finance',
    label: 'Finance',
    description: 'Financial analysis with exact math, risk framing, and source recency.',
    defaultSkills: ['calculator', 'web-search', 'file-reader'],
    defaultJudgeWeights: FINANCE_WEIGHTS,
    defaultJudgeMode: 'single',
    objectiveMode: 'none',
    promptHints: [
      'Treat this as a finance task. Use exact computation for any numeric claims.',
      'When market/current facts are needed, verify with recent sources.',
      'Include risk assumptions and uncertainty explicitly.',
    ],
  },
  research: {
    id: 'research',
    label: 'Research',
    description: 'Source-backed synthesis with credibility and contradiction checks.',
    defaultSkills: ['web-search', 'file-reader'],
    defaultJudgeWeights: RESEARCH_WEIGHTS,
    defaultJudgeMode: 'single',
    objectiveMode: 'none',
    promptHints: [
      'Prioritize source quality, recency, and contradiction checks.',
      'State evidence boundaries and unresolved uncertainty.',
    ],
  },
  analysis: {
    id: 'analysis',
    label: 'Analysis',
    description: 'Document and tradeoff analysis with clear recommendation framing.',
    defaultSkills: ['file-reader', 'calculator'],
    defaultJudgeWeights: { ...DEFAULT_CRITERIA_WEIGHTS },
    defaultJudgeMode: 'single',
    objectiveMode: 'none',
    promptHints: [
      'Structure output as findings, tradeoffs, and recommended next action.',
    ],
  },
  math: {
    id: 'math',
    label: 'Math',
    description: 'Precise calculation with verification over approximated reasoning.',
    defaultSkills: ['calculator', 'code-executor'],
    defaultJudgeWeights: MATH_WEIGHTS,
    defaultJudgeMode: 'single',
    objectiveMode: 'none',
    promptHints: [
      'Use deterministic computation for exact numeric answers.',
      'Show intermediate assumptions only when they affect final correctness.',
    ],
  },
  creative: {
    id: 'creative',
    label: 'Creative',
    description: 'Creative ideation with originality and coherence.',
    defaultSkills: [],
    defaultJudgeWeights: normalizeJudgeWeights({
      accuracy: 0.2,
      completeness: 0.2,
      clarity: 0.3,
      insight: 0.3,
    }),
    defaultJudgeMode: 'single',
    objectiveMode: 'none',
    promptHints: [
      'Prioritize originality and internal consistency over literal factuality.',
    ],
  },
  general: {
    id: 'general',
    label: 'General',
    description: 'Balanced reasoning profile for broad tasks.',
    defaultSkills: ['calculator', 'file-reader', 'web-search'],
    defaultJudgeWeights: { ...DEFAULT_CRITERIA_WEIGHTS },
    defaultJudgeMode: 'single',
    objectiveMode: 'none',
    promptHints: [],
  },
};

function dedupeNames(input?: string[]): string[] | undefined {
  if (!input) return undefined;
  const cleaned = input.map((item) => item.trim()).filter(Boolean);
  return Array.from(new Set(cleaned));
}

function normalizeJudgeMode(value: string | undefined, fallback: DomainJudgeMode): DomainJudgeMode {
  if (!value) return fallback;
  return value.toLowerCase() === 'consensus' ? 'consensus' : 'single';
}

function hasExplicitWeights(weights?: Partial<JudgeWeights>): boolean {
  if (!weights) return false;
  const hasAnyMetric = ['accuracy', 'completeness', 'clarity', 'insight'].some((key) => {
    const candidate = weights[key as keyof JudgeWeights];
    return typeof candidate === 'number' && Number.isFinite(candidate);
  });
  if (!hasAnyMetric) return false;

  const normalizedIncoming = normalizeJudgeWeights(weights);
  const normalizedGlobalDefault = normalizeJudgeWeights(DEFAULT_CRITERIA_WEIGHTS);
  const sameAsGlobalDefault =
    Math.abs(normalizedIncoming.accuracy - normalizedGlobalDefault.accuracy) < 1e-6 &&
    Math.abs(normalizedIncoming.completeness - normalizedGlobalDefault.completeness) < 1e-6 &&
    Math.abs(normalizedIncoming.clarity - normalizedGlobalDefault.clarity) < 1e-6 &&
    Math.abs(normalizedIncoming.insight - normalizedGlobalDefault.insight) < 1e-6;

  return !sameAsGlobalDefault;
}

export function listDomainProfiles(): DomainProfile[] {
  return Object.values(DOMAIN_PROFILES).map((profile) => ({
    ...profile,
    defaultSkills: [...profile.defaultSkills],
    promptHints: [...profile.promptHints],
    defaultJudgeWeights: { ...profile.defaultJudgeWeights },
  }));
}

export function resolveDomainPlan(input: DomainResolutionInput): ResolvedDomainPlan {
  const taskCategory = input.taskCategory || categorizePrompt(input.taskPrompt);
  const profile = DOMAIN_PROFILES[taskCategory] || DOMAIN_PROFILES.general;
  const requestedSkills = dedupeNames(input.activeSkillNames);
  const usingExplicitWeights = hasExplicitWeights(input.criteriaWeights);
  const criteriaWeights = usingExplicitWeights
    ? normalizeJudgeWeights(input.criteriaWeights)
    : { ...profile.defaultJudgeWeights };

  return {
    profile,
    taskCategory: profile.id,
    activeSkillNames: requestedSkills ?? [...profile.defaultSkills],
    judgeMode: normalizeJudgeMode(input.judgeMode, profile.defaultJudgeMode),
    criteriaWeights,
    promptHints: [...profile.promptHints],
  };
}

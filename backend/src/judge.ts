import Anthropic from '@anthropic-ai/sdk';
import { z } from 'zod';
import logger from './logger';
import { AgentRunResult } from './agent-runner';
import {
  defaultModelForProvider,
  LLMProvider,
  normalizeProvider,
  resolveProviderApiKey,
} from './llm/provider';
import { TaskCategory } from './task-category';

export interface JudgeWeights {
  accuracy: number;
  completeness: number;
  clarity: number;
  insight: number;
}

export interface MetricEvidence {
  quote: string;
  reason: string;
  startChar?: number;
  endChar?: number;
}

export interface JudgeScore {
  agentId: string;
  accuracy: number;
  completeness: number;
  clarity: number;
  insight: number;
  total: number;
  baseTotal: number;
  diversityPenaltyApplied: boolean;
  maxSimilarity: number;
  reasoning: string;
  metricEvidence: {
    accuracy: MetricEvidence;
    completeness: MetricEvidence;
    clarity: MetricEvidence;
    insight: MetricEvidence;
  };
  objectiveAdjustment?: ObjectiveAdjustment;
}

export interface ObjectiveAdjustment {
  mode: 'coding-v1';
  objectiveScore: number;
  accuracyDelta: number;
  completenessDelta: number;
  verificationRuns: number;
  successfulVerificationRuns: number;
  failedVerificationRuns: number;
  testRuns: number;
  passedTestRuns: number;
  failedTestRuns: number;
  lintRuns: number;
  failedLintRuns: number;
  notes: string[];
}

export interface JudgeResult {
  winner: string;
  scores: JudgeScore[];
  summary: string;
  judgedAt: string;
  judgePromptVersion: string;
  criteriaWeights: JudgeWeights;
  mode?: 'single' | 'consensus';
  panelId?: number;
  runs?: Array<{
    panelId?: number;
    winner: string;
    summary: string;
    scores: JudgeScore[];
  }>;
}

export interface JudgeOptions {
  provider?: LLMProvider | string;
  model?: string;
  apiKey?: string;
  criteriaWeights?: Partial<JudgeWeights>;
  judgePromptVersion?: string;
  panelId?: number;
  taskCategory?: TaskCategory;
  objectiveMode?: ObjectiveJudgeMode;
}

export type ObjectiveJudgeMode = 'none' | 'coding-v1';

export const DEFAULT_JUDGE_PROMPT_VERSION = 'judge-v2';
export const DEFAULT_CRITERIA_WEIGHTS: JudgeWeights = {
  accuracy: 0.3,
  completeness: 0.3,
  clarity: 0.2,
  insight: 0.2,
};

const DIVERSITY_SIMILARITY_THRESHOLD = 0.72;
const DIVERSITY_PENALTY_FACTOR = 0.8;

const metricEvidenceSchema = z.object({
  quote: z.string().min(1),
  reason: z.string().min(1),
});

const scoreSchema = z.object({
  agentId: z.string().min(1),
  accuracy: z.coerce.number().min(0).max(10),
  completeness: z.coerce.number().min(0).max(10),
  clarity: z.coerce.number().min(0).max(10),
  insight: z.coerce.number().min(0).max(10),
  reasoning: z.string().min(1),
  metricEvidence: z.object({
    accuracy: metricEvidenceSchema,
    completeness: metricEvidenceSchema,
    clarity: metricEvidenceSchema,
    insight: metricEvidenceSchema,
  }),
});

const judgeResponseSchema = z.object({
  scores: z.array(scoreSchema).min(1),
  winner: z.string().min(1),
  summary: z.string().min(1),
});

const STOP_WORDS = new Set([
  'the', 'and', 'for', 'that', 'with', 'this', 'from', 'into', 'your', 'their', 'have',
  'will', 'would', 'could', 'there', 'what', 'when', 'where', 'which', 'about', 'because',
  'while', 'should', 'after', 'before', 'than', 'then', 'they', 'them', 'were', 'been',
  'being', 'also', 'over', 'under', 'such', 'only', 'very', 'much', 'more', 'most',
]);

function toPercent(value: number): string {
  return `${Math.round(value * 100)}%`;
}

function buildSystemPrompt(
  weights: JudgeWeights,
  promptVersion: string,
  objectiveMode: ObjectiveJudgeMode
): string {
  const objectiveInstructions = objectiveMode === 'coding-v1'
    ? '\nFor coding tasks, prioritize verifiable execution evidence: test runs, lint/type checks, and concrete failure/success outputs. Penalize unsupported claims like "tests pass" without proof.'
    : '';

  return `You are an impartial expert judge evaluating AI agent responses.
Prompt version: ${promptVersion}

Score each response on:
- accuracy (${toPercent(weights.accuracy)}): factual correctness and validity
- completeness (${toPercent(weights.completeness)}): how fully it addresses the task
- clarity (${toPercent(weights.clarity)}): structure, readability, communication quality
- insight (${toPercent(weights.insight)}): depth and non-obvious value
${objectiveInstructions}

You must provide evidence for every metric by quoting exact text from the agent response.
Do not invent evidence. If weak evidence exists, quote the weakest relevant snippet and explain why it is weak.

CRITICAL: Respond ONLY with valid JSON matching this exact shape:
{
  "scores": [
    {
      "agentId": "agent-1",
      "accuracy": 8,
      "completeness": 7,
      "clarity": 9,
      "insight": 6,
      "reasoning": "Short rationale",
      "metricEvidence": {
        "accuracy": {"quote": "exact snippet", "reason": "why this supports score"},
        "completeness": {"quote": "exact snippet", "reason": "why this supports score"},
        "clarity": {"quote": "exact snippet", "reason": "why this supports score"},
        "insight": {"quote": "exact snippet", "reason": "why this supports score"}
      }
    }
  ],
  "winner": "agent-1",
  "summary": "One sentence explaining winner."
}`;
}

function normalizeQuote(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) return '';
  return trimmed.length <= 240 ? trimmed : `${trimmed.slice(0, 240)}...`;
}

function locateEvidenceRange(response: string, quote: string): { startChar?: number; endChar?: number } {
  const candidate = normalizeQuote(quote);
  if (!candidate) return {};

  const directIndex = response.indexOf(candidate);
  if (directIndex >= 0) {
    return {
      startChar: directIndex,
      endChar: directIndex + candidate.length,
    };
  }

  const compactQuote = candidate.replace(/\s+/g, ' ').trim();
  if (!compactQuote) return {};

  const compactResponse = response.replace(/\s+/g, ' ');
  const compactIndex = compactResponse.indexOf(compactQuote);
  if (compactIndex < 0) return {};

  return {
    startChar: compactIndex,
    endChar: compactIndex + compactQuote.length,
  };
}

function toTokenSet(value: string): Set<string> {
  const tokens = value
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter((token) => token.length > 2 && !STOP_WORDS.has(token));
  return new Set(tokens);
}

function jaccardSimilarity(left: Set<string>, right: Set<string>): number {
  if (left.size === 0 && right.size === 0) return 1;
  if (left.size === 0 || right.size === 0) return 0;

  let intersection = 0;
  for (const token of left) {
    if (right.has(token)) intersection += 1;
  }
  const union = left.size + right.size - intersection;
  if (union === 0) return 0;
  return intersection / union;
}

export function normalizeJudgeWeights(input?: Partial<JudgeWeights>): JudgeWeights {
  const merged: JudgeWeights = {
    accuracy: Number(input?.accuracy ?? DEFAULT_CRITERIA_WEIGHTS.accuracy),
    completeness: Number(input?.completeness ?? DEFAULT_CRITERIA_WEIGHTS.completeness),
    clarity: Number(input?.clarity ?? DEFAULT_CRITERIA_WEIGHTS.clarity),
    insight: Number(input?.insight ?? DEFAULT_CRITERIA_WEIGHTS.insight),
  };

  const safe: JudgeWeights = {
    accuracy: Number.isFinite(merged.accuracy) && merged.accuracy >= 0 ? merged.accuracy : 0,
    completeness: Number.isFinite(merged.completeness) && merged.completeness >= 0 ? merged.completeness : 0,
    clarity: Number.isFinite(merged.clarity) && merged.clarity >= 0 ? merged.clarity : 0,
    insight: Number.isFinite(merged.insight) && merged.insight >= 0 ? merged.insight : 0,
  };

  const total = safe.accuracy + safe.completeness + safe.clarity + safe.insight;
  if (total <= 0) {
    return { ...DEFAULT_CRITERIA_WEIGHTS };
  }

  return {
    accuracy: Number((safe.accuracy / total).toFixed(6)),
    completeness: Number((safe.completeness / total).toFixed(6)),
    clarity: Number((safe.clarity / total).toFixed(6)),
    insight: Number((safe.insight / total).toFixed(6)),
  };
}

function weightedTotal(weights: JudgeWeights, score: Pick<JudgeScore, 'accuracy' | 'completeness' | 'clarity' | 'insight'>): number {
  const weighted10 =
    score.accuracy * weights.accuracy +
    score.completeness * weights.completeness +
    score.clarity * weights.clarity +
    score.insight * weights.insight;
  return Math.round(weighted10 * 4);
}

function defaultEvidence(metric: string): MetricEvidence {
  return {
    quote: '[no direct quote provided]',
    reason: `Judge did not return ${metric} evidence; fallback applied.`,
  };
}

function fallbackScore(agentId: string, reason: string, weights: JudgeWeights): JudgeScore {
  const base = weightedTotal(weights, {
    accuracy: 5,
    completeness: 5,
    clarity: 5,
    insight: 5,
  });

  return {
    agentId,
    accuracy: 5,
    completeness: 5,
    clarity: 5,
    insight: 5,
    total: base,
    baseTotal: base,
    diversityPenaltyApplied: false,
    maxSimilarity: 0,
    reasoning: reason,
    metricEvidence: {
      accuracy: defaultEvidence('accuracy'),
      completeness: defaultEvidence('completeness'),
      clarity: defaultEvidence('clarity'),
      insight: defaultEvidence('insight'),
    },
  };
}

interface CodingObjectiveSignals {
  verificationRuns: number;
  successfulVerificationRuns: number;
  failedVerificationRuns: number;
  testRuns: number;
  passedTestRuns: number;
  failedTestRuns: number;
  lintRuns: number;
  failedLintRuns: number;
  claimedPassingTestsWithoutEvidence: boolean;
}

function clampMetric(value: number): number {
  return Number(Math.max(0, Math.min(10, value)).toFixed(2));
}

function toStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((item): item is string => typeof item === 'string')
    .map((item) => item.trim().toLowerCase())
    .filter(Boolean);
}

function extractShellInvocation(input: unknown): { command: string; args: string[] } | null {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return null;
  const payload = input as Record<string, unknown>;
  const command = typeof payload.command === 'string' ? payload.command.trim().toLowerCase() : '';
  if (!command) return null;
  return {
    command,
    args: toStringArray(payload.args),
  };
}

function isPackageManager(command: string): boolean {
  return command === 'npm' || command === 'pnpm' || command === 'yarn';
}

function isTestInvocation(command: string, args: string[]): boolean {
  if (!isPackageManager(command)) return false;
  const first = args[0] || '';
  const second = args[1] || '';
  return first === 'test' || ((first === 'run' || first === 'run-script') && second === 'test');
}

function isLintInvocation(command: string, args: string[]): boolean {
  if (!isPackageManager(command)) return false;
  const first = args[0] || '';
  const second = args[1] || '';
  if (first === 'lint' || first === 'typecheck' || first === 'check') return true;
  return (first === 'run' || first === 'run-script') &&
    (second === 'lint' || second === 'typecheck' || second === 'check');
}

function hasUnverifiedPassingClaim(response: string): boolean {
  return /\b(all tests? pass(ed)?|tests? pass(ed)?|no failing tests?)\b/i.test(response);
}

function hasCodeExecutorTestPattern(input: unknown): boolean {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return false;
  const payload = input as Record<string, unknown>;
  const code = typeof payload.code === 'string' ? payload.code : '';
  if (!code) return false;
  return /\b(assert|expect\(|pytest|unittest|describe\(|it\(|test\(|cargo test)\b/i.test(code);
}

function extractCodingObjectiveSignals(result: AgentRunResult): CodingObjectiveSignals {
  const signals: CodingObjectiveSignals = {
    verificationRuns: 0,
    successfulVerificationRuns: 0,
    failedVerificationRuns: 0,
    testRuns: 0,
    passedTestRuns: 0,
    failedTestRuns: 0,
    lintRuns: 0,
    failedLintRuns: 0,
    claimedPassingTestsWithoutEvidence: false,
  };

  for (const usage of result.skillUsage) {
    if (usage.name === 'workspace-shell' || usage.name === 'code-executor') {
      signals.verificationRuns += 1;
      if (usage.success) {
        signals.successfulVerificationRuns += 1;
      } else {
        signals.failedVerificationRuns += 1;
      }
    }

    if (usage.name === 'workspace-shell') {
      const invocation = extractShellInvocation(usage.input);
      if (!invocation) continue;

      if (isTestInvocation(invocation.command, invocation.args)) {
        signals.testRuns += 1;
        if (usage.success) {
          signals.passedTestRuns += 1;
        } else {
          signals.failedTestRuns += 1;
        }
      }

      if (isLintInvocation(invocation.command, invocation.args)) {
        signals.lintRuns += 1;
        if (!usage.success) signals.failedLintRuns += 1;
      }
    }

    if (usage.name === 'code-executor' && hasCodeExecutorTestPattern(usage.input)) {
      signals.testRuns += 1;
      if (usage.success) {
        signals.passedTestRuns += 1;
      } else {
        signals.failedTestRuns += 1;
      }
    }
  }

  signals.claimedPassingTestsWithoutEvidence =
    hasUnverifiedPassingClaim(result.response) && signals.testRuns === 0;

  return signals;
}

function computeCodingObjectiveScore(signals: CodingObjectiveSignals): {
  objectiveScore: number;
  notes: string[];
} {
  let score = 4.2;
  const notes: string[] = [];

  if (signals.verificationRuns > 0) {
    score += 1.2;
    score += Math.min(2.2, signals.successfulVerificationRuns * 0.45);
    score -= Math.min(1.8, signals.failedVerificationRuns * 0.55);
  } else {
    score -= 1.2;
    notes.push('No executable verification steps detected.');
  }

  if (signals.testRuns > 0) {
    const passRate = signals.passedTestRuns / Math.max(1, signals.testRuns);
    score += 0.8 + (passRate * 2.1);
    if (signals.failedTestRuns > 0) {
      notes.push(`${signals.failedTestRuns} test run(s) failed.`);
    }
  } else {
    score -= 0.4;
    notes.push('No explicit test execution observed.');
  }

  if (signals.lintRuns > 0) {
    score += signals.failedLintRuns === 0 ? 0.4 : -Math.min(1, signals.failedLintRuns * 0.35);
  }

  if (signals.claimedPassingTestsWithoutEvidence) {
    score -= 1.5;
    notes.push('Claimed tests passed without observed execution evidence.');
  }

  return {
    objectiveScore: clampMetric(score),
    notes,
  };
}

function applyCodingObjectiveScoring(
  scores: JudgeScore[],
  successfulResults: AgentRunResult[],
  weights: JudgeWeights
): JudgeScore[] {
  const resultByAgent = new Map(successfulResults.map((result) => [result.agentId, result]));

  return scores.map((score) => {
    const result = resultByAgent.get(score.agentId);
    if (!result) return score;

    const signals = extractCodingObjectiveSignals(result);
    const { objectiveScore, notes } = computeCodingObjectiveScore(signals);
    const adjustedAccuracy = clampMetric((score.accuracy * 0.72) + (objectiveScore * 0.28));
    const adjustedCompleteness = clampMetric((score.completeness * 0.82) + (objectiveScore * 0.18));
    const adjustedBaseTotal = weightedTotal(weights, {
      accuracy: adjustedAccuracy,
      completeness: adjustedCompleteness,
      clarity: score.clarity,
      insight: score.insight,
    });

    const objectiveNote = `Objective coding checks: verification ${signals.successfulVerificationRuns}/${signals.verificationRuns}, tests ${signals.passedTestRuns}/${signals.testRuns}.`;
    return {
      ...score,
      accuracy: adjustedAccuracy,
      completeness: adjustedCompleteness,
      baseTotal: adjustedBaseTotal,
      total: adjustedBaseTotal,
      reasoning: `${score.reasoning} ${objectiveNote}`.trim(),
      objectiveAdjustment: {
        mode: 'coding-v1',
        objectiveScore,
        accuracyDelta: Number((adjustedAccuracy - score.accuracy).toFixed(2)),
        completenessDelta: Number((adjustedCompleteness - score.completeness).toFixed(2)),
        verificationRuns: signals.verificationRuns,
        successfulVerificationRuns: signals.successfulVerificationRuns,
        failedVerificationRuns: signals.failedVerificationRuns,
        testRuns: signals.testRuns,
        passedTestRuns: signals.passedTestRuns,
        failedTestRuns: signals.failedTestRuns,
        lintRuns: signals.lintRuns,
        failedLintRuns: signals.failedLintRuns,
        notes,
      },
    };
  });
}

export function applyDiversityPenalty(
  scores: JudgeScore[],
  successfulResults: AgentRunResult[]
): JudgeScore[] {
  const tokenSets = new Map<string, Set<string>>();
  for (const result of successfulResults) {
    const signal = `${result.response}\n${result.reasoning.map((step) => step.thought).join('\n')}`;
    tokenSets.set(result.agentId, toTokenSet(signal));
  }

  const similarityByAgent = new Map<string, number>();
  for (let i = 0; i < successfulResults.length; i += 1) {
    for (let j = i + 1; j < successfulResults.length; j += 1) {
      const left = successfulResults[i];
      const right = successfulResults[j];
      const sim = jaccardSimilarity(
        tokenSets.get(left.agentId) ?? new Set(),
        tokenSets.get(right.agentId) ?? new Set()
      );
      similarityByAgent.set(left.agentId, Math.max(similarityByAgent.get(left.agentId) ?? 0, sim));
      similarityByAgent.set(right.agentId, Math.max(similarityByAgent.get(right.agentId) ?? 0, sim));
    }
  }

  return scores.map((score) => {
    const maxSimilarity = Number((similarityByAgent.get(score.agentId) ?? 0).toFixed(4));
    const penaltyApplies = maxSimilarity >= DIVERSITY_SIMILARITY_THRESHOLD;
    const penalizedTotal = penaltyApplies
      ? Math.max(0, Math.round(score.baseTotal * DIVERSITY_PENALTY_FACTOR))
      : score.baseTotal;

    return {
      ...score,
      total: penalizedTotal,
      diversityPenaltyApplied: penaltyApplies,
      maxSimilarity,
    };
  });
}

function resolveWinner(scores: JudgeScore[]): string {
  return scores
    .slice()
    .sort((a, b) =>
      b.total - a.total ||
      b.accuracy - a.accuracy ||
      b.completeness - a.completeness ||
      b.insight - a.insight ||
      a.agentId.localeCompare(b.agentId)
    )[0]?.agentId || scores[0]?.agentId || 'agent-1';
}

async function requestJudgeResponse(
  provider: LLMProvider,
  model: string,
  apiKey: string,
  systemPrompt: string,
  judgePrompt: string
): Promise<string> {
  if (provider === 'anthropic') {
    const client = new Anthropic({ apiKey });
    const response = await client.messages.create({
      model,
      max_tokens: 2200,
      temperature: 0.35,
      system: systemPrompt,
      messages: [{ role: 'user', content: judgePrompt }],
    });

    return response.content
      .filter((block) => block.type === 'text')
      .map((block: any) => block.text || '')
      .join('');
  }

  if (provider === 'openai') {
    const response = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model,
        temperature: 0.35,
        max_tokens: 2200,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: judgePrompt },
        ],
      }),
    });

    const body = await response.json().catch(() => ({}));
    if (!response.ok) {
      const detail = typeof body?.error?.message === 'string'
        ? body.error.message
        : response.statusText;
      throw new Error(`OpenAI judge request failed (${response.status}): ${detail}`);
    }

    const content = body?.choices?.[0]?.message?.content;
    if (typeof content === 'string') return content;
    if (Array.isArray(content)) {
      return content
        .map((item: any) => (typeof item?.text === 'string' ? item.text : ''))
        .join('\n');
    }
    return '';
  }

  const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(apiKey)}`;
  const response = await fetch(endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      system_instruction: {
        parts: [{ text: systemPrompt }],
      },
      contents: [
        {
          role: 'user',
          parts: [{ text: judgePrompt }],
        },
      ],
      generationConfig: {
        maxOutputTokens: 2200,
        temperature: 0.35,
      },
    }),
  });

  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    const detail = typeof body?.error?.message === 'string'
      ? body.error.message
      : response.statusText;
    throw new Error(`Gemini judge request failed (${response.status}): ${detail}`);
  }

  const parts: any[] = Array.isArray(body?.candidates?.[0]?.content?.parts)
    ? body.candidates[0].content.parts
    : [];

  return parts
    .filter((part) => typeof part?.text === 'string')
    .map((part) => part.text as string)
    .join('');
}

export async function judgeResponses(
  taskPrompt: string,
  results: AgentRunResult[],
  options: JudgeOptions = {}
): Promise<JudgeResult> {
  const successfulResults = results.filter((result) => result.success && result.response.trim().length > 0);
  const provider = normalizeProvider(
    typeof options.provider === 'string' ? options.provider : undefined
  );
  const model = options.model?.trim() || defaultModelForProvider(provider);
  const apiKey = resolveProviderApiKey(provider, options.apiKey);
  const criteriaWeights = normalizeJudgeWeights(options.criteriaWeights);
  const judgePromptVersion = options.judgePromptVersion?.trim() || DEFAULT_JUDGE_PROMPT_VERSION;
  const objectiveMode: ObjectiveJudgeMode =
    options.objectiveMode === 'coding-v1'
      ? 'coding-v1'
      : options.objectiveMode === 'none'
        ? 'none'
        : options.taskCategory === 'coding'
          ? 'coding-v1'
          : 'none';

  if (successfulResults.length === 0) {
    throw new Error('No successful results to judge');
  }

  if (successfulResults.length === 1) {
    const winner = successfulResults[0];
    let singleScores = [fallbackScore(
      winner.agentId,
      'Only successful agent - won by default.',
      criteriaWeights
    )];
    if (objectiveMode === 'coding-v1') {
      singleScores = applyCodingObjectiveScoring(singleScores, [winner], criteriaWeights);
    }

    return {
      winner: winner.agentId,
      scores: singleScores,
      summary: `${winner.agentId} won by default as the only successful agent.`,
      judgedAt: new Date().toISOString(),
      judgePromptVersion,
      criteriaWeights,
      mode: 'single',
      panelId: options.panelId,
    };
  }

  logger.info(
    `⚖️ Judge evaluating ${successfulResults.length} responses with ${provider}/${model}` +
    (options.panelId ? ` (panel ${options.panelId})` : '') +
    '...'
  );

  const agentResponsesText = successfulResults
    .map((result) => `=== ${result.agentId} (${result.persona}) ===\n${result.response}`)
    .join('\n\n');

  const panelSuffix = options.panelId ? `\nPanelist: ${options.panelId}` : '';
  const judgePrompt = `TASK GIVEN TO AGENTS:
"${taskPrompt}"

AGENT RESPONSES TO EVALUATE:
${agentResponsesText}
${panelSuffix}

Score each response and identify the winner.`;

  try {
    if (!apiKey) {
      throw new Error(`Provider ${provider} is not configured. Missing API key.`);
    }

    const systemPrompt = buildSystemPrompt(criteriaWeights, judgePromptVersion, objectiveMode);
    const rawText = await requestJudgeResponse(
      provider,
      model,
      apiKey,
      systemPrompt,
      judgePrompt
    );

    const cleanJson = rawText.replace(/```json|```/g, '').trim();
    const parsed = judgeResponseSchema.parse(JSON.parse(cleanJson));
    const incomingByAgent = new Map(parsed.scores.map((score) => [score.agentId, score]));

    let scores: JudgeScore[] = successfulResults.map((result) => {
      const parsedScore = incomingByAgent.get(result.agentId);
      if (!parsedScore) {
        return fallbackScore(
          result.agentId,
          'Judge omitted this response; fallback score applied.',
          criteriaWeights
        );
      }

      const baseTotal = weightedTotal(criteriaWeights, parsedScore);
      const metricEvidence = {
        accuracy: {
          ...parsedScore.metricEvidence.accuracy,
          quote: normalizeQuote(parsedScore.metricEvidence.accuracy.quote),
          ...locateEvidenceRange(result.response, parsedScore.metricEvidence.accuracy.quote),
        },
        completeness: {
          ...parsedScore.metricEvidence.completeness,
          quote: normalizeQuote(parsedScore.metricEvidence.completeness.quote),
          ...locateEvidenceRange(result.response, parsedScore.metricEvidence.completeness.quote),
        },
        clarity: {
          ...parsedScore.metricEvidence.clarity,
          quote: normalizeQuote(parsedScore.metricEvidence.clarity.quote),
          ...locateEvidenceRange(result.response, parsedScore.metricEvidence.clarity.quote),
        },
        insight: {
          ...parsedScore.metricEvidence.insight,
          quote: normalizeQuote(parsedScore.metricEvidence.insight.quote),
          ...locateEvidenceRange(result.response, parsedScore.metricEvidence.insight.quote),
        },
      };

      return {
        agentId: result.agentId,
        accuracy: parsedScore.accuracy,
        completeness: parsedScore.completeness,
        clarity: parsedScore.clarity,
        insight: parsedScore.insight,
        total: baseTotal,
        baseTotal,
        diversityPenaltyApplied: false,
        maxSimilarity: 0,
        reasoning: parsedScore.reasoning,
        metricEvidence,
      };
    });

    if (objectiveMode === 'coding-v1') {
      scores = applyCodingObjectiveScoring(scores, successfulResults, criteriaWeights);
    }

    scores = applyDiversityPenalty(scores, successfulResults);
    const winner = resolveWinner(scores);
    logger.info(`⚖️ Judge verdict: ${winner} wins`);

    return {
      winner,
      scores,
      summary: parsed.summary || `${winner} produced the strongest overall answer.`,
      judgedAt: new Date().toISOString(),
      judgePromptVersion,
      criteriaWeights,
      mode: 'single',
      panelId: options.panelId,
    };
  } catch (error) {
    logger.error('Judge failed to parse response:', error);

    let fallbackScores = successfulResults.map((result) =>
      fallbackScore(result.agentId, 'Judge unavailable - fallback scoring used.', criteriaWeights)
    );
    if (objectiveMode === 'coding-v1') {
      fallbackScores = applyCodingObjectiveScoring(fallbackScores, successfulResults, criteriaWeights);
    }
    fallbackScores = applyDiversityPenalty(fallbackScores, successfulResults);
    const fallbackWinner = resolveWinner(fallbackScores);

    return {
      winner: fallbackWinner,
      scores: fallbackScores,
      summary: `Judge unavailable - ${fallbackWinner} won by fallback scoring.`,
      judgedAt: new Date().toISOString(),
      judgePromptVersion,
      criteriaWeights,
      mode: 'single',
      panelId: options.panelId,
    };
  }
}

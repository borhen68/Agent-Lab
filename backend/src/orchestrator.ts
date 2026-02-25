import { PrismaClient } from '@prisma/client';
import { getPrismaClient } from './database';
import { setCache } from './redis';
import { runAgent, AgentRunResult, AGENT_PERSONAS, AgentTelemetry } from './agent-runner';
import {
  applyDiversityPenalty,
  DEFAULT_JUDGE_PROMPT_VERSION,
  JudgeResult,
  JudgeScore,
  JudgeWeights,
  judgeResponses,
} from './judge';
import { SkillRegistry } from './skills/registry';
import { config } from './config';
import {
  defaultModelForProvider,
  normalizeProvider,
  resolveProviderApiKey,
} from './llm/provider';
import logger from './logger';
import { TaskCategory } from './task-category';
import { resolveDomainPlan } from './domain-router';

const LEARNING_SCORE_THRESHOLD = 25;
const CONSENSUS_PANEL_COUNT = 3;
const OBSERVATION_MAX_RESPONSE_CHARS = 1500;
const OBSERVATION_MAX_REASONING_STEPS = 6;

export type JudgeMode = 'single' | 'consensus';

export interface OrchestrationResult {
  taskId: string;
  winner: {
    agentId: string;
    persona: string;
    tokensUsed: number;
    timeMs: number;
    judgeScore?: number;
  };
  judgeResult: JudgeResult;
  confidenceGate: ConfidenceGateDecision;
  results: AgentRunResult[];
  completedAt: string;
}

export interface ReplayConfig {
  sourceTaskId: string;
  sourceStrategyId?: string;
  sourceAgentId: string;
  sourcePersona?: string;
  toolSequence: string[];
  reasoningPath: string[];
}

export interface ConfidenceGateDecision {
  enabled: boolean;
  passed: boolean;
  winnerTotal: number;
  winnerAccuracy: number;
  marginToSecond: number;
  minTotal: number;
  minMargin: number;
  minAccuracy: number;
  reason: string;
}

interface TrustSignals {
  confidenceLevel: 'high' | 'medium' | 'low';
  confidenceReason: string;
  confidencePassed: boolean;
  winnerMargin: number;
  winnerTotal: number;
  winnerAccuracy: number;
  evidenceCoverage: number;
  disagreementIndex: number;
  panelAgreement?: number;
}

function buildEnrichedPrompt(basePrompt: string, hints: string[]): string {
  if (hints.length === 0) return basePrompt;

  const hintLines = hints.map((hint) => `- ${hint}`).join('\n');
  return `${basePrompt}\n\nPrior learned hints:\n${hintLines}`;
}

function toValidDate(value: string): Date {
  const candidate = new Date(value);
  return Number.isNaN(candidate.getTime()) ? new Date() : candidate;
}

function safeParseJson<T>(value: unknown, fallback: T): T {
  if (typeof value !== 'string') return fallback;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

function evaluateConfidenceGate(judgeResult: JudgeResult): ConfidenceGateDecision {
  const minTotal = config.CONFIDENCE_GATE_MIN_TOTAL;
  const minMargin = config.CONFIDENCE_GATE_MIN_MARGIN;
  const minAccuracy = config.CONFIDENCE_GATE_MIN_ACCURACY;
  const enabled = config.CONFIDENCE_GATE_ENABLED;

  const sorted = judgeResult.scores
    .slice()
    .sort((left, right) => right.total - left.total);
  const winner = sorted[0];
  const second = sorted[1];

  const winnerTotal = winner?.total ?? 0;
  const winnerAccuracy = winner?.accuracy ?? 0;
  const marginToSecond = second ? winnerTotal - second.total : winnerTotal;

  if (!enabled) {
    return {
      enabled,
      passed: true,
      winnerTotal,
      winnerAccuracy,
      marginToSecond,
      minTotal,
      minMargin,
      minAccuracy,
      reason: 'Confidence gate disabled.',
    };
  }

  const reasons: string[] = [];
  if (winnerTotal < minTotal) {
    reasons.push(`winner total ${winnerTotal}/40 below ${minTotal}/40`);
  }
  if (marginToSecond < minMargin) {
    reasons.push(`winner margin ${marginToSecond.toFixed(2)} below ${minMargin.toFixed(2)}`);
  }
  if (winnerAccuracy < minAccuracy) {
    reasons.push(`winner accuracy ${winnerAccuracy.toFixed(2)} below ${minAccuracy.toFixed(2)}`);
  }

  const passed = reasons.length === 0;
  return {
    enabled,
    passed,
    winnerTotal,
    winnerAccuracy,
    marginToSecond: Number(marginToSecond.toFixed(2)),
    minTotal,
    minMargin,
    minAccuracy,
    reason: passed
      ? `Gate passed (total ${winnerTotal}/40, margin ${marginToSecond.toFixed(2)}, accuracy ${winnerAccuracy.toFixed(2)}).`
      : reasons.join('; '),
  };
}

function computeEvidenceCoverage(score?: JudgeScore): number {
  if (!score?.metricEvidence) return 0;
  const evidences = Object.values(score.metricEvidence);
  if (evidences.length === 0) return 0;

  const supportedCount = evidences.filter((evidence) => {
    const quote = evidence.quote.trim().toLowerCase();
    const reason = evidence.reason.trim();
    if (!reason) return false;
    return quote.length > 0 && quote !== '[no direct quote provided]';
  }).length;

  return Number((supportedCount / evidences.length).toFixed(4));
}

function deriveConfidenceLevel(
  confidenceGate: ConfidenceGateDecision,
  evidenceCoverage: number,
  disagreementIndex: number
): { level: 'high' | 'medium' | 'low'; reason: string } {
  if (!confidenceGate.passed) {
    return {
      level: 'low',
      reason: `Gate failed: ${confidenceGate.reason}`,
    };
  }

  if (evidenceCoverage >= 0.75 && disagreementIndex <= 0.12) {
    return {
      level: 'high',
      reason: `Gate passed with strong evidence (${Math.round(evidenceCoverage * 100)}%) and low judge disagreement (${Math.round(disagreementIndex * 100)}%).`,
    };
  }

  return {
    level: 'medium',
    reason: `Gate passed but trust is mixed (evidence ${Math.round(evidenceCoverage * 100)}%, disagreement ${Math.round(disagreementIndex * 100)}%).`,
  };
}

function selectPatternThoughts(
  result: AgentRunResult,
  confidenceFloor: number = 0.8
): string[] {
  const bestThoughts = result.reasoning
    .filter((step) => step.confidence >= confidenceFloor)
    .slice(0, 3)
    .map((step) => step.thought);

  return bestThoughts.length > 0
    ? bestThoughts
    : result.reasoning.slice(0, 2).map((step) => step.thought);
}

function buildToolPath(result: AgentRunResult): string {
  return result.telemetry.toolSequence.length > 0
    ? result.telemetry.toolSequence.slice(0, 6).join(' -> ')
    : 'no-tools';
}

function buildPattern(result: AgentRunResult, taskCategory: TaskCategory): string {
  const selectedThoughts = selectPatternThoughts(result, 0.7);
  const thoughtText = selectedThoughts.length > 0
    ? selectedThoughts.join(' -> ')
    : (result.error ? `failure:${result.error}` : 'no-reasoning-captured');

  return `[${result.persona}][${taskCategory}][tools:${buildToolPath(result)}] ${thoughtText}`;
}

function buildObservationPayload(
  result: AgentRunResult,
  score: JudgeScore | undefined,
  extra?: Record<string, unknown>
): string {
  return JSON.stringify({
    success: result.success,
    error: result.error,
    responseSnippet: result.response.slice(0, OBSERVATION_MAX_RESPONSE_CHARS),
    reasoning: result.reasoning.slice(0, OBSERVATION_MAX_REASONING_STEPS).map((step) => ({
      step: step.step,
      confidence: step.confidence,
      thought: step.thought,
    })),
    telemetry: result.telemetry,
    skillUsage: result.skillUsage.map((usage) => ({
      name: usage.name,
      success: usage.success,
      durationMs: usage.durationMs,
      turnIndex: usage.turnIndex,
      callIndex: usage.callIndex,
      summary: usage.summary,
    })),
    score: score
      ? {
        total: score.total,
        baseTotal: score.baseTotal,
        accuracy: score.accuracy,
        completeness: score.completeness,
        clarity: score.clarity,
        insight: score.insight,
        diversityPenaltyApplied: score.diversityPenaltyApplied,
        maxSimilarity: score.maxSimilarity,
      }
      : null,
    ...extra,
  });
}

function buildLearningObservationRows(
  taskId: string,
  judgeResult: JudgeResult | null,
  allResults: AgentRunResult[],
  taskCategory: TaskCategory,
  judgeMode: JudgeMode,
  judgePromptVersion: string,
  failureReason?: string
): Array<{
  taskId: string;
  agentId: string;
  persona: string;
  outcomeType: string;
  taskCategory: string;
  scoreTotal: number;
  scoreBaseTotal: number;
  scoreAccuracy: number;
  scoreCompleteness: number;
  scoreClarity: number;
  scoreInsight: number;
  judgeMode: string;
  judgePromptVersion: string;
  toolPath: string;
  skillCount: number;
  verificationSteps: number;
  usedSearchFirst: boolean;
  pattern: string;
  payload: string;
}> {
  const scoreByAgent = new Map<string, JudgeScore>(
    (judgeResult?.scores || []).map((score) => [score.agentId, score])
  );

  return allResults.map((result) => {
    const score = scoreByAgent.get(result.agentId);
    const isHighWinner =
      judgeResult !== null &&
      result.agentId === judgeResult.winner &&
      (score?.total ?? 0) >= LEARNING_SCORE_THRESHOLD;

    return {
      taskId,
      agentId: result.agentId,
      persona: result.persona,
      outcomeType: isHighWinner ? 'win_pattern' : 'loss_pattern',
      taskCategory,
      scoreTotal: score?.total ?? 0,
      scoreBaseTotal: score?.baseTotal ?? 0,
      scoreAccuracy: score?.accuracy ?? 0,
      scoreCompleteness: score?.completeness ?? 0,
      scoreClarity: score?.clarity ?? 0,
      scoreInsight: score?.insight ?? 0,
      judgeMode: judgeResult?.mode || judgeMode,
      judgePromptVersion: judgeResult?.judgePromptVersion || judgePromptVersion,
      toolPath: buildToolPath(result),
      skillCount: result.skillUsage.length,
      verificationSteps: result.telemetry.verificationSteps,
      usedSearchFirst: result.telemetry.usedSearchFirst,
      pattern: buildPattern(result, taskCategory),
      payload: buildObservationPayload(result, score, failureReason ? { failureReason } : undefined),
    };
  });
}

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) return sorted[middle];
  return Number(((sorted[middle - 1] + sorted[middle]) / 2).toFixed(4));
}

function computeWeightedTotal(weights: JudgeWeights, score: Pick<JudgeScore, 'accuracy' | 'completeness' | 'clarity' | 'insight'>): number {
  const weighted10 =
    score.accuracy * weights.accuracy +
    score.completeness * weights.completeness +
    score.clarity * weights.clarity +
    score.insight * weights.insight;
  return Math.round(weighted10 * 4);
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

function computeConsensusDisagreementIndex(
  judgeRuns: JudgeResult[],
  agentIds: string[]
): number {
  if (judgeRuns.length <= 1 || agentIds.length === 0) return 0;

  const perAgentSpread = agentIds.map((agentId) => {
    const totals = judgeRuns
      .map((run) => run.scores.find((score) => score.agentId === agentId)?.total ?? 0)
      .filter((total) => Number.isFinite(total));

    if (totals.length <= 1) return 0;
    const min = Math.min(...totals);
    const max = Math.max(...totals);
    return (max - min) / 40;
  });

  const averageSpread = perAgentSpread.reduce((sum, value) => sum + value, 0) / perAgentSpread.length;
  return Number(averageSpread.toFixed(4));
}

function aggregateConsensusJudgeRuns(
  judgeRuns: JudgeResult[],
  successfulResults: AgentRunResult[],
  criteriaWeights: JudgeWeights,
  judgePromptVersion: string
): JudgeResult {
  const agentIds = successfulResults.map((result) => result.agentId);
  const scores: JudgeScore[] = agentIds.map((agentId) => {
    const perRunScores = judgeRuns
      .map((run) => run.scores.find((score) => score.agentId === agentId))
      .filter((score): score is JudgeScore => Boolean(score));

    const accuracy = Number(median(perRunScores.map((score) => score.accuracy)).toFixed(2));
    const completeness = Number(median(perRunScores.map((score) => score.completeness)).toFixed(2));
    const clarity = Number(median(perRunScores.map((score) => score.clarity)).toFixed(2));
    const insight = Number(median(perRunScores.map((score) => score.insight)).toFixed(2));
    const baseTotal = computeWeightedTotal(criteriaWeights, {
      accuracy,
      completeness,
      clarity,
      insight,
    });

    const bestRun = perRunScores
      .slice()
      .sort((left, right) => right.total - left.total)[0];

    return {
      agentId,
      accuracy,
      completeness,
      clarity,
      insight,
      total: baseTotal,
      baseTotal,
      diversityPenaltyApplied: false,
      maxSimilarity: 0,
      reasoning: bestRun?.reasoning || 'Consensus median score from multiple judge panels.',
      metricEvidence: bestRun?.metricEvidence || {
        accuracy: { quote: '[consensus-median]', reason: 'Consensus used run-level evidence.' },
        completeness: { quote: '[consensus-median]', reason: 'Consensus used run-level evidence.' },
        clarity: { quote: '[consensus-median]', reason: 'Consensus used run-level evidence.' },
        insight: { quote: '[consensus-median]', reason: 'Consensus used run-level evidence.' },
      },
    };
  });

  const penalizedScores = applyDiversityPenalty(scores, successfulResults);
  const winner = resolveWinner(penalizedScores);
  const winnerVotes = judgeRuns.filter((run) => run.winner === winner).length;
  const disagreementIndex = computeConsensusDisagreementIndex(judgeRuns, agentIds);
  const panelAgreement = Number((winnerVotes / Math.max(1, judgeRuns.length)).toFixed(4));

  return {
    winner,
    scores: penalizedScores,
    summary: `${winner} won consensus judging (${winnerVotes}/${judgeRuns.length} panel votes) with median metric aggregation.`,
    judgedAt: new Date().toISOString(),
    judgePromptVersion,
    criteriaWeights,
    mode: 'consensus',
    disagreementIndex,
    panelAgreement,
    runs: judgeRuns.map((run) => ({
      panelId: run.panelId,
      winner: run.winner,
      summary: run.summary,
      scores: run.scores,
    })),
  };
}

async function computeCategoryBaseline(
  prisma: PrismaClient,
  taskCategory: TaskCategory,
  excludeTaskId: string
): Promise<number> {
  const previous = await prisma.judgeResult.findMany({
    where: {
      taskId: { not: excludeTaskId },
      task: {
        category: taskCategory,
      },
    },
    select: {
      winnerAgentId: true,
      scores: true,
    },
    take: 200,
  });

  const winnerTotals: number[] = [];
  for (const row of previous) {
    const parsedScores = safeParseJson<JudgeScore[]>(row.scores, []);
    const winnerScore = parsedScores.find((score) => score.agentId === row.winnerAgentId);
    if (winnerScore && Number.isFinite(winnerScore.total)) {
      winnerTotals.push(winnerScore.total);
    }
  }

  if (winnerTotals.length === 0) return 20;
  const average = winnerTotals.reduce((sum, score) => sum + score, 0) / winnerTotals.length;
  return Number(average.toFixed(2));
}

export async function orchestrateTask(
  taskId: string,
  prompt: string,
  onUpdate?: (update: any) => void,
  agentCount: number = 3,
  activeSkillNames?: string[],
  apiKey?: string,
  provider?: string,
  model?: string,
  judgeMode?: string,
  criteriaWeights?: Partial<JudgeWeights>,
  taskCategory?: TaskCategory,
  judgePromptVersion?: string,
  replayConfig?: ReplayConfig
): Promise<OrchestrationResult> {
  const prisma = getPrismaClient();
  const agents = Array.from({ length: agentCount }, (_, i) => `agent-${i + 1}`);
  const startTime = Date.now();
  const domainPlan = resolveDomainPlan({
    taskPrompt: prompt,
    taskCategory,
    activeSkillNames,
    judgeMode,
    criteriaWeights,
  });
  const resolvedTaskCategory = domainPlan.taskCategory;
  const selectedJudgeMode = domainPlan.judgeMode;
  const normalizedWeights = domainPlan.criteriaWeights;
  const resolvedSkillNames = domainPlan.activeSkillNames;
  const selectedProvider = normalizeProvider(provider);
  const selectedModel = model?.trim() || defaultModelForProvider(selectedProvider);
  const resolvedApiKey = resolveProviderApiKey(selectedProvider, apiKey);
  const selectedPromptVersion = judgePromptVersion?.trim() || DEFAULT_JUDGE_PROMPT_VERSION;
  let runResults: AgentRunResult[] = [];

  logger.info(
    `Starting orchestration for task ${taskId} with ${agents.length} agents using ${selectedProvider}/${selectedModel} ` +
    `(domain: ${domainPlan.profile.id}, judge: ${selectedJudgeMode})`
  );

  try {
    if (!resolvedApiKey) {
      throw new Error(
        `Provider ${selectedProvider} is not configured on backend (missing API key).`
      );
    }

    const skillRegistry = await SkillRegistry.create(resolvedSkillNames);

    onUpdate?.({
      type: 'orchestration_started',
      taskId,
      provider: selectedProvider,
      model: selectedModel,
      category: resolvedTaskCategory,
      domain: {
        id: domainPlan.profile.id,
        label: domainPlan.profile.label,
        objectiveMode: domainPlan.profile.objectiveMode,
        defaultSkills: domainPlan.profile.defaultSkills,
      },
      judge: {
        mode: selectedJudgeMode,
        promptVersion: selectedPromptVersion,
        weights: normalizedWeights,
        confidenceGate: {
          enabled: config.CONFIDENCE_GATE_ENABLED,
          minTotal: config.CONFIDENCE_GATE_MIN_TOTAL,
          minMargin: config.CONFIDENCE_GATE_MIN_MARGIN,
          minAccuracy: config.CONFIDENCE_GATE_MIN_ACCURACY,
        },
      },
      requestedSkills: resolvedSkillNames || [],
      agents: agents.map((id) => {
        const persona = AGENT_PERSONAS[id] ?? AGENT_PERSONAS['agent-1'];
        return {
          id,
          name: persona.name,
          description: persona.description,
        };
      }),
      skills: skillRegistry.list().map((skill) => ({
        name: skill.name,
        description: skill.description,
        trigger: skill.trigger,
      })),
      replay: replayConfig
        ? {
          sourceTaskId: replayConfig.sourceTaskId,
          sourceStrategyId: replayConfig.sourceStrategyId,
          sourceAgentId: replayConfig.sourceAgentId,
          sourcePersona: replayConfig.sourcePersona,
          toolSequence: replayConfig.toolSequence,
        }
        : null,
    });

    await prisma.task.update({
      where: { id: taskId },
      data: { status: 'running' },
    });

    const learnedStrategies = await prisma.agentLearning.findMany({
      where: {
        agentId: { in: agents },
        successRate: { gte: 0.7 },
        taskCategory: resolvedTaskCategory,
      },
      orderBy: [
        { avgLift: 'desc' },
        { successRate: 'desc' },
      ],
      take: 5,
    });

    const enrichedPrompt = buildEnrichedPrompt(
      prompt,
      [...domainPlan.promptHints, ...learnedStrategies.map((strategy) => strategy.learnedPattern)]
    );

    const results = await Promise.all(
      agents.map(async (agentId): Promise<AgentRunResult> => {
        try {
          const result = await runAgent(
            agentId,
            enrichedPrompt,
            (step) => {
              onUpdate?.({
                type: 'reasoning_step',
                agentId,
                step,
              });
            },
            {
              skillRegistry,
              apiKey: resolvedApiKey,
              provider: selectedProvider,
              model: selectedModel,
              replayMode: replayConfig?.sourceAgentId === agentId,
              replayContext:
                replayConfig?.sourceAgentId === agentId
                  ? replayConfig
                  : undefined,
            }
          );

          if (result.success) {
            logger.info(
              `Agent ${agentId} (${result.persona}) completed (${result.tokensUsed} tokens, ${result.reasoning.length} reasoning steps)`
            );
          } else {
            logger.warn(`Agent ${agentId} failed: ${result.error}`);
          }

          onUpdate?.({
            type: 'agent_complete',
            agentId,
            persona: result.persona,
            tokensUsed: result.tokensUsed,
            timeMs: result.timeMs,
            success: result.success,
            error: result.error,
            response: result.response,
            skillUsage: result.skillUsage,
            telemetry: result.telemetry,
          });

          return result;
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          logger.error(`Agent ${agentId} exception:`, message);
          const telemetry: AgentTelemetry = {
            toolCallCount: 0,
            successfulToolCalls: 0,
            verificationSteps: 0,
            usedSearchFirst: false,
            toolSequence: [],
          };

          return {
            agentId,
            response: '',
            reasoning: [],
            tokensUsed: 0,
            timeMs: Date.now() - startTime,
            success: false,
            error: message,
            persona: (AGENT_PERSONAS[agentId] ?? AGENT_PERSONAS['agent-1']).name,
            skillUsage: [],
            telemetry,
          };
        }
      })
    );
    runResults = results;

    onUpdate?.({ type: 'judging_started' });

    const successfulResults = results.filter((result) => result.success && result.response.trim().length > 0);
    let judgeResult: JudgeResult;
    if (selectedJudgeMode === 'consensus' && successfulResults.length > 1) {
      const judgeRuns = await Promise.all(
        Array.from({ length: CONSENSUS_PANEL_COUNT }, (_, index) =>
          judgeResponses(prompt, results, {
            apiKey: resolvedApiKey,
            provider: selectedProvider,
            model: selectedModel,
            criteriaWeights: normalizedWeights,
            judgePromptVersion: selectedPromptVersion,
            taskCategory: resolvedTaskCategory,
            objectiveMode: domainPlan.profile.objectiveMode,
            panelId: index + 1,
          })
        )
      );

      judgeResult = aggregateConsensusJudgeRuns(
        judgeRuns,
        successfulResults,
        normalizedWeights,
        selectedPromptVersion
      );
    } else {
      judgeResult = await judgeResponses(prompt, results, {
        apiKey: resolvedApiKey,
        provider: selectedProvider,
        model: selectedModel,
        criteriaWeights: normalizedWeights,
        judgePromptVersion: selectedPromptVersion,
        taskCategory: resolvedTaskCategory,
        objectiveMode: domainPlan.profile.objectiveMode,
      });
    }

    const confidenceGate = evaluateConfidenceGate(judgeResult);
    const winnerResult = results.find((result) => result.agentId === judgeResult.winner);
    if (!winnerResult) {
      throw new Error(`Judge winner ${judgeResult.winner} not found in agent results`);
    }

    const winnerScore = judgeResult.scores.find((score) => score.agentId === winnerResult.agentId);
    const evidenceCoverage = computeEvidenceCoverage(winnerScore);
    const disagreementIndex = Number((judgeResult.disagreementIndex ?? 0).toFixed(4));
    const trust = deriveConfidenceLevel(
      confidenceGate,
      evidenceCoverage,
      disagreementIndex
    );
    const trustSignals: TrustSignals = {
      confidenceLevel: trust.level,
      confidenceReason: trust.reason,
      confidencePassed: confidenceGate.passed,
      winnerMargin: confidenceGate.marginToSecond,
      winnerTotal: confidenceGate.winnerTotal,
      winnerAccuracy: confidenceGate.winnerAccuracy,
      evidenceCoverage,
      disagreementIndex,
      panelAgreement: judgeResult.panelAgreement,
    };

    if (!confidenceGate.passed) {
      logger.warn(
        `Confidence gate failed for task ${taskId}: ${confidenceGate.reason}`
      );
      judgeResult = {
        ...judgeResult,
        summary: `[Low confidence] ${judgeResult.summary} (${confidenceGate.reason})`,
      };
    }

    judgeResult = {
      ...judgeResult,
      ...trustSignals,
    };

    const normalizedWinnerScore = (winnerScore?.total ?? 20) / 40;
    const baselineScore = await computeCategoryBaseline(prisma, resolvedTaskCategory, taskId);
    const winnerLift = Number(((winnerScore?.total ?? 20) - baselineScore).toFixed(2));

    const skillUsageRows = results.flatMap((result) =>
      result.skillUsage.map((usage) => ({
        taskId,
        agentId: result.agentId,
        skillName: usage.name,
        input: usage.input !== undefined ? JSON.stringify(usage.input) : undefined,
        summary: usage.summary,
        success: usage.success,
        durationMs: usage.durationMs,
        turnIndex: usage.turnIndex,
        callIndex: usage.callIndex,
        timestamp: toValidDate(usage.timestamp),
      }))
    );

    const writes: Array<Promise<unknown>> = [
      prisma.task.update({
        where: { id: taskId },
        data: {
          status: 'completed',
          completedAt: new Date(),
          category: resolvedTaskCategory,
        },
      }),
      ...results.map((result) =>
        prisma.taskResult.create({
          data: {
            taskId,
            agentId: result.agentId,
            response: result.response,
            tokensUsed: result.tokensUsed,
            timeMs: result.timeMs,
            success: result.success,
            reasoning: JSON.stringify(result.reasoning.map((item) => item.thought)),
            telemetry: JSON.stringify(result.telemetry),
          },
        })
      ),
      prisma.strategy.create({
        data: {
          taskId,
          agentId: winnerResult.agentId,
          approach: `${winnerResult.persona}: ${judgeResult.summary}`,
          timesUsed: 1,
          successRate: normalizedWinnerScore,
          context: JSON.stringify([
            `domain:${domainPlan.profile.id}`,
            `task_category:${resolvedTaskCategory}`,
            `judge_mode:${judgeResult.mode || selectedJudgeMode}`,
            `judge_winner:${judgeResult.winner}`,
            `judge_total:${winnerScore?.total ?? 0}`,
            `confidence_gate:${confidenceGate.passed ? 'pass' : 'fail'}`,
            `confidence_level:${judgeResult.confidenceLevel || 'medium'}`,
            `confidence_reason:${confidenceGate.reason}`,
            `evidence_coverage:${judgeResult.evidenceCoverage ?? 0}`,
            `disagreement_index:${judgeResult.disagreementIndex ?? 0}`,
            `winner_margin:${confidenceGate.marginToSecond}`,
            `baseline:${baselineScore}`,
            `lift:${winnerLift}`,
            ...(replayConfig
              ? [
                `replay_source_task:${replayConfig.sourceTaskId}`,
                `replay_source_strategy:${replayConfig.sourceStrategyId || 'none'}`,
                `replay_source_agent:${replayConfig.sourceAgentId}`,
              ]
              : []),
          ]),
        },
      }),
      prisma.judgeResult.upsert({
        where: { taskId },
        update: {
          winnerAgentId: judgeResult.winner,
          summary: judgeResult.summary,
          judgedAt: new Date(judgeResult.judgedAt),
          judgeMode: judgeResult.mode || selectedJudgeMode,
          judgePromptVersion: judgeResult.judgePromptVersion || selectedPromptVersion,
          criteriaWeights: JSON.stringify(judgeResult.criteriaWeights || normalizedWeights),
          judgeRuns: judgeResult.runs ? JSON.stringify(judgeResult.runs) : undefined,
          confidencePassed: judgeResult.confidencePassed ?? confidenceGate.passed,
          confidenceLevel: judgeResult.confidenceLevel || 'medium',
          confidenceReason: judgeResult.confidenceReason || confidenceGate.reason,
          winnerMargin: judgeResult.winnerMargin ?? confidenceGate.marginToSecond,
          disagreementIndex: judgeResult.disagreementIndex ?? 0,
          panelAgreement: judgeResult.panelAgreement,
          evidenceCoverage: judgeResult.evidenceCoverage ?? 0,
          scores: JSON.stringify(judgeResult.scores),
        },
        create: {
          taskId,
          winnerAgentId: judgeResult.winner,
          summary: judgeResult.summary,
          judgedAt: new Date(judgeResult.judgedAt),
          judgeMode: judgeResult.mode || selectedJudgeMode,
          judgePromptVersion: judgeResult.judgePromptVersion || selectedPromptVersion,
          criteriaWeights: JSON.stringify(judgeResult.criteriaWeights || normalizedWeights),
          judgeRuns: judgeResult.runs ? JSON.stringify(judgeResult.runs) : undefined,
          confidencePassed: judgeResult.confidencePassed ?? confidenceGate.passed,
          confidenceLevel: judgeResult.confidenceLevel || 'medium',
          confidenceReason: judgeResult.confidenceReason || confidenceGate.reason,
          winnerMargin: judgeResult.winnerMargin ?? confidenceGate.marginToSecond,
          disagreementIndex: judgeResult.disagreementIndex ?? 0,
          panelAgreement: judgeResult.panelAgreement,
          evidenceCoverage: judgeResult.evidenceCoverage ?? 0,
          scores: JSON.stringify(judgeResult.scores),
        },
      }),
    ];

    if (skillUsageRows.length > 0) {
      writes.push(
        prisma.skillUsage.createMany({
          data: skillUsageRows,
        })
      );
    }

    const learningObservations = buildLearningObservationRows(
      taskId,
      judgeResult,
      results,
      resolvedTaskCategory,
      selectedJudgeMode,
      selectedPromptVersion
    );
    if (learningObservations.length > 0) {
      writes.push(
        prisma.learningObservation.createMany({
          data: learningObservations,
        })
      );
    }

    await Promise.all(writes);

    if (config.ENABLE_LEARNING && confidenceGate.passed) {
      await extractAndSaveLearnings(
        winnerResult,
        judgeResult,
        results,
        prisma,
        resolvedTaskCategory,
        winnerLift
      );
    } else if (config.ENABLE_LEARNING && !confidenceGate.passed) {
      logger.info(
        `Skipping learning update for task ${taskId} because confidence gate failed: ${confidenceGate.reason}`
      );
    }

    const result: OrchestrationResult = {
      taskId,
      winner: {
        agentId: winnerResult.agentId,
        persona: winnerResult.persona,
        tokensUsed: winnerResult.tokensUsed,
        timeMs: winnerResult.timeMs,
        judgeScore: winnerScore?.total,
      },
      judgeResult: {
        ...judgeResult,
        mode: judgeResult.mode || selectedJudgeMode,
        criteriaWeights: judgeResult.criteriaWeights || normalizedWeights,
        judgePromptVersion: judgeResult.judgePromptVersion || selectedPromptVersion,
      },
      confidenceGate,
      results,
      completedAt: new Date().toISOString(),
    };

    await setCache(`task:${taskId}:result`, {
      winner: result.winner,
      judgeResult: result.judgeResult,
      confidenceGate,
      completedAt: result.completedAt,
      category: resolvedTaskCategory,
    });

    onUpdate?.({
      type: 'orchestration_complete',
      ...result,
    });

    return result;
  } catch (error) {
    logger.error(`Orchestration failed for task ${taskId}:`, error);

    if (config.ENABLE_LEARNING && runResults.length > 0) {
      try {
        const failureRows = buildLearningObservationRows(
          taskId,
          null,
          runResults,
          resolvedTaskCategory,
          selectedJudgeMode,
          selectedPromptVersion,
          error instanceof Error ? error.message : String(error)
        );
        if (failureRows.length > 0) {
          await prisma.learningObservation.createMany({ data: failureRows });
        }
      } catch (observationError) {
        logger.warn('Failed to persist failure observations (non-critical):', observationError);
      }
    }

    await prisma.task.update({
      where: { id: taskId },
      data: { status: 'failed' },
    });

    throw error;
  }
}

async function extractAndSaveLearnings(
  winner: AgentRunResult,
  judgeResult: JudgeResult,
  allResults: AgentRunResult[],
  prisma: PrismaClient,
  taskCategory: TaskCategory,
  winnerLift: number
): Promise<void> {
  try {
    if (!winner.success || winner.reasoning.length === 0) return;

    const winnerScore = judgeResult.scores.find((score) => score.agentId === winner.agentId);
    if (!winnerScore || winnerScore.total < LEARNING_SCORE_THRESHOLD) return;

    const selectedThoughts = selectPatternThoughts(winner, 0.8);
    const toolPath = buildToolPath(winner);

    if (selectedThoughts.length === 0) return;

    const learnedPattern = `[${winner.persona}][${taskCategory}][tools:${toolPath}] ${selectedThoughts.join(' -> ')}`;
    const quality = winnerScore.total / 40;

    const otherAgents = allResults
      .filter((result) => result.agentId !== winner.agentId)
      .map((result) => result.agentId);

    for (const agentId of otherAgents) {
      const existingLearning = await prisma.agentLearning.findFirst({
        where: {
          agentId,
          sourceAgent: winner.agentId,
          taskCategory,
          learnedPattern: { contains: winner.persona },
        },
      });

      if (existingLearning) {
        const emaSuccessRate = existingLearning.successRate * 0.8 + quality * 0.2;
        const nextLiftSamples = existingLearning.liftSamples + 1;
        const nextAvgLift = Number(
          (
            (existingLearning.avgLift * existingLearning.liftSamples + winnerLift) /
            nextLiftSamples
          ).toFixed(4)
        );

        await prisma.agentLearning.update({
          where: { id: existingLearning.id },
          data: {
            learnedPattern,
            appliedCount: { increment: 1 },
            successCount: { increment: winnerLift > 0 ? 1 : 0 },
            successRate: emaSuccessRate,
            avgLift: nextAvgLift,
            liftSamples: { increment: 1 },
          },
        });
      } else {
        await prisma.agentLearning.create({
          data: {
            agentId,
            learnedPattern,
            sourceAgent: winner.agentId,
            taskCategory,
            appliedCount: 1,
            successCount: winnerLift > 0 ? 1 : 0,
            successRate: quality,
            avgLift: winnerLift,
            liftSamples: 1,
          },
        });
      }
    }

    logger.info(
      `Learning saved from ${winner.agentId} to ${otherAgents.length} agents (category=${taskCategory}, lift=${winnerLift})`
    );
  } catch (error) {
    logger.warn('Failed to save learnings (non-critical):', error);
  }
}

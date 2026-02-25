import { Router, Request, Response } from 'express';
import { getPrismaClient } from '../database';
import { orchestrateTask, ReplayConfig } from '../orchestrator';
import logger from '../logger';
import { isSupportedProvider, normalizeProvider } from '../llm/provider';
import { JudgeWeights, normalizeJudgeWeights } from '../judge';
import { categorizePrompt } from '../task-category';

const router = Router();
const prisma = getPrismaClient();

function parseJson<T>(value: unknown, fallback: T): T {
  if (value === null || value === undefined) return fallback;
  if (typeof value !== 'string') return value as T;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function toStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((item): item is string => typeof item === 'string')
    .map((item) => item.trim())
    .filter(Boolean);
}

function parseReplayConfig(value: unknown): ReplayConfig | undefined {
  if (!isObject(value)) return undefined;

  const sourceTaskId = typeof value.sourceTaskId === 'string'
    ? value.sourceTaskId.trim()
    : '';
  const sourceAgentId = typeof value.sourceAgentId === 'string'
    ? value.sourceAgentId.trim()
    : '';
  if (!sourceTaskId || !sourceAgentId) return undefined;

  const sourceStrategyId = typeof value.sourceStrategyId === 'string'
    ? value.sourceStrategyId.trim()
    : undefined;
  const sourcePersona = typeof value.sourcePersona === 'string'
    ? value.sourcePersona.trim()
    : undefined;
  const toolSequence = toStringArray(value.toolSequence);
  const reasoningPath = toStringArray(value.reasoningPath).slice(0, 10);

  return {
    sourceTaskId,
    sourceStrategyId,
    sourceAgentId,
    sourcePersona,
    toolSequence,
    reasoningPath,
  };
}

// POST /api/tasks - Create and run a task
router.post('/', async (req: Request, res: Response) => {
  try {
    const { prompt, skills, apiKey, provider, model, judgeMode, criteriaWeights, replay } = req.body;

    if (!prompt || typeof prompt !== 'string' || prompt.trim().length === 0) {
      return res.status(400).json({ error: 'Prompt is required and must be a non-empty string' });
    }

    if (skills !== undefined && (!Array.isArray(skills) || skills.some((skill) => typeof skill !== 'string'))) {
      return res.status(400).json({ error: 'Skills must be an array of strings' });
    }

    if (
      provider !== undefined &&
      (typeof provider !== 'string' || !isSupportedProvider(provider.toLowerCase()))
    ) {
      return res.status(400).json({ error: 'Provider must be one of: anthropic, gemini, openai' });
    }

    if (model !== undefined && typeof model !== 'string') {
      return res.status(400).json({ error: 'Model must be a string' });
    }

    if (
      judgeMode !== undefined &&
      (typeof judgeMode !== 'string' || !['single', 'consensus'].includes(judgeMode.toLowerCase()))
    ) {
      return res.status(400).json({ error: 'judgeMode must be one of: single, consensus' });
    }

    if (criteriaWeights !== undefined && !isObject(criteriaWeights)) {
      return res.status(400).json({ error: 'criteriaWeights must be an object with metric weights' });
    }

    if (replay !== undefined && !isObject(replay)) {
      return res.status(400).json({ error: 'replay must be an object' });
    }

    const activeSkills = Array.isArray(skills)
      ? Array.from(new Set(skills.map((skill) => skill.trim()).filter(Boolean)))
      : undefined;
    const selectedProvider = normalizeProvider(
      typeof provider === 'string' ? provider.toLowerCase() : undefined
    );
    const selectedModel = typeof model === 'string' ? model.trim() : undefined;
    const selectedJudgeMode = typeof judgeMode === 'string' ? judgeMode.toLowerCase() : undefined;
    const selectedCriteriaWeights = isObject(criteriaWeights)
      ? normalizeJudgeWeights(criteriaWeights as Partial<JudgeWeights>)
      : undefined;
    const replayConfig = parseReplayConfig(replay);
    if (replay !== undefined && !replayConfig) {
      return res.status(400).json({
        error: 'replay requires sourceTaskId and sourceAgentId, and optional sourceStrategyId/sourcePersona/toolSequence/reasoningPath',
      });
    }
    const taskCategory = categorizePrompt(prompt.trim());

    // Create task
    const task = await prisma.task.create({
      data: {
        prompt: prompt.trim(),
        status: 'pending',
        category: taskCategory,
      },
    });

    logger.info(`📝 Task created: ${task.id}`);

    // Return immediately
    res.status(202).json({
      taskId: task.id,
      status: 'pending',
      message: 'Task queued for processing',
    });

    // Process asynchronously
    orchestrateTask(task.id, prompt, (update) => {
      // Broadcast via WebSocket (implemented in main server)
      req.app.get('io')?.to(`task:${task.id}`).emit('task_update', update);
    },
    undefined,
    activeSkills,
    apiKey,
    selectedProvider,
    selectedModel,
    selectedJudgeMode,
    selectedCriteriaWeights,
    taskCategory,
    undefined,
    replayConfig).catch((error) => {
      logger.error(`Task ${task.id} processing failed:`, error);
    });
  } catch (error) {
    logger.error('Task creation error:', error);
    res.status(500).json({ error: 'Failed to create task' });
  }
});

// GET /api/tasks/:id - Get task with results
router.get('/:id', async (req: Request, res: Response) => {
  try {
    const task = await prisma.task.findUnique({
      where: { id: req.params.id },
      include: {
        results: {
          select: {
            id: true,
            agentId: true,
            response: true,
            tokensUsed: true,
            timeMs: true,
            success: true,
            reasoning: true,
            telemetry: true,
            createdAt: true,
          },
        },
        strategies: true,
        judgeResult: true,
        skillUsages: {
          select: {
            id: true,
            agentId: true,
            skillName: true,
            input: true,
            summary: true,
            success: true,
            durationMs: true,
            turnIndex: true,
            callIndex: true,
            timestamp: true,
            createdAt: true,
          },
          orderBy: {
            createdAt: 'asc',
          },
        },
        learningObservations: {
          select: {
            id: true,
            agentId: true,
            persona: true,
            outcomeType: true,
            taskCategory: true,
            scoreTotal: true,
            scoreBaseTotal: true,
            scoreAccuracy: true,
            scoreCompleteness: true,
            scoreClarity: true,
            scoreInsight: true,
            judgeMode: true,
            judgePromptVersion: true,
            toolPath: true,
            skillCount: true,
            verificationSteps: true,
            usedSearchFirst: true,
            pattern: true,
            payload: true,
            createdAt: true,
          },
          orderBy: {
            createdAt: 'asc',
          },
        },
      },
    });

    if (!task) {
      return res.status(404).json({ error: 'Task not found' });
    }

    const normalizedTask = {
      ...task,
      results: task.results.map((result) => ({
        ...result,
        reasoning: parseJson<string[]>(result.reasoning, []),
        telemetry: parseJson<Record<string, unknown> | null>(result.telemetry, null),
      })),
      strategies: task.strategies.map((strategy) => ({
        ...strategy,
        context: parseJson<string[]>(strategy.context, []),
      })),
      judgeResult: task.judgeResult
        ? {
          ...task.judgeResult,
          scores: parseJson<Record<string, unknown>[]>(task.judgeResult.scores, []),
          criteriaWeights: parseJson<Record<string, number>>(task.judgeResult.criteriaWeights, {}),
          judgeRuns: parseJson<Record<string, unknown>[]>(task.judgeResult.judgeRuns, []),
        }
        : null,
      skillUsages: task.skillUsages.map((usage) => ({
        ...usage,
        input: parseJson<Record<string, unknown> | null>(usage.input, null),
      })),
      learningObservations: task.learningObservations.map((observation) => ({
        ...observation,
        payload: parseJson<Record<string, unknown> | string | null>(observation.payload, null),
      })),
    };

    res.json(normalizedTask);
  } catch (error) {
    logger.error('Task fetch error:', error);
    res.status(500).json({ error: 'Failed to fetch task' });
  }
});

// GET /api/tasks - List tasks
router.get('/', async (req: Request, res: Response) => {
  try {
    const { status, limit = 20 } = req.query;

    const where: any = {};
    if (status && typeof status === 'string') {
      where.status = status;
    }

    const tasks = await prisma.task.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      take: parseInt(limit as string) || 20,
      include: {
        _count: {
          select: { results: true },
        },
      },
    });

    res.json(tasks);
  } catch (error) {
    logger.error('Tasks list error:', error);
    res.status(500).json({ error: 'Failed to fetch tasks' });
  }
});

export default router;

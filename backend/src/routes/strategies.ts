import { Router, Request, Response } from 'express';
import { getPrismaClient } from '../database';
import logger from '../logger';

const router = Router();
const prisma = getPrismaClient();

// GET /api/strategies/observations - raw win/loss pattern observations
router.get('/observations', async (req: Request, res: Response) => {
  try {
    const requestedLimit = Number(req.query.limit ?? 100);
    const limit = Number.isFinite(requestedLimit)
      ? Math.max(10, Math.min(1000, Math.floor(requestedLimit)))
      : 100;

    const outcomeType = typeof req.query.outcomeType === 'string'
      ? req.query.outcomeType.trim().toLowerCase()
      : undefined;
    const taskCategory = typeof req.query.category === 'string'
      ? req.query.category.trim().toLowerCase()
      : undefined;
    const agentId = typeof req.query.agentId === 'string'
      ? req.query.agentId.trim()
      : undefined;

    const rows = await prisma.learningObservation.findMany({
      where: {
        ...(outcomeType ? { outcomeType } : {}),
        ...(taskCategory ? { taskCategory } : {}),
        ...(agentId ? { agentId } : {}),
      },
      orderBy: [
        { createdAt: 'desc' },
      ],
      take: limit,
      select: {
        id: true,
        taskId: true,
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
    });

    const observations = rows.map((row) => ({
      ...row,
      payload: (() => {
        if (!row.payload) return null;
        try {
          return JSON.parse(row.payload);
        } catch {
          return row.payload;
        }
      })(),
    }));

    res.json({
      count: observations.length,
      observations,
    });
  } catch (error) {
    logger.error('Learning observations fetch error:', error);
    res.status(500).json({ error: 'Failed to fetch learning observations' });
  }
});

// GET /api/strategies/patterns - top transferable patterns by measured lift
router.get('/patterns', async (req: Request, res: Response) => {
  try {
    const requestedLimit = Number(req.query.limit ?? 12);
    const limit = Number.isFinite(requestedLimit)
      ? Math.max(3, Math.min(50, Math.floor(requestedLimit)))
      : 12;
    const category = typeof req.query.category === 'string'
      ? req.query.category.trim().toLowerCase()
      : undefined;

    const rows = await prisma.agentLearning.findMany({
      where: {
        liftSamples: { gte: 1 },
        ...(category ? { taskCategory: category } : {}),
      },
      orderBy: [
        { avgLift: 'desc' },
        { successRate: 'desc' },
        { appliedCount: 'desc' },
      ],
      take: limit,
    });

    const patterns = rows.map((row) => ({
      id: row.id,
      targetAgentId: row.agentId,
      sourceAgentId: row.sourceAgent,
      taskCategory: row.taskCategory,
      learnedPattern: row.learnedPattern,
      avgLift: Number(row.avgLift.toFixed(3)),
      liftSamples: row.liftSamples,
      successRate: Number((row.successRate * 100).toFixed(2)),
      transferConfidence: Number(
        Math.min(100, (row.successRate * 100) * Math.log10(row.liftSamples + 1)).toFixed(2)
      ),
      appliedCount: row.appliedCount,
      updatedAt: row.updatedAt,
    }));

    res.json({
      count: patterns.length,
      patterns,
    });
  } catch (error) {
    logger.error('Pattern strategy fetch error:', error);
    res.status(500).json({ error: 'Failed to fetch transferable patterns' });
  }
});

// GET /api/strategies - List all strategies
router.get('/', async (req: Request, res: Response) => {
  try {
    const strategies = await prisma.strategy.findMany({
      orderBy: { successRate: 'desc' },
      take: 50,
    });

    res.json(strategies);
  } catch (error) {
    logger.error('Strategies fetch error:', error);
    res.status(500).json({ error: 'Failed to fetch strategies' });
  }
});

// GET /api/strategies/agent/:id - Get strategies by agent
router.get('/agent/:id', async (req: Request, res: Response) => {
  try {
    const learning = await prisma.agentLearning.findMany({
      where: { agentId: req.params.id },
      orderBy: { successRate: 'desc' },
    });

    res.json(learning);
  } catch (error) {
    logger.error('Agent learning fetch error:', error);
    res.status(500).json({ error: 'Failed to fetch learning' });
  }
});

export default router;

import { Router, Request, Response } from 'express';
import { getPrismaClient } from '../database';
import logger from '../logger';

const router = Router();
const prisma = getPrismaClient();

// GET /api/agents - List agents with stats
router.get('/', async (req: Request, res: Response) => {
  try {
    const agents = await prisma.taskResult.groupBy({
      by: ['agentId'],
      _count: true,
      _avg: {
        tokensUsed: true,
        timeMs: true,
      },
    });

    const agentStats = agents.map((agent) => ({
      id: agent.agentId,
      tasksCompleted: agent._count,
      avgTokens: Math.round(agent._avg.tokensUsed || 0),
      avgTime: Math.round(agent._avg.timeMs || 0),
    }));

    res.json(agentStats);
  } catch (error) {
    logger.error('Agents fetch error:', error);
    res.status(500).json({ error: 'Failed to fetch agents' });
  }
});

// GET /api/agents/:id - Get agent details
router.get('/:id', async (req: Request, res: Response) => {
  try {
    const { id } = req.params;

    const results = await prisma.taskResult.findMany({
      where: { agentId: id },
      orderBy: { createdAt: 'desc' },
      take: 50,
    });

    const learning = await prisma.agentLearning.findMany({
      where: { agentId: id },
      orderBy: { successRate: 'desc' },
    });

    const stats = {
      agentId: id,
      tasksCompleted: results.length,
      successRate: results.length > 0 ? (results.filter((r) => r.success).length / results.length) * 100 : 0,
      avgTokens: results.length > 0 ? Math.round(results.reduce((sum, r) => sum + r.tokensUsed, 0) / results.length) : 0,
      avgTime: results.length > 0 ? Math.round(results.reduce((sum, r) => sum + r.timeMs, 0) / results.length) : 0,
      learnings: learning.length,
    };

    res.json(stats);
  } catch (error) {
    logger.error('Agent detail fetch error:', error);
    res.status(500).json({ error: 'Failed to fetch agent details' });
  }
});

export default router;

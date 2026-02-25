import { Router, Request, Response } from 'express';
import fs from 'fs/promises';
import path from 'path';
import { getPrismaClient } from '../database';
import { resolveSkillRoots, SkillRegistry } from '../skills/registry';
import logger from '../logger';

const router = Router();
const prisma = getPrismaClient();
const SKILL_NAME_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/;

function isValidSkillName(name: string): boolean {
  return SKILL_NAME_PATTERN.test(name);
}

async function directoryExists(targetPath: string): Promise<boolean> {
  try {
    const stats = await fs.stat(targetPath);
    return stats.isDirectory();
  } catch {
    return false;
  }
}

// GET /api/skills - list available skill manifests
router.get('/', async (req: Request, res: Response) => {
  try {
    const includeIneligible = String(req.query.includeIneligible || '').toLowerCase() === 'true';
    const registry = await SkillRegistry.create({ includeIneligible });
    const skills = registry.list();
    const roots = await resolveSkillRoots();

    res.json({
      count: skills.length,
      skills,
      roots,
    });
  } catch (error) {
    logger.error('Skills fetch error:', error);
    res.status(500).json({ error: 'Failed to fetch skills' });
  }
});

// GET /api/skills/usage - aggregated usage by agent and skill
router.get('/usage', async (req: Request, res: Response) => {
  try {
    const agentId = typeof req.query.agentId === 'string' ? req.query.agentId : undefined;
    const skillName = typeof req.query.skillName === 'string' ? req.query.skillName : undefined;
    const requestedLimit = Number(req.query.limit ?? 5000);
    const limit = Number.isFinite(requestedLimit)
      ? Math.max(100, Math.min(20_000, Math.floor(requestedLimit)))
      : 5000;

    const where: { agentId?: string; skillName?: string } = {};
    if (agentId) where.agentId = agentId;
    if (skillName) where.skillName = skillName;

    const rows = await prisma.skillUsage.findMany({
      where,
      select: {
        taskId: true,
        agentId: true,
        skillName: true,
        success: true,
        durationMs: true,
        turnIndex: true,
        callIndex: true,
      },
      orderBy: { createdAt: 'desc' },
      take: limit,
    });

    if (rows.length === 0) {
      return res.json({ count: 0, usage: [] });
    }

    const taskIds = Array.from(new Set(rows.map((row) => row.taskId)));
    const verdicts = await prisma.judgeResult.findMany({
      where: { taskId: { in: taskIds } },
      select: {
        taskId: true,
        winnerAgentId: true,
      },
    });

    const winnerByTask = new Map(verdicts.map((verdict) => [verdict.taskId, verdict.winnerAgentId]));
    const aggregate = new Map<
      string,
      {
        agentId: string;
        skillName: string;
        calls: number;
        successfulCalls: number;
        totalDurationMs: number;
        winningCalls: number;
        firstCallUses: number;
        totalTurnIndex: number;
        totalCallIndex: number;
      }
    >();

    for (const row of rows) {
      const key = `${row.agentId}::${row.skillName}`;
      const existing = aggregate.get(key) ?? {
        agentId: row.agentId,
        skillName: row.skillName,
        calls: 0,
        successfulCalls: 0,
        totalDurationMs: 0,
        winningCalls: 0,
        firstCallUses: 0,
        totalTurnIndex: 0,
        totalCallIndex: 0,
      };

      existing.calls += 1;
      if (row.success) existing.successfulCalls += 1;
      existing.totalDurationMs += row.durationMs;
      if (winnerByTask.get(row.taskId) === row.agentId) existing.winningCalls += 1;
      if (row.callIndex === 1) existing.firstCallUses += 1;
      existing.totalTurnIndex += row.turnIndex;
      existing.totalCallIndex += row.callIndex;

      aggregate.set(key, existing);
    }

    const usage = Array.from(aggregate.values())
      .map((entry) => ({
        agentId: entry.agentId,
        skillName: entry.skillName,
        calls: entry.calls,
        successRate: Number(((entry.successfulCalls / entry.calls) * 100).toFixed(2)),
        avgDurationMs: Math.round(entry.totalDurationMs / entry.calls),
        winRateWhenUsed: Number(((entry.winningCalls / entry.calls) * 100).toFixed(2)),
        firstCallRate: Number(((entry.firstCallUses / entry.calls) * 100).toFixed(2)),
        avgTurnIndex: Number((entry.totalTurnIndex / entry.calls).toFixed(2)),
        avgCallIndex: Number((entry.totalCallIndex / entry.calls).toFixed(2)),
      }))
      .sort((a, b) => b.calls - a.calls);

    res.json({
      count: usage.length,
      sampledCalls: rows.length,
      usage,
    });
  } catch (error) {
    logger.error('Skill usage fetch error:', error);
    res.status(500).json({ error: 'Failed to fetch skill usage analytics' });
  }
});

// POST /api/skills/install - install a bundled skill into managed overrides
router.post('/install', async (req: Request, res: Response) => {
  try {
    const skillName = String(req.body?.name || '').trim();
    const force = req.body?.force === true;

    if (!isValidSkillName(skillName)) {
      return res.status(400).json({ error: 'name must match [a-z0-9-] and be <=64 chars' });
    }

    const roots = await resolveSkillRoots();
    if (!roots.bundled) {
      return res.status(400).json({ error: 'No bundled skills root available' });
    }

    const sourceDir = path.join(roots.bundled, skillName);
    const sourceSkillFile = path.join(sourceDir, 'SKILL.md');
    const targetDir = path.join(roots.managed, skillName);

    if (!(await directoryExists(sourceDir))) {
      return res.status(404).json({ error: `Bundled skill "${skillName}" not found` });
    }

    try {
      await fs.access(sourceSkillFile);
    } catch {
      return res.status(404).json({ error: `Bundled skill "${skillName}" is missing SKILL.md` });
    }

    const targetExists = await directoryExists(targetDir);
    if (targetExists && !force) {
      return res.status(409).json({
        error: `Managed skill "${skillName}" already exists`,
        hint: 'Retry with force=true to overwrite',
      });
    }

    await fs.mkdir(roots.managed, { recursive: true });
    if (targetExists) {
      await fs.rm(targetDir, { recursive: true, force: true });
    }
    await fs.cp(sourceDir, targetDir, { recursive: true });

    res.json({
      installed: true,
      skill: skillName,
      source: sourceDir,
      target: targetDir,
      overwritten: targetExists,
    });
  } catch (error) {
    logger.error('Skill install error:', error);
    res.status(500).json({ error: 'Failed to install skill' });
  }
});

// POST /api/skills/update - update managed skills from bundled source
router.post('/update', async (req: Request, res: Response) => {
  try {
    const requestedName = String(req.body?.name || '').trim();
    const hasSingleName = requestedName.length > 0;

    if (hasSingleName && !isValidSkillName(requestedName)) {
      return res.status(400).json({ error: 'name must match [a-z0-9-] and be <=64 chars' });
    }

    const roots = await resolveSkillRoots();
    if (!roots.bundled) {
      return res.status(400).json({ error: 'No bundled skills root available' });
    }

    const managedExists = await directoryExists(roots.managed);
    if (!managedExists) {
      return res.json({ updated: 0, skills: [] });
    }

    const managedEntries = await fs.readdir(roots.managed, { withFileTypes: true });
    const candidates = managedEntries
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .filter((name) => isValidSkillName(name));

    const namesToUpdate = hasSingleName
      ? candidates.filter((name) => name === requestedName)
      : candidates;

    const updated: string[] = [];
    const skipped: Array<{ skill: string; reason: string }> = [];

    for (const name of namesToUpdate) {
      const sourceDir = path.join(roots.bundled, name);
      const sourceSkillFile = path.join(sourceDir, 'SKILL.md');
      const targetDir = path.join(roots.managed, name);

      if (!(await directoryExists(sourceDir))) {
        skipped.push({ skill: name, reason: 'missing bundled source' });
        continue;
      }

      try {
        await fs.access(sourceSkillFile);
      } catch {
        skipped.push({ skill: name, reason: 'bundled SKILL.md missing' });
        continue;
      }

      await fs.rm(targetDir, { recursive: true, force: true });
      await fs.cp(sourceDir, targetDir, { recursive: true });
      updated.push(name);
    }

    if (hasSingleName && namesToUpdate.length === 0) {
      return res.status(404).json({ error: `Managed skill "${requestedName}" not found` });
    }

    res.json({
      updated: updated.length,
      skills: updated,
      skipped,
    });
  } catch (error) {
    logger.error('Skill update error:', error);
    res.status(500).json({ error: 'Failed to update skill(s)' });
  }
});

export default router;

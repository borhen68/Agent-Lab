import { Router, Request, Response } from 'express';
import { config } from '../config';
import {
  defaultModelForProvider,
  providerStatuses,
} from '../llm/provider';
import {
  DEFAULT_CRITERIA_WEIGHTS,
  DEFAULT_JUDGE_PROMPT_VERSION,
} from '../judge';
import { resolveSkillRoots } from '../skills/registry';
import { listDomainProfiles } from '../domain-router';

const router = Router();

// GET /api/system/status - backend/provider readiness metadata
router.get('/status', async (_req: Request, res: Response) => {
  const statuses = providerStatuses();
  const defaultProvider = config.DEFAULT_LLM_PROVIDER;
  const skillRoots = await resolveSkillRoots();
  const domains = listDomainProfiles().map((domain) => ({
    id: domain.id,
    label: domain.label,
    description: domain.description,
    defaultSkills: domain.defaultSkills,
    defaultJudgeWeights: domain.defaultJudgeWeights,
    defaultJudgeMode: domain.defaultJudgeMode,
    objectiveMode: domain.objectiveMode,
  }));

  res.json({
    defaultProvider,
    providers: statuses,
    ready: statuses.some((status) => status.ready),
    defaults: {
      anthropicModel: defaultModelForProvider('anthropic'),
      geminiModel: defaultModelForProvider('gemini'),
      openaiModel: defaultModelForProvider('openai'),
      judgePromptVersion: DEFAULT_JUDGE_PROMPT_VERSION,
      judgeWeights: DEFAULT_CRITERIA_WEIGHTS,
    },
    domains,
    skillRoots,
  });
});

export default router;

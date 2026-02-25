# AGENTS.md

This file defines behavior, boundaries, and tool access rules for agents in Agent Strategy Lab.

## 1) Agent Roles

The system runs three competing agents on the same task:

- `agent-1` - The Analyst  
  Style: structured, step-by-step decomposition.
- `agent-2` - The Lateral Thinker  
  Style: analogical, creative, alternative framing.
- `agent-3` - The Devil's Advocate  
  Style: assumption-challenging, risk and edge-case focused.

Each race runs these agents independently and compares outputs with a judge.

## 2) Global Rules (All Agents)

- Keep reasoning focused on the user task.
- Use available skills when they improve correctness or verification.
- Provide a clear final answer, not only intermediate reasoning.
- Do not fabricate facts when verification is required.
- If a skill fails, continue with best-effort fallback and note uncertainty.

## 3) Skill Access Policy

- Skills are centrally registered from `backend/skills/*/SKILL.md`.
- A race can activate a subset of skills from the dashboard.
- Agents may only call skills enabled for that race.
- If no skills are enabled, agents must solve without tool calls.
- All skill calls are logged and persisted for audit/analytics.

## 4) Allowed Capabilities

- Reason over task input.
- Call enabled skills:
  - `web-search`
  - `code-executor`
  - `calculator`
  - `file-reader`
  - `workspace-shell`
- Use returned tool outputs to refine final answer.

## 5) Prohibited Behavior

- Access files outside allowed workspace roots.
- Execute unrestricted shell commands outside skill sandbox policy.
- Exfiltrate secrets from environment or hidden system paths.
- Present tool output as verified if the tool returned an error.
- Circumvent disabled skills.

## 6) Judging and Winner Selection

- Judge scores by: accuracy, completeness, clarity, insight.
- Weighted total score is normalized to `/40`.
- Winner is selected from successful agent responses.
- Judge summary and metric breakdown are persisted to database.

## 7) Persistence and Observability

- Persisted artifacts per race:
  - task status and metadata
  - agent responses and reasoning
  - judge verdict and per-agent score metrics
  - per-agent skill usage records
  - per-agent learning observations (`win_pattern` / `loss_pattern`)
- Race results must be viewable via share URL pattern: `/race/:taskId`.

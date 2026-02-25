# Agent Strategy Lab - Technical Implementation Log (Start -> Current)

This document captures the full technical implementation history for this workspace, from scaffold extraction out of `COMPLETE_AGENT_LAB.md` to the current state after Step 1 and Step 2 upgrades.

Date: 2026-02-25  
Workspace: `/Users/borheneddinesaidi/Documents/plan test`

---

## 1) Scope and Source of Truth

### Primary specification
- `COMPLETE_AGENT_LAB.md`

### Build objective
Create a full-stack multi-agent lab where multiple personas race on the same task, stream reasoning in real time, get judged, persist outcomes/learning, and expose progress transparently in UI.

### Current status (implemented)
- Project scaffold generated from markdown spec.
- Runtime hardening completed (config/build/redis/logger/frontend scaffold).
- Additive judge/persona/dashboard upgrades completed.
- Step 1 fixes completed:
  - WebSocket room scoping fixed.
  - Frontend room join flow fixed.
  - Judge results persisted in DB.
  - Component prop compatibility fixed.
- Step 2 completed:
  - Skill registry + skill folders + 4 handlers implemented.
  - Agent tool-calling loop integrated.
  - Skill usage emitted to UI and exposed in API.
- Additional gap-closure completed:
  - Root `AGENTS.md` added with boundaries and skill access policy.
  - Dashboard skill toggles implemented before race launch.
  - Shareable race result route implemented at `/race/:taskId`.
  - Per-agent skill usage persisted to DB and added analytics API.
  - Prisma migration files committed for reproducible setup.
  - Multi-provider LLM support added (`anthropic` + `gemini`) with per-race provider/model selection.
  - Front-page raw API key input removed; provider readiness is now exposed via backend status API.
- Trust/strategy/data layer upgrades completed:
  - Versioned judge config with customizable metric weights and persisted judge metadata.
  - Consensus judge mode (3-panel median aggregation) with per-panel run persistence.
  - Per-metric evidence snippets (quote + rationale + offsets) in judge output.
  - Deterministic diversity penalty based on cross-agent similarity.
  - Skill usage sequencing telemetry (`turnIndex`, `callIndex`) persisted and exposed.
  - Prompt category classification and category baseline/lift computation.
  - AgentLearning extended with `taskCategory`, `avgLift`, `liftSamples`.
  - Transferable pattern analytics endpoint and Strategies UI card.
- Domain-aware evaluation upgrades completed:
  - Added `finance` category classification.
  - Added domain profile routing for default skills, judge mode/weights, and prompt hints.
  - Added objective coding score blending (`coding-v1`) based on verification/test/lint telemetry.
  - `/api/system/status` now includes domain profile metadata for UI/domain-aware controls.
- Go-live gap closures completed:
  - Web-search reliability improved with provider chain `Tavily -> Serper -> DuckDuckGo`.
  - Confidence gate added in orchestration with configurable thresholds and low-confidence winner flagging.
  - OpenAI provider added alongside Anthropic + Gemini (runner, judge, provider status, UI selector).
- Open-source readiness scaffolding completed:
  - Root `README.md`, `LICENSE`, `CONTRIBUTING.md`, `SECURITY.md`, and `CODE_OF_CONDUCT.md`.
  - README upgraded with explicit problem statement, architecture diagram, measurable runtime numbers, and demo preview asset.
  - GitHub templates for bug/feature issues and pull requests.
  - GitHub CI workflow for backend/frontend build validation.

---

## 2) Chronological Build Timeline

## Phase A - Scaffold generation
- Parsed and generated files from `COMPLETE_AGENT_LAB.md` `#### File:` blocks.
- Wrote scaffold into:
  - `backend/`
  - `frontend/`
  - root files (`docker-compose.yml`, `.env.example`)

## Phase B - Baseline runtime hardening
1. Backend package/runtime alignment
- Removed ESM mismatch (`"type": "module"` conflict) to match TS CommonJS output.
- Added missing backend type deps (`@types/cors`, `@types/morgan`).

2. Redis v4 update
- Switched to `createClient` and `RedisClientType`.

3. Logger durability
- Ensured `logs/` directory exists before Winston file transports initialize.

4. Docker install behavior
- Replaced `npm ci` with `npm install` in Dockerfiles for this extracted scaffold context.

5. Frontend scaffold completion
- Added missing Vite/Tailwind base files (`index.html`, `vite.config.ts`, tsconfigs, tailwind/postcss configs, `vite-env.d.ts`).

6. Frontend env compatibility
- Switched browser env access from `process.env` to `import.meta.env`.

## Phase C - Additive feature integration (no full replacement)
Implemented as feature additions over existing codebase:
- Distinct personas per agent.
- Reasoning streaming and extraction upgrades.
- Judge scoring pipeline.
- Learning updates with quality threshold + EMA.
- Dashboard upgrades: tabs, winner panel, judging state, progress and score breakdown.

## Phase D - Step 1 fixes (critical correctness)
1. WebSocket room scoping fix
- File: `backend/src/routes/tasks.ts`
- Changed emission from global broadcast to room-scoped emit:
  - `req.app.get('io')?.to(\`task:${task.id}\`).emit('task_update', update);`

2. Frontend room join reliability
- File: `frontend/src/pages/Dashboard.tsx`
- Emits `watch_task` on:
  - socket connect/reconnect
  - task id assignment
  - immediate task creation response

3. Judge persistence
- File: `backend/prisma/schema.prisma`
  - Added `JudgeResult` model.
  - Added `Task.judgeResult JudgeResult?` relation.
- File: `backend/src/orchestrator.ts`
  - Added `prisma.judgeResult.upsert(...)`.
- File: `backend/src/routes/tasks.ts`
  - `GET /api/tasks/:id` now includes `judgeResult`.

4. Component compatibility
- File: `frontend/src/components/ReasoningView.tsx`
- Added support for optional props used by upgraded dashboard:
  - `persona`, `status`, `isWinner`, `judgeScore`.

## Phase E - Step 2 skill system
Implemented multi-agent shared skill architecture.

New skill structure:
```
backend/
  skills/
    web-search/
      SKILL.md
      handler.ts
    code-executor/
      SKILL.md
      handler.ts
    calculator/
      SKILL.md
      handler.ts
    file-reader/
      SKILL.md
      handler.ts
```

Core integration delivered:
- Skill metadata parser + registry.
- Anthropic tool definition generation from skills.
- Agent tool-call execution loop.
- Per-call usage tracking and UI surfacing.
- Task API accepts active skill list.
- Dedicated `GET /api/skills` endpoint.

## Phase F - Missing-feature closure
1. Governance documentation
- Added root file `AGENTS.md`.

2. Skill Registry UI
- Dashboard now fetches `/api/skills`.
- Users can select/clear skill checkboxes before run.
- Selected skills are sent in `POST /api/tasks` request body.
- Explicit empty skill selection runs agents with no tools.

3. Shareable race page
- Added frontend route `/race/:taskId`.
- Added page component `frontend/src/pages/RaceResult.tsx`.
- Added dashboard share link to open race page.

4. Skill usage persistence
- Added Prisma model `SkillUsage`.
- Orchestrator persists each tool call (`skillUsage`) for each agent/task.
- `GET /api/tasks/:id` now includes `skillUsages`.
- Added `GET /api/skills/usage` aggregated analytics endpoint.

5. Migrations
- Added `backend/prisma/migrations/migration_lock.toml`.
- Added `backend/prisma/migrations/20260225010000_init/migration.sql`.

## Phase G - Provider abstraction and UX cleanup
1. Backend provider layer
- Added `backend/src/llm/provider.ts`:
  - provider normalization/validation
  - default model resolution
  - API key resolution by provider
  - provider readiness metadata
- Added Gemini schema conversion helper for tool declarations.

2. Agent runner and judge provider support
- `backend/src/agent-runner.ts` now supports:
  - Anthropic path (existing)
  - Gemini path via Google Generative Language API
  - shared orchestration contracts for reasoning/tool calls
- `backend/src/judge.ts` now supports Anthropic and Gemini judges under one scoring schema.

3. API surface updates
- `POST /api/tasks` accepts `provider` and `model`.
- Added `GET /api/system/status` for provider readiness/default model metadata.
- `orchestration_started` socket event now includes selected provider/model.

4. Frontend UX updates
- Removed dashboard `API Key` input from primary race flow.
- Added provider + model selectors in race form.
- Added readiness messaging and launch gating when selected provider is not configured.

## Phase H - Trust + Strategy + ROI engine
1. Judge trust and transparency
- Added weighted judging config pipeline:
  - request input -> backend validation -> normalized weights -> persisted metadata.
- Added judge metadata persistence:
  - `judgeMode`, `judgePromptVersion`, `criteriaWeights`, `judgeRuns`.
- Added evidence-backed scoring:
  - each metric now stores quote + reason (+ optional char offsets).
- Added consensus mode:
  - parallel judge panels, median metric aggregation, panel run persistence.

2. Behavioral strategy enforcement and telemetry
- Added richer persona behavioral contracts in agent prompts.
- Added skill sequence telemetry:
  - `turnIndex`, `callIndex` captured per tool call.
- Added diversity penalty:
  - deterministic similarity analysis across agent outputs/reasoning.
  - score penalty applied when paths are overly similar.

3. Actionable learning and ROI
- Added prompt categorization (`coding`, `finance`, `math`, `research`, `analysis`, `creative`, `general`).
- Added category baseline computation from historical winner scores.
- Added winner lift metric (`winner score - category baseline`).
- Extended `AgentLearning` with lift analytics fields.
- Added `GET /api/strategies/patterns` for top transferable patterns.
- Strategies UI now surfaces pattern lift/confidence cards.

## Phase I - Domain router + objective coding judge
1. Domain routing layer
- Added `backend/src/domain-router.ts`.
- Added per-domain config for:
  - default skills
  - default judge mode
  - default judge weights
  - domain prompt hints
  - objective judge mode (`none` / `coding-v1`)
- Orchestrator now resolves domain plans before skill registry/judging setup.

2. Finance category support
- Expanded classifier in `backend/src/task-category.ts` to include `finance` with dedicated regex signals.

3. Objective coding scoring
- Extended `backend/src/judge.ts` options with `taskCategory` and `objectiveMode`.
- Added coding objective signal extraction from persisted tool telemetry:
  - executable verification runs (`workspace-shell`, `code-executor`)
  - test command detection (`npm|pnpm|yarn test`, `run test`, code-executor test-like snippets)
  - lint/typecheck detection
  - unsupported “tests pass” claims without evidence
- Added `objectiveAdjustment` payload on judge scores.
- Objective adjustments are applied before diversity penalty.

4. API exposure
- `GET /api/system/status` now includes domain profile metadata (`domains`) for frontend controls.
- `orchestration_started` socket updates now include resolved `domain` metadata.

---

## 3) Current Repository Map (Core)

```
.
├── COMPLETE_AGENT_LAB.md
├── AGENTS.md
├── TECHNICAL_IMPLEMENTATION_LOG.md
├── .env.example
├── docker-compose.yml
├── backend
│   ├── .env.example
│   ├── Dockerfile
│   ├── package.json
│   ├── tsconfig.json
│   ├── prisma
│   │   ├── schema.prisma
│   │   └── migrations
│   │       ├── migration_lock.toml
│   │       └── 20260225010000_init/migration.sql
│   ├── skills
│   │   ├── web-search/{SKILL.md,handler.ts}
│   │   ├── code-executor/{SKILL.md,handler.ts}
│   │   ├── calculator/{SKILL.md,handler.ts}
│   │   └── file-reader/{SKILL.md,handler.ts}
│   └── src
│       ├── index.ts
│       ├── config.ts
│       ├── logger.ts
│       ├── database.ts
│       ├── redis.ts
│       ├── middleware.ts
│       ├── agent-runner.ts
│       ├── judge.ts
│       ├── orchestrator.ts
│       ├── skills/{types.ts,registry.ts}
│       └── routes
│           ├── tasks.ts
│           ├── skills.ts
│           ├── agents.ts
│           └── strategies.ts
└── frontend
    ├── Dockerfile
    ├── index.html
    ├── nginx.conf
    ├── package.json
    └── src
        ├── pages/{Dashboard.tsx,RaceResult.tsx,Strategies.tsx}
        ├── components/{AgentCard.tsx,ReasoningView.tsx,Navbar.tsx}
        └── ...
```

---

## 4) Backend Technical Design

## 4.1 Bootstrap, middleware, and sockets
File: `backend/src/index.ts`

- Registers API routes:
  - `/api/tasks`
  - `/api/agents`
  - `/api/strategies`
  - `/api/skills`
  - `/api/system`
- Socket room support:
  - client sends `watch_task` with task id
  - server joins room `task:${taskId}`
- Graceful shutdown closes DB + Redis + HTTP server.

## 4.2 Agent runner
File: `backend/src/agent-runner.ts`

Implemented capabilities:
- 3 stable personas:
  - The Analyst
  - The Lateral Thinker
  - The Devil's Advocate
- Reasoning extraction from thinking blocks.
- Multi-turn tool loop:
  - sends Anthropic tool definitions from `SkillRegistry`
  - executes `tool_use` calls
  - appends `tool_result` messages back into conversation
- Emits reasoning step for skill call summaries.
- Returns `skillUsage` records:
  - tool name, input, success, summary, duration, timestamp

Contracts:
- `AgentRunResult` includes `persona` and `skillUsage`.
- `AgentRunOptions` supports `skillRegistry`, `activeSkills`, `timeout`, `maxTurns`.

## 4.3 Judge engine
File: `backend/src/judge.ts`

- Judge model scores each successful response on:
  - accuracy (30%)
  - completeness (30%)
  - clarity (20%)
  - insight (20%)
- Total normalized to `/40`.
- Uses strict JSON + `zod` validation.
- Missing score entries are defaulted safely.
- Fallback winner path remains token-efficiency if parse fails.

## 4.4 Orchestrator
File: `backend/src/orchestrator.ts`

Flow:
1. Create `SkillRegistry` (optionally filtered by selected skill names).
2. Emit `orchestration_started` with agent personas and enabled skills.
3. Set task `running`.
4. Load high-quality learning hints and enrich prompt.
5. Run agents in parallel with live reasoning updates.
6. Emit `agent_complete` including `skillUsage`.
7. Emit `judging_started`.
8. Judge results.
9. Persist task/result/strategy/judge data.
10. Update cross-agent learning with threshold + EMA.
11. Cache final result and emit `orchestration_complete`.

Persistence inside orchestrator:
- `Task` status/completion time.
- `TaskResult` for all agents (success and failure flagged).
- `Strategy` winner entry.
- `JudgeResult` via `upsert`.
- `AgentLearning` updates when winner score passes threshold.

## 4.5 Skill registry internals
Files:
- `backend/src/skills/types.ts`
- `backend/src/skills/registry.ts`

Registry behavior:
- Scans candidate roots:
  - `skills/`
  - `backend/skills/`
- Parses `SKILL.md` frontmatter:
  - `name`, `description`, `trigger`, `inputs`, `outputs`
- Maps skill name to known handler modules.
- Exposes:
  - `list()`
  - `toAnthropicTools()`
  - `buildSystemPromptSection()`
  - `execute(name, input, context)`

## 4.6 Skill handlers (implemented)

1. `web-search`
- Uses DuckDuckGo HTML endpoint.
- Extracts title/url/snippet from results page.
- Returns structured results list.

2. `code-executor`
- Runs JS (`node`) or Python (`python3`) in temp dir.
- Timeout enforced (`200..10000ms`).
- Truncates stdout/stderr.
- Deletes temp dir after execution.

3. `calculator`
- Supports arithmetic expression evaluation.
- Allows only numeric/operator chars.
- Converts `^` to exponent `**`.

4. `file-reader`
- Reads text files with line-range support.
- Enforces workspace-root path bounds.
- Rejects large/binary-like files.
- Returns numbered line content and metadata.

---

## 5) API and Event Contracts

## 5.1 REST API

### `POST /api/tasks`
Body:
```json
{
  "prompt": "string",
  "skills": ["web-search", "calculator"],
  "provider": "anthropic | gemini",
  "model": "optional model string"
}
```

Notes:
- `skills` optional; must be array of strings when provided.
- Dedupe + trim applied before orchestration.
- `provider`/`model` are optional; backend defaults apply if omitted.

### `GET /api/tasks/:id`
- Includes:
  - `results`
  - `strategies`
  - `judgeResult`

### `GET /api/tasks`
- Supports `status` and `limit`.

### `GET /api/skills`
- Returns available skill manifests from registry scan.

### `GET /api/skills/usage`
- Returns aggregated usage metrics by `agentId + skillName`:
  - `calls`
  - `successRate`
  - `avgDurationMs`
  - `winRateWhenUsed`

### `GET /api/system/status`
- Returns provider readiness and defaults:
  - `defaultProvider`
  - configured providers with `ready`, `model`, `reason`

### `GET /api/agents`, `GET /api/agents/:id`
- Agent and learning metrics.

### `GET /api/strategies`, `GET /api/strategies/agent/:id`
- Strategy and learning views.

## 5.2 WebSocket events (`task_update`)

### `orchestration_started`
- Includes agents + enabled skill manifest summaries.

### `reasoning_step`
- Includes `agentId` + step payload.

### `agent_complete`
- Includes:
  - `persona`
  - `tokensUsed`
  - `timeMs`
  - `response`
  - `success/error`
  - `skillUsage[]`

### `judging_started`
- Signals judge phase start.

### `orchestration_complete`
- Includes winner, judge result, all results, completion time.

---

## 6) Frontend Technical Design

## 6.1 Dashboard runtime behavior
File: `frontend/src/pages/Dashboard.tsx`

- Connects Socket.IO client to `VITE_API_URL` fallback `http://localhost:3000`.
- Maintains per-agent state:
  - status, persona, reasoning, response, tokens, time, progress
  - winner flag
  - judge metrics
  - `skillUsage`
- Handles room subscriptions on connect + task changes.
- Renders:
  - live race stats
  - winner + score breakdown
  - tabbed agent views
  - reasoning stream
  - final response
  - judge explanation
  - skill usage cards

## 6.2 Agent and reasoning components
Files:
- `frontend/src/components/AgentCard.tsx`
- `frontend/src/components/ReasoningView.tsx`

Current prop compatibility supports:
- `judging` status
- `persona`
- `isWinner`
- `judgeScore`

---

## 7) Data Model (Prisma)

Schema file: `backend/prisma/schema.prisma`

Models in active use:
- `Task`
- `TaskResult`
- `Strategy`
- `AgentLearning`
- `JudgeResult` (new)

`JudgeResult` fields:
- `taskId` (unique, relation to `Task`)
- `winnerAgentId`
- `summary`
- `judgedAt`
- `scores` (JSON-serialized string in current SQLite schema)
- timestamps

---

## 8) Build/Runtime and Deployment Notes

## 8.1 Backend TS compilation for skills
File: `backend/tsconfig.json`
- `rootDir` changed to `.`
- `include` includes both:
  - `src/**/*`
  - `skills/**/*`

## 8.2 Backend package entrypoints
File: `backend/package.json`
- `main`: `dist/src/index.js`
- `start`: `node dist/src/index.js`

## 8.3 Docker compose mounts
File: `docker-compose.yml`
- Backend mounts:
  - `./backend/src:/app/src`
  - `./backend/skills:/app/skills`
  - `./backend/logs:/app/logs`

---

## 9) Verification Status

What has been validated structurally:
- Skill registry, handlers, and routing wired.
- WebSocket room scoping fix applied.
- Judge result persistence path present.
- Frontend receives and renders new orchestration payload fields.
- Provider abstraction build path validated (`anthropic` + `gemini`).
- New provider status endpoint validated (`GET /api/system/status`).
- Backend and frontend production builds pass.

Local runtime validation still required in full environment:
```bash
cd "/Users/borheneddinesaidi/Documents/plan test/backend"
npm install
npx prisma generate
npx prisma migrate dev --name add-judge-result
npm run build

cd "/Users/borheneddinesaidi/Documents/plan test/frontend"
npm install
npm run build

cd "/Users/borheneddinesaidi/Documents/plan test"
docker compose up --build
```

---

## 10) Remaining High-Value Next Steps

1. Add integration tests for provider switching (Anthropic vs Gemini) including tool-call races.
2. Add judge calibration tests to verify score consistency across providers/models.
3. Add request-level guardrails:
  - per-provider timeout/retry policy
  - provider-specific error normalization for UI.
4. Add automated tests:
- skill registry parsing
- tool-call execution loop
- room-scoped socket delivery
- judge persistence and task detail retrieval
- provider status route and launch gating behavior.
5. Extend provider catalog (OpenAI/local model adapters) behind the same provider interface.

---

## 11) Phase 1 Skill Ops Adaptation (OpenClaw-Inspired)

Implemented while keeping the core competitive multi-agent architecture unchanged.

### 11.1 Skill Metadata + Versioning

Files:
- `backend/src/skills/types.ts`
- `backend/skills/*/SKILL.md`

Updates:
- `SkillManifest` now includes:
  - `version`
  - `source` (`workspace | managed | bundled`)
  - `location` (absolute `SKILL.md` path)
  - optional resource paths (`scriptsPath`, `referencesPath`, `assetsPath`)
  - `eligible` and `disabledReasons`
  - parsed `metadata` block (including `metadata.openclaw`)
- All bundled skills now carry:
  - `version: 1.0.0`
  - `metadata.openclaw.emoji`
  - for `code-executor`, `metadata.openclaw.requires.anyBins`

### 11.2 Skill Gating

File:
- `backend/src/skills/registry.ts`

Added load-time gating support from `metadata.openclaw.requires`:
- `bins` (all required)
- `anyBins` (at least one required)
- `env` (required env vars)
- `os` (allowed platforms)

Behavior:
- Ineligible skills are filtered from active tool lists by default.
- Optional listing of ineligible skills is supported for transparency.

### 11.3 Skill Source Precedence

File:
- `backend/src/skills/registry.ts`

Implemented precedence:
- `workspace` > `managed` > `bundled`

Roots are resolved via:
- Workspace: `AGENT_LAB_WORKSPACE_SKILLS_DIR` or default workspace path
- Managed: `AGENT_LAB_MANAGED_SKILLS_DIR` or `~/.agent-lab/skills`
- Bundled: `AGENT_LAB_BUNDLED_SKILLS_DIR` or detected backend bundled path

Skill names are claimed by the highest-precedence source (even when filtered by gating), preventing lower sources from silently overriding.

### 11.4 Install/Update Flow for Managed Overrides

File:
- `backend/src/routes/skills.ts`

New endpoints:
- `POST /api/skills/install`
  - Installs one bundled skill into managed overrides.
  - Supports `force=true` overwrite.
- `POST /api/skills/update`
  - Updates managed skills from bundled source.
  - Supports single-skill update by `name` or batch update.

Also enhanced:
- `GET /api/skills`
  - supports `includeIneligible=true`
  - returns resolved roots alongside skill manifests

### 11.5 Status Transparency

File:
- `backend/src/routes/system.ts`

`GET /api/system/status` now includes resolved `skillRoots` so ops/debug views can verify where skills are loaded from.

### 11.6 UI Awareness

File:
- `frontend/src/pages/Dashboard.tsx`

Updates:
- Skill model now accepts optional `version`, `source`, and eligibility fields.
- Skill chip tooltips include version/source context.
- Skill chips visually mark override provenance (`managed`, `workspace`).

### 11.7 Coding Tool Access Skill

Files:
- `backend/skills/workspace-shell/SKILL.md`
- `backend/skills/workspace-shell/handler.ts`
- `backend/src/skills/registry.ts`
- `AGENTS.md`

Added skill:
- `workspace-shell`
  - Purpose: safe coding-oriented terminal access for repo inspection and scripted checks.
  - Allowed commands: `rg`, `ls`, `cat`, `sed`, `head`, `tail`, `wc`, `git`, `npm`, `pnpm`, `yarn`.
  - Policy guards:
    - workspace-root `cwd` enforcement
    - command/subcommand allowlists
    - package script allowlist (`build`, `test`, `lint`, `typecheck`, `format`, `dev`, `start`, `check`)
    - timeout and output truncation

Notes:
- This gives agents practical coding-tool access while preserving safety boundaries.
- Direct registry execution was smoke-tested successfully (`workspace-shell` command execution path is live).

### 11.8 Loss Pattern Capture (Learning Observation Layer)

Files:
- `backend/prisma/schema.prisma`
- `backend/prisma/migrations/20260225170000_learning_observation_capture/migration.sql`
- `backend/src/orchestrator.ts`
- `backend/src/routes/strategies.ts`
- `backend/src/routes/tasks.ts`

Implemented:
- Added `LearningObservation` model to persist per-agent run observations for both:
  - `win_pattern`
  - `loss_pattern`
- Captured fields include:
  - task/agent/persona/category
  - score breakdown and totals
  - judge mode/prompt version
  - tool path and verification telemetry
  - extracted pattern text
  - structured payload (response snippet, reasoning slice, skills used, errors)

Write path:
- Successful races:
  - observations are persisted for all agents alongside existing task/judge/skill writes.
- Failed races:
  - if agent results exist but judging/orchestration fails, failure observations are still persisted.

Read path:
- New endpoint:
  - `GET /api/strategies/observations`
  - supports filters: `outcomeType`, `category`, `agentId`, `limit`
- Task detail endpoint now includes `learningObservations` for the task.

Impact:
- Eliminates the blind spot from winner-only high-score learning.
- Preserves local-test failure data from the very first run for later routing/eval logic.

### 11.9 Agent Memory Replay

Files:
- `backend/src/routes/tasks.ts`
- `backend/src/orchestrator.ts`
- `backend/src/agent-runner.ts`
- `frontend/src/pages/RaceResult.tsx`

Implemented:
- Replay request payload support in task creation:
  - `replay.sourceTaskId`
  - `replay.sourceStrategyId`
  - `replay.sourceAgentId`
  - `replay.sourcePersona`
  - `replay.toolSequence[]`
  - `replay.reasoningPath[]`
- Orchestrator forwards replay context to the matching source agent on new run.
- Agent runner `replayMode` prepends a replay guidance block into system prompt, including:
  - source task and strategy metadata
  - prior tool sequence
  - prior reasoning path (bounded)
  - instruction to adapt instead of blindly copying

UI:
- `/race/:taskId` now has `Replay This Strategy` action on completed races.
- User enters a new similar prompt, launches replay run, and is navigated to:
  - `/race/<newTaskId>?compareTo=<sourceTaskId>`
- Added side-by-side comparison panel:
  - original winner vs replay winner
  - score delta signal
  - reasoning convergence estimate
  - shared tool-prefix depth

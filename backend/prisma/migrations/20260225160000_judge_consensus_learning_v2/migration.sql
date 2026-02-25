-- Add task category for baseline/lift analytics
ALTER TABLE "Task" ADD COLUMN "category" TEXT NOT NULL DEFAULT 'general';

-- Add per-result telemetry payload
ALTER TABLE "TaskResult" ADD COLUMN "telemetry" TEXT;

-- Expand AgentLearning with lift/category fields
ALTER TABLE "AgentLearning" ADD COLUMN "taskCategory" TEXT NOT NULL DEFAULT 'general';
ALTER TABLE "AgentLearning" ADD COLUMN "avgLift" REAL NOT NULL DEFAULT 0;
ALTER TABLE "AgentLearning" ADD COLUMN "liftSamples" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "AgentLearning" ADD COLUMN "updatedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP;

-- Add judge transparency fields
ALTER TABLE "JudgeResult" ADD COLUMN "judgeMode" TEXT NOT NULL DEFAULT 'single';
ALTER TABLE "JudgeResult" ADD COLUMN "judgePromptVersion" TEXT NOT NULL DEFAULT 'judge-v2';
ALTER TABLE "JudgeResult" ADD COLUMN "criteriaWeights" TEXT NOT NULL DEFAULT '{"accuracy":0.3,"completeness":0.3,"clarity":0.2,"insight":0.2}';
ALTER TABLE "JudgeResult" ADD COLUMN "judgeRuns" TEXT;

-- Add skill-call sequencing telemetry
ALTER TABLE "SkillUsage" ADD COLUMN "turnIndex" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "SkillUsage" ADD COLUMN "callIndex" INTEGER NOT NULL DEFAULT 0;

-- Supporting indexes
CREATE INDEX "Task_category_idx" ON "Task"("category");
CREATE INDEX "AgentLearning_taskCategory_idx" ON "AgentLearning"("taskCategory");
CREATE INDEX "AgentLearning_avgLift_idx" ON "AgentLearning"("avgLift");

-- CreateTable
CREATE TABLE "Task" (
    "id" TEXT NOT NULL,
    "prompt" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "completedAt" TIMESTAMP(3),

    CONSTRAINT "Task_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TaskResult" (
    "id" TEXT NOT NULL,
    "taskId" TEXT NOT NULL,
    "agentId" TEXT NOT NULL,
    "response" TEXT NOT NULL,
    "tokensUsed" INTEGER NOT NULL,
    "timeMs" INTEGER NOT NULL,
    "success" BOOLEAN NOT NULL,
    "reasoning" TEXT[] NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TaskResult_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Strategy" (
    "id" TEXT NOT NULL,
    "taskId" TEXT NOT NULL,
    "agentId" TEXT NOT NULL,
    "approach" TEXT NOT NULL,
    "timesUsed" INTEGER NOT NULL DEFAULT 0,
    "successRate" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "context" TEXT[] NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Strategy_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AgentLearning" (
    "id" TEXT NOT NULL,
    "agentId" TEXT NOT NULL,
    "learnedPattern" TEXT NOT NULL,
    "sourceAgent" TEXT NOT NULL,
    "appliedCount" INTEGER NOT NULL DEFAULT 0,
    "successCount" INTEGER NOT NULL DEFAULT 0,
    "successRate" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AgentLearning_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "JudgeResult" (
    "id" TEXT NOT NULL,
    "taskId" TEXT NOT NULL,
    "winnerAgentId" TEXT NOT NULL,
    "summary" TEXT NOT NULL,
    "judgedAt" TIMESTAMP(3) NOT NULL,
    "scores" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "JudgeResult_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SkillUsage" (
    "id" TEXT NOT NULL,
    "taskId" TEXT NOT NULL,
    "agentId" TEXT NOT NULL,
    "skillName" TEXT NOT NULL,
    "input" JSONB,
    "summary" TEXT NOT NULL,
    "success" BOOLEAN NOT NULL,
    "durationMs" INTEGER NOT NULL,
    "timestamp" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SkillUsage_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Task_status_idx" ON "Task"("status");

-- CreateIndex
CREATE INDEX "Task_createdAt_idx" ON "Task"("createdAt");

-- CreateIndex
CREATE INDEX "TaskResult_taskId_idx" ON "TaskResult"("taskId");

-- CreateIndex
CREATE INDEX "TaskResult_agentId_idx" ON "TaskResult"("agentId");

-- CreateIndex
CREATE INDEX "TaskResult_createdAt_idx" ON "TaskResult"("createdAt");

-- CreateIndex
CREATE INDEX "Strategy_agentId_idx" ON "Strategy"("agentId");

-- CreateIndex
CREATE INDEX "Strategy_successRate_idx" ON "Strategy"("successRate");

-- CreateIndex
CREATE INDEX "AgentLearning_agentId_idx" ON "AgentLearning"("agentId");

-- CreateIndex
CREATE INDEX "AgentLearning_successRate_idx" ON "AgentLearning"("successRate");

-- CreateIndex
CREATE UNIQUE INDEX "JudgeResult_taskId_key" ON "JudgeResult"("taskId");

-- CreateIndex
CREATE INDEX "JudgeResult_winnerAgentId_idx" ON "JudgeResult"("winnerAgentId");

-- CreateIndex
CREATE INDEX "JudgeResult_judgedAt_idx" ON "JudgeResult"("judgedAt");

-- CreateIndex
CREATE INDEX "SkillUsage_taskId_idx" ON "SkillUsage"("taskId");

-- CreateIndex
CREATE INDEX "SkillUsage_agentId_idx" ON "SkillUsage"("agentId");

-- CreateIndex
CREATE INDEX "SkillUsage_skillName_idx" ON "SkillUsage"("skillName");

-- CreateIndex
CREATE INDEX "SkillUsage_timestamp_idx" ON "SkillUsage"("timestamp");

-- CreateIndex
CREATE INDEX "SkillUsage_taskId_agentId_idx" ON "SkillUsage"("taskId", "agentId");

-- AddForeignKey
ALTER TABLE "TaskResult" ADD CONSTRAINT "TaskResult_taskId_fkey" FOREIGN KEY ("taskId") REFERENCES "Task"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Strategy" ADD CONSTRAINT "Strategy_taskId_fkey" FOREIGN KEY ("taskId") REFERENCES "Task"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "JudgeResult" ADD CONSTRAINT "JudgeResult_taskId_fkey" FOREIGN KEY ("taskId") REFERENCES "Task"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SkillUsage" ADD CONSTRAINT "SkillUsage_taskId_fkey" FOREIGN KEY ("taskId") REFERENCES "Task"("id") ON DELETE CASCADE ON UPDATE CASCADE;

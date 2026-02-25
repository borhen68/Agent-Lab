-- CreateTable
CREATE TABLE "LearningObservation" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "taskId" TEXT NOT NULL,
    "agentId" TEXT NOT NULL,
    "persona" TEXT NOT NULL,
    "outcomeType" TEXT NOT NULL DEFAULT 'loss_pattern',
    "taskCategory" TEXT NOT NULL DEFAULT 'general',
    "scoreTotal" INTEGER NOT NULL DEFAULT 0,
    "scoreBaseTotal" INTEGER NOT NULL DEFAULT 0,
    "scoreAccuracy" REAL NOT NULL DEFAULT 0,
    "scoreCompleteness" REAL NOT NULL DEFAULT 0,
    "scoreClarity" REAL NOT NULL DEFAULT 0,
    "scoreInsight" REAL NOT NULL DEFAULT 0,
    "judgeMode" TEXT NOT NULL DEFAULT 'single',
    "judgePromptVersion" TEXT NOT NULL DEFAULT 'judge-v2',
    "toolPath" TEXT NOT NULL DEFAULT 'no-tools',
    "skillCount" INTEGER NOT NULL DEFAULT 0,
    "verificationSteps" INTEGER NOT NULL DEFAULT 0,
    "usedSearchFirst" BOOLEAN NOT NULL DEFAULT false,
    "pattern" TEXT NOT NULL,
    "payload" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "LearningObservation_taskId_fkey"
      FOREIGN KEY ("taskId") REFERENCES "Task" ("id")
      ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateIndex
CREATE INDEX "LearningObservation_taskId_idx" ON "LearningObservation"("taskId");

-- CreateIndex
CREATE INDEX "LearningObservation_agentId_idx" ON "LearningObservation"("agentId");

-- CreateIndex
CREATE INDEX "LearningObservation_outcomeType_idx" ON "LearningObservation"("outcomeType");

-- CreateIndex
CREATE INDEX "LearningObservation_taskCategory_idx" ON "LearningObservation"("taskCategory");

-- CreateIndex
CREATE INDEX "LearningObservation_scoreTotal_idx" ON "LearningObservation"("scoreTotal");

-- CreateIndex
CREATE INDEX "LearningObservation_createdAt_idx" ON "LearningObservation"("createdAt");

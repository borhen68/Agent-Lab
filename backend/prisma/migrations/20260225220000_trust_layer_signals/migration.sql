ALTER TABLE "JudgeResult" ADD COLUMN "confidencePassed" BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE "JudgeResult" ADD COLUMN "confidenceLevel" TEXT NOT NULL DEFAULT 'medium';
ALTER TABLE "JudgeResult" ADD COLUMN "confidenceReason" TEXT NOT NULL DEFAULT '';
ALTER TABLE "JudgeResult" ADD COLUMN "winnerMargin" REAL NOT NULL DEFAULT 0;
ALTER TABLE "JudgeResult" ADD COLUMN "disagreementIndex" REAL NOT NULL DEFAULT 0;
ALTER TABLE "JudgeResult" ADD COLUMN "panelAgreement" REAL;
ALTER TABLE "JudgeResult" ADD COLUMN "evidenceCoverage" REAL NOT NULL DEFAULT 0;

import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';

const API_URL = import.meta.env.VITE_API_URL || 'http://localhost:3000';

interface TaskResultRow {
  id: string;
  agentId: string;
  response: string;
  tokensUsed: number;
  timeMs: number;
  success: boolean;
  reasoning: string[];
  createdAt: string;
}

interface StrategyRow {
  id: string;
  agentId: string;
  approach: string;
  timesUsed: number;
  successRate: number;
  context: string[] | unknown;
  createdAt: string;
}

interface SkillUsageRow {
  id: string;
  agentId: string;
  skillName: string;
  input: unknown;
  summary: string;
  success: boolean;
  durationMs: number;
  turnIndex?: number;
  callIndex?: number;
  timestamp: string;
}

interface MetricEvidence {
  quote: string;
  reason: string;
  startChar?: number;
  endChar?: number;
}

interface JudgeWeights {
  accuracy: number;
  completeness: number;
  clarity: number;
  insight: number;
}

interface JudgeScore {
  agentId: string;
  accuracy: number;
  completeness: number;
  clarity: number;
  insight: number;
  total: number;
  baseTotal?: number;
  diversityPenaltyApplied?: boolean;
  maxSimilarity?: number;
  reasoning: string;
  metricEvidence?: {
    accuracy: MetricEvidence;
    completeness: MetricEvidence;
    clarity: MetricEvidence;
    insight: MetricEvidence;
  };
}

interface TaskDetail {
  id: string;
  prompt: string;
  status: string;
  createdAt: string;
  completedAt?: string | null;
  results: TaskResultRow[];
  strategies: StrategyRow[];
  judgeResult?: {
    winnerAgentId: string;
    summary: string;
    judgedAt: string;
    judgeMode?: 'single' | 'consensus';
    judgePromptVersion?: string;
    criteriaWeights?: JudgeWeights | unknown;
    judgeRuns?: unknown;
    confidencePassed?: boolean;
    confidenceLevel?: 'high' | 'medium' | 'low';
    confidenceReason?: string;
    winnerMargin?: number;
    disagreementIndex?: number;
    panelAgreement?: number;
    evidenceCoverage?: number;
    scores: JudgeScore[] | unknown;
  } | null;
  skillUsages: SkillUsageRow[];
  learningObservations?: unknown[];
}

const AGENT_META: Record<string, { persona: string; description: string; emoji: string; gradient: string }> = {
  'agent-1': { persona: 'The Analyst', description: 'Step-by-step logical decomposition', emoji: '🔬', gradient: 'from-blue-600/10 to-transparent' },
  'agent-2': { persona: 'The Lateral Thinker', description: 'Analogical and creative reasoning', emoji: '💡', gradient: 'from-violet-600/10 to-transparent' },
  'agent-3': { persona: "The Devil's Advocate", description: 'Challenge assumptions and stress-test ideas', emoji: '⚡', gradient: 'from-amber-600/10 to-transparent' },
};

function asJudgeScores(value: unknown): JudgeScore[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is JudgeScore =>
    typeof item === 'object' && item !== null &&
    typeof (item as any).agentId === 'string' && typeof (item as any).total === 'number'
  );
}

function asJudgeWeights(value: unknown): JudgeWeights | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const candidate = value as Record<string, unknown>;
  const accuracy = Number(candidate.accuracy);
  const completeness = Number(candidate.completeness);
  const clarity = Number(candidate.clarity);
  const insight = Number(candidate.insight);
  if (
    !Number.isFinite(accuracy) ||
    !Number.isFinite(completeness) ||
    !Number.isFinite(clarity) ||
    !Number.isFinite(insight)
  ) {
    return null;
  }
  return { accuracy, completeness, clarity, insight };
}

function findWinnerResult(task: TaskDetail | null): TaskResultRow | null {
  if (!task?.judgeResult?.winnerAgentId) return null;
  return task.results.find((result) => result.agentId === task.judgeResult?.winnerAgentId) || null;
}

function toolSequenceForAgent(task: TaskDetail | null, agentId?: string): string[] {
  if (!task || !agentId) return [];
  return task.skillUsages
    .filter((usage) => usage.agentId === agentId)
    .sort((left, right) => {
      const leftOrder = typeof left.callIndex === 'number' ? left.callIndex : Number.MAX_SAFE_INTEGER;
      const rightOrder = typeof right.callIndex === 'number' ? right.callIndex : Number.MAX_SAFE_INTEGER;
      if (leftOrder !== rightOrder) return leftOrder - rightOrder;
      return left.timestamp.localeCompare(right.timestamp);
    })
    .map((usage) => usage.skillName);
}

function toTokenSet(value: string): Set<string> {
  const tokens = value
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter((token) => token.length > 2);
  return new Set(tokens);
}

function jaccardSimilarity(left: string, right: string): number {
  const leftSet = toTokenSet(left);
  const rightSet = toTokenSet(right);

  if (leftSet.size === 0 && rightSet.size === 0) return 1;
  if (leftSet.size === 0 || rightSet.size === 0) return 0;

  let intersection = 0;
  for (const token of leftSet) {
    if (rightSet.has(token)) intersection += 1;
  }
  const union = leftSet.size + rightSet.size - intersection;
  if (union <= 0) return 0;
  return intersection / union;
}

function sharedPrefixLength(left: string[], right: string[]): number {
  const max = Math.min(left.length, right.length);
  let idx = 0;
  while (idx < max && left[idx] === right[idx]) idx += 1;
  return idx;
}

// Replay hook — steps through reasoning entries one-by-one on an interval
function useReplay(steps: string[]) {
  const [replaying, setReplaying] = useState(false);
  const [replayIdx, setReplayIdx] = useState(-1);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const start = () => {
    setReplayIdx(0);
    setReplaying(true);
  };

  const stop = () => {
    setReplaying(false);
    setReplayIdx(-1);
    if (timerRef.current) clearInterval(timerRef.current);
  };

  useEffect(() => {
    if (!replaying) return;
    timerRef.current = setInterval(() => {
      setReplayIdx(idx => {
        if (idx >= steps.length - 1) {
          setReplaying(false);
          clearInterval(timerRef.current!);
          return idx;
        }
        return idx + 1;
      });
    }, 800);
    return () => { if (timerRef.current) clearInterval(timerRef.current); };
  }, [replaying, steps.length]);

  return { replaying, replayIdx, start, stop };
}

function AgentSection({
  result,
  isWinner,
  score,
  skillUsage,
}: {
  result: TaskResultRow;
  isWinner: boolean;
  score?: JudgeScore;
  skillUsage: SkillUsageRow[];
}) {
  const meta = AGENT_META[result.agentId] || AGENT_META['agent-1'];
  const { replaying, replayIdx, start, stop } = useReplay(result.reasoning);
  const visibleSteps = replayIdx >= 0 ? result.reasoning.slice(0, replayIdx + 1) : result.reasoning;

  return (
    <section className={`rounded-2xl border p-6 bg-gradient-to-br ${meta.gradient}
      ${isWinner ? 'border-emerald-600/40' : 'border-white/8'}`}>
      <div className="flex flex-wrap items-start justify-between gap-4 mb-5">
        <div className="flex items-center gap-3">
          <span className="text-3xl">{meta.emoji}</span>
          <div>
            <div className="flex items-center gap-2">
              <h3 className="font-bold text-white">{meta.persona}</h3>
              {isWinner && <span className="text-xs bg-emerald-900/40 border border-emerald-700/40 text-emerald-400 px-2 py-0.5 rounded-full">🏆 Winner</span>}
            </div>
            <p className="text-xs text-white/40">{meta.description}</p>
          </div>
        </div>
        <div className="flex items-center gap-4 text-sm text-white/50">
          <span>🪙 {result.tokensUsed.toLocaleString()} tokens</span>
          <span>⏱ {(result.timeMs / 1000).toFixed(1)}s</span>
          {score && <span className="font-bold text-emerald-400 text-base">{score.total}/40</span>}
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-5">
        {/* Reasoning */}
        <div>
          <div className="flex items-center justify-between mb-3">
            <span className="text-xs font-semibold text-white/30 uppercase tracking-widest">
              Reasoning ({result.reasoning.length} steps)
            </span>
            {result.reasoning.length > 0 && (
              <button
                onClick={replaying ? stop : start}
                className={`flex items-center gap-1.5 text-xs px-3 py-1 rounded-full border transition-all
                  ${replaying
                    ? 'border-amber-600/50 bg-amber-900/20 text-amber-400'
                    : 'border-blue-600/40 bg-blue-900/20 text-blue-400 hover:border-blue-500/60'}
                `}
              >
                {replaying ? '⏹ Stop' : '▶ Replay'}
              </button>
            )}
          </div>
          <div className="h-72 overflow-y-auto rounded-xl bg-black/30 border border-white/5 p-3 space-y-2 scroll-smooth">
            {visibleSteps.length === 0 ? (
              <p className="text-sm text-white/20 text-center mt-8">No reasoning captured.</p>
            ) : (
              visibleSteps.map((thought, i) => (
                <div key={i} className={`rounded-lg border border-white/5 p-3 text-xs leading-relaxed transition-all duration-300
                  ${replayIdx === i ? 'bg-blue-900/20 border-blue-700/30 scale-[1.01]' : 'bg-white/4'}`}>
                  <span className="text-blue-400/50 font-mono font-bold mr-2">#{i + 1}</span>
                  <span className="text-white/70">{thought}</span>
                </div>
              ))
            )}
          </div>
        </div>

        {/* Response + scores + skills */}
        <div className="space-y-4">
          <div>
            <p className="text-xs font-semibold text-white/30 uppercase tracking-widest mb-3">Final Response</p>
            <div className="h-48 overflow-y-auto rounded-xl bg-black/30 border border-white/5 p-4 text-sm text-white/70 leading-relaxed whitespace-pre-wrap break-words">
              {result.response || <span className="text-white/20">No response stored.</span>}
            </div>
          </div>

          {score && (
            <div className="rounded-xl bg-black/20 border border-white/5 p-4">
              <p className="text-xs font-semibold text-white/30 uppercase tracking-widest mb-3">Judge Scores</p>
              <p className="text-xs text-white/40 italic mb-3 leading-relaxed">{score.reasoning}</p>
              <div className="grid grid-cols-2 gap-2">
                {[
                  { label: 'Accuracy', val: score.accuracy },
                  { label: 'Completeness', val: score.completeness },
                  { label: 'Clarity', val: score.clarity },
                  { label: 'Insight', val: score.insight },
                ].map(({ label, val }) => (
                  <div key={label} className="text-xs">
                    <div className="flex justify-between text-white/40 mb-1"><span>{label}</span><span>{val}/10</span></div>
                    <div className="h-1 rounded-full bg-black/30 overflow-hidden">
                      <div className="h-full rounded-full bg-gradient-to-r from-blue-500 to-violet-500" style={{ width: `${val * 10}%` }} />
                    </div>
                  </div>
                ))}
              </div>
              {score.diversityPenaltyApplied && (
                <p className="text-[11px] text-amber-300/75 mt-3">
                  Diversity penalty applied ({Math.round((score.maxSimilarity || 0) * 100)}% similarity).
                </p>
              )}
              {typeof score.baseTotal === 'number' && score.baseTotal !== score.total && (
                <p className="text-[11px] text-white/35 mt-1">Base score: {score.baseTotal}/40</p>
              )}
              {score.metricEvidence && (
                <div className="mt-3 pt-3 border-t border-white/5 space-y-2">
                  {(Object.entries(score.metricEvidence) as Array<[string, MetricEvidence]>).map(([metric, evidence]) => (
                    <div key={metric} className="text-[11px] bg-white/4 rounded-lg p-2 border border-white/5">
                      <p className="text-white/40 uppercase tracking-widest mb-1">{metric}</p>
                      <p className="text-white/65 italic">"{evidence.quote}"</p>
                      <p className="text-white/35 mt-1">{evidence.reason}</p>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}

          {skillUsage.length > 0 && (
            <div className="rounded-xl bg-black/20 border border-white/5 p-4">
              <p className="text-xs font-semibold text-white/30 uppercase tracking-widest mb-3">
                Skills Used ({skillUsage.length})
              </p>
              <div className="space-y-2 max-h-40 overflow-y-auto">
                {skillUsage.map(u => (
                  <div key={u.id} className="flex items-start gap-2 text-xs bg-white/4 rounded-lg p-2 border border-white/5">
                    <span className={`mt-0.5 w-1.5 h-1.5 rounded-full flex-shrink-0 ${u.success ? 'bg-emerald-400' : 'bg-red-400'}`} />
                    <div>
                      <span className="font-semibold text-white/70">{u.skillName}</span>
                      <span className="text-white/30 ml-2">{u.durationMs}ms</span>
                      {typeof u.callIndex === 'number' && <span className="text-white/30 ml-2">#{u.callIndex}</span>}
                      {typeof u.turnIndex === 'number' && <span className="text-white/30 ml-2">turn {u.turnIndex}</span>}
                      <p className="text-white/40 mt-0.5">{u.summary}</p>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      </div>
    </section>
  );
}

export default function RaceResult() {
  const { taskId } = useParams<{ taskId: string }>();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const compareToTaskId = searchParams.get('compareTo');
  const [task, setTask] = useState<TaskDetail | null>(null);
  const [comparisonTask, setComparisonTask] = useState<TaskDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [replayPrompt, setReplayPrompt] = useState('');
  const [replaySubmitting, setReplaySubmitting] = useState(false);
  const [replayError, setReplayError] = useState<string | null>(null);

  useEffect(() => {
    if (!taskId) return;
    let cancelled = false;
    let pollTimer: ReturnType<typeof setTimeout> | null = null;

    const fetchTask = async () => {
      try {
        const res = await fetch(`${API_URL}/api/tasks/${taskId}`);
        if (!res.ok) throw new Error(res.status === 404 ? 'Race not found' : `Request failed (${res.status})`);
        const payload = await res.json();
        if (cancelled) return;
        setTask(payload);
        setError(null);
        setLoading(false);
        if (payload?.status === 'pending' || payload?.status === 'running') {
          pollTimer = setTimeout(fetchTask, 3000);
        }
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : 'Failed to load race');
          setLoading(false);
        }
      }
    };

    fetchTask();
    return () => { cancelled = true; if (pollTimer) clearTimeout(pollTimer); };
  }, [taskId]);

  useEffect(() => {
    if (!compareToTaskId) {
      setComparisonTask(null);
      return;
    }

    let cancelled = false;
    const fetchComparison = async () => {
      try {
        const res = await fetch(`${API_URL}/api/tasks/${compareToTaskId}`);
        if (!res.ok) throw new Error(`Failed to load comparison race (${res.status})`);
        const payload = await res.json();
        if (!cancelled) setComparisonTask(payload);
      } catch {
        if (!cancelled) setComparisonTask(null);
      }
    };

    fetchComparison();
    return () => { cancelled = true; };
  }, [compareToTaskId]);

  const judgeScores = useMemo(() => asJudgeScores(task?.judgeResult?.scores), [task?.judgeResult?.scores]);
  const scoreByAgent = useMemo(() => new Map(judgeScores.map(s => [s.agentId, s])), [judgeScores]);
  const skillUsageByAgent = useMemo(() => {
    const grouped: Record<string, SkillUsageRow[]> = {};
    for (const u of task?.skillUsages || []) {
      grouped[u.agentId] = grouped[u.agentId] || [];
      grouped[u.agentId].push(u);
    }
    return grouped;
  }, [task?.skillUsages]);

  const winnerAgentId = task?.judgeResult?.winnerAgentId;
  const winnerMeta = winnerAgentId ? AGENT_META[winnerAgentId] : null;
  const winnerResult = useMemo(() => findWinnerResult(task), [task]);
  const winnerStrategyId = useMemo(() => {
    if (!task || !winnerAgentId) return undefined;
    return task.strategies?.find((strategy) => strategy.agentId === winnerAgentId)?.id;
  }, [task, winnerAgentId]);
  const winnerToolSequence = useMemo(
    () => toolSequenceForAgent(task, winnerAgentId),
    [task, winnerAgentId]
  );
  const winnerReasoningPath = useMemo(
    () => (winnerResult?.reasoning || []).slice(0, 8),
    [winnerResult]
  );

  const handleReplayStrategy = async () => {
    if (!task || !winnerAgentId) return;
    if (!replayPrompt.trim()) {
      setReplayError('Enter a new prompt to replay this strategy.');
      return;
    }

    setReplayError(null);
    setReplaySubmitting(true);

    const replaySkills = Array.from(new Set(winnerToolSequence));

    try {
      const response = await fetch(`${API_URL}/api/tasks`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          prompt: replayPrompt.trim(),
          skills: replaySkills.length > 0 ? replaySkills : undefined,
          replay: {
            sourceTaskId: task.id,
            sourceStrategyId: winnerStrategyId,
            sourceAgentId: winnerAgentId,
            sourcePersona: winnerMeta?.persona,
            toolSequence: winnerToolSequence,
            reasoningPath: winnerReasoningPath,
          },
        }),
      });

      if (!response.ok) {
        const payload = await response.json().catch(() => ({}));
        throw new Error(payload?.error || `Replay failed (${response.status})`);
      }

      const payload = await response.json();
      const replayTaskId = payload?.taskId;
      if (!replayTaskId) {
        throw new Error('Replay response did not include taskId.');
      }

      navigate(`/race/${replayTaskId}?compareTo=${task.id}`);
    } catch (err) {
      setReplayError(err instanceof Error ? err.message : 'Failed to launch replay');
    } finally {
      setReplaySubmitting(false);
    }
  };

  const replayComparison = useMemo(() => {
    if (!comparisonTask || !task) return null;
    if (!comparisonTask.judgeResult || !task.judgeResult) return null;

    const sourceWinnerAgent = comparisonTask.judgeResult.winnerAgentId;
    const replayWinnerAgent = task.judgeResult.winnerAgentId;

    const sourceWinnerResult = findWinnerResult(comparisonTask);
    const replayWinnerResult = findWinnerResult(task);
    if (!sourceWinnerResult || !replayWinnerResult) return null;

    const sourceScores = asJudgeScores(comparisonTask.judgeResult.scores);
    const replayScores = asJudgeScores(task.judgeResult.scores);
    const sourceWinnerScore = sourceScores.find((score) => score.agentId === sourceWinnerAgent);
    const replayWinnerScore = replayScores.find((score) => score.agentId === replayWinnerAgent);

    const sourceReasoning = sourceWinnerResult.reasoning.join('\n');
    const replayReasoning = replayWinnerResult.reasoning.join('\n');
    const convergence = jaccardSimilarity(sourceReasoning, replayReasoning);

    const sourceSequence = toolSequenceForAgent(comparisonTask, sourceWinnerAgent);
    const replaySequence = toolSequenceForAgent(task, replayWinnerAgent);
    const sharedPrefix = sharedPrefixLength(sourceSequence, replaySequence);

    return {
      source: {
        taskId: comparisonTask.id,
        winnerAgentId: sourceWinnerAgent,
        winnerPersona: AGENT_META[sourceWinnerAgent]?.persona || sourceWinnerAgent,
        score: sourceWinnerScore?.total ?? 0,
        sequence: sourceSequence,
      },
      replay: {
        taskId: task.id,
        winnerAgentId: replayWinnerAgent,
        winnerPersona: AGENT_META[replayWinnerAgent]?.persona || replayWinnerAgent,
        score: replayWinnerScore?.total ?? 0,
        sequence: replaySequence,
      },
      convergence,
      sharedPrefix,
    };
  }, [comparisonTask, task]);

  if (!taskId) return <div className="p-6 text-white/50">Missing task id.</div>;

  return (
    <div className="min-h-screen bg-[#0a0a0f] text-white">
      <div className="fixed inset-0 pointer-events-none overflow-hidden">
        <div className="absolute top-0 left-1/4 w-96 h-96 bg-emerald-600/8 rounded-full blur-3xl" />
        <div className="absolute bottom-0 right-0 w-96 h-96 bg-blue-600/8 rounded-full blur-3xl" />
      </div>

      <div className="relative z-10 max-w-7xl mx-auto px-6 py-8">
        <div className="flex flex-wrap items-center justify-between gap-3 mb-8">
          <div>
            <h1 className="text-3xl font-black text-white">Race Result</h1>
            <p className="text-xs text-white/30 mt-1 font-mono">#{taskId}</p>
          </div>
          <Link to="/strategies" className="text-sm text-blue-400 hover:text-blue-300 border border-blue-800/40 hover:border-blue-700/60 px-4 py-2 rounded-xl transition-all">
            ← History
          </Link>
        </div>

        {loading && (
          <div className="text-center py-20 text-white/30">
            <div className="w-8 h-8 border-2 border-white/20 border-t-white/60 rounded-full animate-spin mx-auto mb-4" />
            Loading race {taskId}...
          </div>
        )}

        {error && (
          <div className="text-center py-20">
            <p className="text-red-400 mb-4">{error}</p>
            <Link to="/" className="text-blue-400 underline">Back to dashboard</Link>
          </div>
        )}

        {task && !loading && (
          <>
            {/* Task info */}
            <div className="rounded-2xl border border-white/8 bg-white/4 p-5 mb-6">
              <div className="flex flex-wrap gap-4 text-xs text-white/30 mb-3">
                <span>Status: <span className="text-white/60">{task.status}</span></span>
                <span>Created: <span className="text-white/60">{new Date(task.createdAt).toLocaleString()}</span></span>
                {task.completedAt && <span>Completed: <span className="text-white/60">{new Date(task.completedAt).toLocaleString()}</span></span>}
                {task.completedAt && <span>Duration: <span className="text-white/60">{((new Date(task.completedAt).getTime() - new Date(task.createdAt).getTime()) / 1000).toFixed(1)}s</span></span>}
              </div>
              <p className="text-sm text-white/80 leading-relaxed">{task.prompt}</p>
            </div>

            {winnerAgentId && (
              <div className="rounded-2xl border border-blue-700/30 bg-gradient-to-br from-blue-950/20 to-black/30 p-5 mb-6">
                <div className="flex flex-wrap items-start justify-between gap-3 mb-4">
                  <div>
                    <h3 className="text-lg font-bold text-white">Replay This Strategy</h3>
                    <p className="text-xs text-white/45 mt-1">
                      Clone winner guidance from {winnerMeta?.persona || winnerAgentId} on a new similar prompt.
                    </p>
                  </div>
                  <div className="text-[11px] text-white/35">
                    <div>Strategy ID: <span className="text-white/60 font-mono">{winnerStrategyId || 'n/a'}</span></div>
                    <div>Tool Sequence: <span className="text-white/60">{winnerToolSequence.join(' -> ') || 'no-tools'}</span></div>
                  </div>
                </div>

                <textarea
                  value={replayPrompt}
                  onChange={(event) => setReplayPrompt(event.target.value)}
                  placeholder="Enter a new but similar task prompt..."
                  className="w-full h-24 bg-black/30 text-white placeholder-white/25 p-3 rounded-xl border border-white/10 focus:border-blue-500/60 focus:outline-none resize-none text-sm mb-3"
                />

                {replayError && (
                  <p className="text-xs text-red-400 mb-3">{replayError}</p>
                )}

                <button
                  onClick={handleReplayStrategy}
                  disabled={replaySubmitting || !replayPrompt.trim()}
                  className={`px-4 py-2 rounded-lg text-sm font-semibold transition-all
                    ${replaySubmitting || !replayPrompt.trim()
                      ? 'bg-white/10 text-white/30 cursor-not-allowed'
                      : 'bg-gradient-to-r from-blue-600 to-cyan-500 text-white hover:from-blue-500 hover:to-cyan-400'}
                  `}
                >
                  {replaySubmitting ? 'Launching Replay...' : 'Replay This Strategy'}
                </button>
              </div>
            )}

            {replayComparison && (
              <div className="rounded-2xl border border-violet-700/30 bg-gradient-to-br from-violet-950/20 to-black/30 p-5 mb-6">
                <div className="flex flex-wrap items-center justify-between gap-3 mb-4">
                  <h3 className="text-lg font-bold text-white">Replay Comparison</h3>
                  <div className="text-xs text-white/45">
                    Convergence {Math.round(replayComparison.convergence * 100)}% · Shared tool prefix {replayComparison.sharedPrefix}
                  </div>
                </div>

                <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                  <div className="rounded-xl border border-white/10 bg-black/20 p-4">
                    <p className="text-xs text-white/35 uppercase tracking-widest mb-2">Original Winner</p>
                    <p className="text-sm font-semibold text-white">{replayComparison.source.winnerPersona}</p>
                    <p className="text-xs text-emerald-300 mt-1">Score: {replayComparison.source.score}/40</p>
                    <p className="text-xs text-white/45 mt-2">Tools: {replayComparison.source.sequence.join(' -> ') || 'no-tools'}</p>
                  </div>

                  <div className="rounded-xl border border-white/10 bg-black/20 p-4">
                    <p className="text-xs text-white/35 uppercase tracking-widest mb-2">Replay Run Winner</p>
                    <p className="text-sm font-semibold text-white">{replayComparison.replay.winnerPersona}</p>
                    <p className="text-xs text-emerald-300 mt-1">Score: {replayComparison.replay.score}/40</p>
                    <p className="text-xs text-white/45 mt-2">Tools: {replayComparison.replay.sequence.join(' -> ') || 'no-tools'}</p>
                  </div>
                </div>

                <p className="text-xs text-white/35 mt-3">
                  {replayComparison.replay.score >= replayComparison.source.score
                    ? 'Replay matched or improved winner score.'
                    : 'Replay underperformed original winner score; strategy likely task-sensitive.'}
                </p>
              </div>
            )}

            {/* Podium */}
            {task.judgeResult && (
              <div className="rounded-2xl border border-emerald-700/30 bg-gradient-to-br from-emerald-950/30 to-black/30 p-6 mb-6">
                <div className="text-center mb-5">
                  <div className="text-4xl mb-2">🏆</div>
                  <h2 className="text-2xl font-black text-white">
                    {AGENT_META[task.judgeResult.winnerAgentId]?.persona || task.judgeResult.winnerAgentId}
                  </h2>
                  <p className="text-sm text-emerald-300/80 mt-2 max-w-lg mx-auto">{task.judgeResult.summary}</p>
                </div>
                <div className="text-xs text-white/45 flex flex-wrap items-center justify-center gap-x-4 gap-y-2 mb-4">
                  <span>Mode: <span className="text-white/65">{task.judgeResult.judgeMode || 'single'}</span></span>
                  <span>Prompt: <span className="text-white/65">{task.judgeResult.judgePromptVersion || 'judge-v2'}</span></span>
                  {task.judgeResult.confidenceLevel && (
                    <span>
                      Trust:
                      <span
                        className={`ml-1 rounded-full px-2 py-0.5 border ${
                          task.judgeResult.confidenceLevel === 'high'
                            ? 'border-emerald-500/50 text-emerald-300'
                            : task.judgeResult.confidenceLevel === 'low'
                              ? 'border-red-500/50 text-red-300'
                              : 'border-amber-500/50 text-amber-300'
                        }`}
                      >
                        {task.judgeResult.confidenceLevel.toUpperCase()}
                      </span>
                    </span>
                  )}
                  {asJudgeWeights(task.judgeResult.criteriaWeights) && (
                    <span>
                      Weights:
                      <span className="text-white/65 ml-1">
                        {(() => {
                          const weights = asJudgeWeights(task.judgeResult?.criteriaWeights);
                          if (!weights) return 'n/a';
                          return `A ${Math.round(weights.accuracy * 100)}% C ${Math.round(weights.completeness * 100)}% Cl ${Math.round(weights.clarity * 100)}% I ${Math.round(weights.insight * 100)}%`;
                        })()}
                      </span>
                    </span>
                  )}
                  {typeof task.judgeResult.evidenceCoverage === 'number' && (
                    <span>Evidence: <span className="text-white/65">{Math.round(task.judgeResult.evidenceCoverage * 100)}%</span></span>
                  )}
                  {typeof task.judgeResult.disagreementIndex === 'number' && (
                    <span>Disagreement: <span className="text-white/65">{Math.round(task.judgeResult.disagreementIndex * 100)}%</span></span>
                  )}
                  {typeof task.judgeResult.panelAgreement === 'number' && (
                    <span>Panel Agreement: <span className="text-white/65">{Math.round(task.judgeResult.panelAgreement * 100)}%</span></span>
                  )}
                  {typeof task.judgeResult.winnerMargin === 'number' && (
                    <span>Winner Margin: <span className="text-white/65">{task.judgeResult.winnerMargin.toFixed(2)}</span></span>
                  )}
                </div>
                {task.judgeResult.confidenceReason && (
                  <p className="text-xs text-white/35 text-center mb-4">{task.judgeResult.confidenceReason}</p>
                )}
                {judgeScores.length > 0 && (
                  <div className="grid grid-cols-3 gap-4">
                    {[...judgeScores].sort((a, b) => b.total - a.total).map((score, i) => {
                      const meta = AGENT_META[score.agentId] || AGENT_META['agent-1'];
                      const isWinner = score.agentId === task.judgeResult?.winnerAgentId;
                      const medals = ['🥇', '🥈', '🥉'];
                      return (
                        <div key={score.agentId} className={`rounded-xl border p-4 text-center
                          ${isWinner ? 'border-emerald-500/40 bg-emerald-900/20' : 'border-white/8 bg-white/4'}`}>
                          <div className="text-2xl mb-1">{medals[i] || '🏅'}</div>
                          <div className="text-xl">{meta.emoji}</div>
                          <div className="font-bold text-sm text-white mt-1">{meta.persona}</div>
                          <div className="text-2xl font-black text-emerald-400 mt-2">{score.total}<span className="text-sm text-white/30">/40</span></div>
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
            )}

            {/* Agent sections */}
            <div className="space-y-5">
              {[...task.results]
                .sort((a, b) => a.agentId.localeCompare(b.agentId))
                .map(result => (
                  <AgentSection
                    key={result.id}
                    result={result}
                    isWinner={result.agentId === task.judgeResult?.winnerAgentId}
                    score={scoreByAgent.get(result.agentId)}
                    skillUsage={skillUsageByAgent[result.agentId] || []}
                  />
                ))}
            </div>
          </>
        )}
      </div>
    </div>
  );
}

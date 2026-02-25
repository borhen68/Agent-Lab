import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';

const API_URL = import.meta.env.VITE_API_URL || 'http://localhost:3000';

interface TaskSummary {
  id: string;
  prompt: string;
  status: string;
  createdAt: string;
  completedAt?: string | null;
  _count: { results: number };
}

interface JudgeScore {
  agentId: string;
  accuracy: number;
  completeness: number;
  clarity: number;
  insight: number;
  total: number;
  reasoning: string;
}

interface TaskDetail extends TaskSummary {
  judgeResult?: {
    winnerAgentId: string;
    summary: string;
    scores: JudgeScore[] | unknown;
  } | null;
  skillUsages?: { skillName: string }[];
}

interface TransferablePattern {
  id: string;
  targetAgentId: string;
  sourceAgentId: string;
  taskCategory: string;
  learnedPattern: string;
  avgLift: number;
  liftSamples: number;
  successRate: number;
  transferConfidence: number;
  appliedCount: number;
  updatedAt: string;
}

const AGENT_META: Record<string, { persona: string; emoji: string }> = {
  'agent-1': { persona: 'The Analyst', emoji: '🔬' },
  'agent-2': { persona: 'The Lateral Thinker', emoji: '💡' },
  'agent-3': { persona: "The Devil's Advocate", emoji: '⚡' },
};

const STATUS_BADGE: Record<string, string> = {
  completed: 'bg-emerald-900/40 text-emerald-400 border-emerald-700/40',
  running: 'bg-blue-900/40 text-blue-400 border-blue-700/40 animate-pulse',
  pending: 'bg-slate-800 text-white/40 border-white/10',
  failed: 'bg-red-900/40 text-red-400 border-red-700/40',
};

function timeAgo(dateStr: string): string {
  const diff = Date.now() - new Date(dateStr).getTime();
  const s = Math.floor(diff / 1000);
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

function asJudgeScores(value: unknown): JudgeScore[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is JudgeScore =>
    typeof item === 'object' && item !== null &&
    typeof (item as any).agentId === 'string' &&
    typeof (item as any).total === 'number'
  );
}

export default function Strategies() {
  const [tasks, setTasks] = useState<TaskDetail[]>([]);
  const [patterns, setPatterns] = useState<TransferablePattern[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [filterWinner, setFilterWinner] = useState<string>('all');
  const [filterStatus, setFilterStatus] = useState<string>('all');
  const [search, setSearch] = useState('');
  const [page, setPage] = useState(0);
  const PAGE_SIZE = 10;

  useEffect(() => {
    let cancelled = false;
    const fetchTasks = async () => {
      setLoading(true);
      setError(null);
      try {
        const [res, patternsRes] = await Promise.all([
          fetch(`${API_URL}/api/tasks?limit=100`),
          fetch(`${API_URL}/api/strategies/patterns?limit=10`),
        ]);
        if (!res.ok) throw new Error(`Failed to load (${res.status})`);
        const data = await res.json();
        const items: TaskSummary[] = Array.isArray(data) ? data : [];

        // Fetch detail for completed tasks (with judgeResult) - batch first 30
        const detailed = await Promise.all(
          items.slice(0, 50).map(async (task) => {
            if (task.status !== 'completed') return task as TaskDetail;
            try {
              const r = await fetch(`${API_URL}/api/tasks/${task.id}`);
              if (!r.ok) return task as TaskDetail;
              return await r.json() as TaskDetail;
            } catch { return task as TaskDetail; }
          })
        );
        if (!cancelled) {
          setTasks(detailed);
          if (patternsRes.ok) {
            const payload = await patternsRes.json();
            setPatterns(Array.isArray(payload?.patterns) ? payload.patterns as TransferablePattern[] : []);
          }
        }
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : 'Failed to load');
      } finally {
        if (!cancelled) setLoading(false);
      }
    };
    fetchTasks();
    return () => { cancelled = true; };
  }, []);

  const winners = useMemo(() => {
    const set = new Set<string>();
    tasks.forEach(t => { if (t.judgeResult?.winnerAgentId) set.add(t.judgeResult.winnerAgentId); });
    return Array.from(set);
  }, [tasks]);

  const filtered = useMemo(() => {
    return tasks.filter(t => {
      if (filterStatus !== 'all' && t.status !== filterStatus) return false;
      if (filterWinner !== 'all' && t.judgeResult?.winnerAgentId !== filterWinner) return false;
      if (search && !t.prompt.toLowerCase().includes(search.toLowerCase())) return false;
      return true;
    });
  }, [tasks, filterStatus, filterWinner, search]);

  const paged = filtered.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE);
  const totalPages = Math.ceil(filtered.length / PAGE_SIZE);

  // Win stats across completed tasks
  const winStats = useMemo(() => {
    const counts: Record<string, number> = {};
    tasks.forEach(t => {
      const w = t.judgeResult?.winnerAgentId;
      if (w) counts[w] = (counts[w] || 0) + 1;
    });
    return counts;
  }, [tasks]);
  const totalRaces = Object.values(winStats).reduce((a, b) => a + b, 0);

  return (
    <div className="min-h-screen bg-[#0a0a0f] text-white">
      <div className="fixed inset-0 pointer-events-none overflow-hidden">
        <div className="absolute top-0 right-0 w-96 h-96 bg-violet-600/8 rounded-full blur-3xl" />
        <div className="absolute bottom-0 left-0 w-96 h-96 bg-blue-600/8 rounded-full blur-3xl" />
      </div>

      <div className="relative z-10 max-w-7xl mx-auto px-6 py-8">

        <div className="flex items-start justify-between mb-10">
          <div>
            <h1 className="text-4xl font-black tracking-tight text-white">Race History</h1>
            <p className="text-white/40 mt-2">{tasks.length} total races recorded</p>
          </div>
          <Link to="/" className="text-sm text-blue-400 hover:text-blue-300 border border-blue-800/40 hover:border-blue-700/60 px-4 py-2 rounded-xl transition-all">
            ⚡ New Race
          </Link>
        </div>

        {/* Win leaderboard */}
        {totalRaces > 0 && (
          <div className="rounded-2xl border border-white/8 bg-white/4 p-5 mb-6">
            <p className="text-xs font-semibold text-white/30 uppercase tracking-widest mb-4">Persona Leaderboard</p>
            <div className="grid grid-cols-3 gap-4">
              {['agent-1', 'agent-2', 'agent-3'].map(id => {
                const wins = winStats[id] || 0;
                const rate = totalRaces > 0 ? (wins / totalRaces) * 100 : 0;
                const meta = AGENT_META[id];
                return (
                  <div key={id} className="text-center">
                    <div className="text-3xl mb-1">{meta.emoji}</div>
                    <div className="font-bold text-sm text-white">{meta.persona}</div>
                    <div className="text-2xl font-black text-white mt-1">{wins}<span className="text-sm text-white/30"> wins</span></div>
                    <div className="text-xs text-white/30">{rate.toFixed(0)}% win rate</div>
                    <div className="mt-2 h-1.5 rounded-full bg-black/30 overflow-hidden">
                      <div className="h-full bg-gradient-to-r from-blue-500 to-violet-500 rounded-full transition-all duration-700"
                        style={{ width: `${rate}%` }} />
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        )}

        {patterns.length > 0 && (
          <div className="rounded-2xl border border-white/8 bg-white/4 p-5 mb-6">
            <p className="text-xs font-semibold text-white/30 uppercase tracking-widest mb-4">
              Top Transferable Patterns
            </p>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
              {patterns.map((pattern) => {
                const sourceMeta = AGENT_META[pattern.sourceAgentId] || { persona: pattern.sourceAgentId, emoji: '🧠' };
                const targetMeta = AGENT_META[pattern.targetAgentId] || { persona: pattern.targetAgentId, emoji: '🧠' };
                return (
                  <div key={pattern.id} className="rounded-xl border border-white/10 bg-black/20 p-3">
                    <div className="flex items-center justify-between gap-2 mb-2">
                      <span className="text-xs text-white/60">
                        {sourceMeta.emoji} {sourceMeta.persona} → {targetMeta.emoji} {targetMeta.persona}
                      </span>
                      <span className="text-xs text-emerald-300">Lift +{pattern.avgLift.toFixed(2)}</span>
                    </div>
                    <p className="text-xs text-white/50 line-clamp-2">{pattern.learnedPattern}</p>
                    <div className="mt-2 flex flex-wrap gap-2 text-[11px] text-white/35">
                      <span>Category: {pattern.taskCategory}</span>
                      <span>Samples: {pattern.liftSamples}</span>
                      <span>Success: {pattern.successRate.toFixed(1)}%</span>
                      <span>Confidence: {pattern.transferConfidence.toFixed(1)}</span>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        )}

        {/* Filters */}
        <div className="flex flex-wrap items-center gap-3 mb-5">
          <input
            type="text"
            placeholder="Search prompts..."
            value={search}
            onChange={e => { setSearch(e.target.value); setPage(0); }}
            className="bg-white/5 border border-white/10 rounded-xl px-4 py-2 text-sm text-white placeholder-white/20 focus:outline-none focus:border-blue-500/50 transition-colors min-w-48"
          />
          <select
            value={filterStatus}
            onChange={e => { setFilterStatus(e.target.value); setPage(0); }}
            className="bg-white/5 border border-white/10 rounded-xl px-3 py-2 text-sm text-white/70 focus:outline-none cursor-pointer"
          >
            <option value="all">All statuses</option>
            <option value="completed">Completed</option>
            <option value="running">Running</option>
            <option value="failed">Failed</option>
          </select>
          <select
            value={filterWinner}
            onChange={e => { setFilterWinner(e.target.value); setPage(0); }}
            className="bg-white/5 border border-white/10 rounded-xl px-3 py-2 text-sm text-white/70 focus:outline-none cursor-pointer"
          >
            <option value="all">All winners</option>
            {winners.map(w => (
              <option key={w} value={w}>{AGENT_META[w]?.persona || w}</option>
            ))}
          </select>
          {(filterStatus !== 'all' || filterWinner !== 'all' || search) && (
            <button onClick={() => { setFilterStatus('all'); setFilterWinner('all'); setSearch(''); setPage(0); }}
              className="text-xs text-white/40 hover:text-white/70 transition-colors">
              Clear filters
            </button>
          )}
          <span className="ml-auto text-xs text-white/20">{filtered.length} results</span>
        </div>

        {loading ? (
          <div className="text-center py-20 text-white/30">
            <div className="w-8 h-8 border-2 border-white/20 border-t-white/60 rounded-full animate-spin mx-auto mb-4" />
            Loading races...
          </div>
        ) : error ? (
          <div className="text-center py-20 text-red-400">{error}</div>
        ) : filtered.length === 0 ? (
          <div className="text-center py-20 text-white/20">
            {tasks.length === 0 ? 'No races yet. Launch your first race →' : 'No races match your filters.'}
          </div>
        ) : (
          <>
            <div className="space-y-3">
              {paged.map(task => {
                const winner = task.judgeResult?.winnerAgentId;
                const winnerMeta = winner ? AGENT_META[winner] : null;
                const scores = asJudgeScores(task.judgeResult?.scores);
                const topScore = scores.find(s => s.agentId === winner);
                const duration = task.completedAt
                  ? `${((new Date(task.completedAt).getTime() - new Date(task.createdAt).getTime()) / 1000).toFixed(1)}s`
                  : null;
                const usedSkills = [...new Set((task.skillUsages || []).map(u => u.skillName))];

                return (
                  <Link
                    key={task.id}
                    to={`/race/${task.id}`}
                    className="block rounded-2xl border border-white/8 bg-white/4 hover:bg-white/6 hover:border-white/15 transition-all p-5 group"
                  >
                    <div className="flex flex-wrap items-start justify-between gap-3">
                      <div className="flex-1 min-w-0">
                        <p className="text-sm text-white/70 leading-relaxed line-clamp-2 group-hover:text-white/90 transition-colors">
                          {task.prompt}
                        </p>
                        <div className="flex flex-wrap items-center gap-3 mt-2">
                          <span className="text-xs text-white/25">{timeAgo(task.createdAt)}</span>
                          <span className={`text-xs border rounded-full px-2 py-0.5 ${STATUS_BADGE[task.status] || STATUS_BADGE.pending}`}>
                            {task.status}
                          </span>
                          {duration && <span className="text-xs text-white/25">{duration}</span>}
                          {usedSkills.map(s => (
                            <span key={s} className="text-[10px] text-white/25">🔧{s}</span>
                          ))}
                        </div>
                      </div>
                      <div className="flex items-center gap-4 text-right flex-shrink-0">
                        {winnerMeta && (
                          <div>
                            <div className="text-xl">{winnerMeta.emoji}</div>
                            <div className="text-xs text-white/40">{winnerMeta.persona}</div>
                            {topScore && (
                              <div className="text-sm font-bold text-emerald-400">{topScore.total}/40</div>
                            )}
                          </div>
                        )}
                        <div className="text-white/20 group-hover:text-white/50 transition-colors">→</div>
                      </div>
                    </div>
                    {task.judgeResult?.summary && (
                      <p className="mt-2 text-xs text-white/30 line-clamp-1 italic">{task.judgeResult.summary}</p>
                    )}
                  </Link>
                );
              })}
            </div>

            {totalPages > 1 && (
              <div className="flex items-center justify-center gap-3 mt-6">
                <button onClick={() => setPage(p => Math.max(0, p - 1))} disabled={page === 0}
                  className="px-4 py-2 rounded-xl border border-white/10 text-sm text-white/50 hover:text-white disabled:opacity-30 transition-colors">
                  ← Prev
                </button>
                <span className="text-xs text-white/30">{page + 1} / {totalPages}</span>
                <button onClick={() => setPage(p => Math.min(totalPages - 1, p + 1))} disabled={page >= totalPages - 1}
                  className="px-4 py-2 rounded-xl border border-white/10 text-sm text-white/50 hover:text-white disabled:opacity-30 transition-colors">
                  Next →
                </button>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}

import { useEffect, useMemo, useRef, useState } from 'react';
import { io, Socket } from 'socket.io-client';
import logger from '../utils/logger';

const API_URL = import.meta.env.VITE_API_URL || 'http://localhost:3000';

type AgentStatus = 'idle' | 'thinking' | 'judging' | 'complete' | 'error';

interface ReasoningStep {
  step: number;
  thought: string;
  confidence: number;
  timestamp?: number;
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

interface JudgeResult {
  winner: string;
  scores: JudgeScore[];
  summary: string;
  judgedAt: string;
  judgePromptVersion?: string;
  criteriaWeights?: JudgeWeights;
  mode?: JudgeMode;
  runs?: Array<{
    panelId?: number;
    winner: string;
    summary: string;
  }>;
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

interface SkillUsageRecord {
  name: string;
  input: unknown;
  success: boolean;
  summary: string;
  durationMs: number;
  timestamp: string;
  turnIndex?: number;
  callIndex?: number;
}

interface AgentState {
  status: AgentStatus;
  persona: string;
  description: string;
  reasoning: ReasoningStep[];
  tokens: number;
  time: number;
  response: string;
  progress: number;
  isWinner: boolean;
  judgeScore?: JudgeScore;
  skillUsage: SkillUsageRecord[];
  displayTokens: number;
}

interface AgentProfile {
  id: string;
  name?: string;
  description?: string;
}

interface SkillManifest {
  name: string;
  version?: string;
  description: string;
  trigger: string;
  source?: 'workspace' | 'managed' | 'bundled';
  eligible?: boolean;
  disabledReasons?: string[];
}

type ProviderId = 'anthropic' | 'gemini' | 'openai';
type JudgeMode = 'single' | 'consensus';

interface ProviderStatus {
  provider: ProviderId;
  label: string;
  ready: boolean;
  model: string;
  reason?: string;
}

interface DomainRunMeta {
  id: string;
  label?: string;
  objectiveMode?: string;
}

const PROVIDER_MODELS: Record<ProviderId, string[]> = {
  anthropic: [
    'claude-3-5-sonnet-20241022',
    'claude-3-7-sonnet-20250219',
  ],
  gemini: [
    'gemini-2.5-flash',
    'gemini-2.5-pro',
    'gemini-2.0-flash',
    'gemini-pro-latest',
    'gemini-flash-latest',
  ],
  openai: [
    'gpt-4o-mini',
    'gpt-4.1-mini',
    'gpt-4.1',
  ],
};

const DEFAULT_JUDGE_WEIGHTS: JudgeWeights = {
  accuracy: 0.3,
  completeness: 0.3,
  clarity: 0.2,
  insight: 0.2,
};

const AGENT_META: Record<string, { persona: string; description: string; emoji: string; color: string; gradient: string }> = {
  'agent-1': {
    persona: 'The Analyst',
    description: 'Step-by-step logical decomposition',
    emoji: '🔬',
    color: 'blue',
    gradient: 'from-blue-600/20 to-blue-900/10',
  },
  'agent-2': {
    persona: 'The Lateral Thinker',
    description: 'Analogical and creative reasoning',
    emoji: '💡',
    color: 'violet',
    gradient: 'from-violet-600/20 to-violet-900/10',
  },
  'agent-3': {
    persona: "The Devil's Advocate",
    description: 'Challenge assumptions and stress-test ideas',
    emoji: '⚡',
    color: 'amber',
    gradient: 'from-amber-600/20 to-amber-900/10',
  },
};

const STATUS_CONFIG: Record<AgentStatus, { label: string; dotClass: string; ringClass: string }> = {
  idle: { label: 'Idle', dotClass: 'bg-slate-500', ringClass: '' },
  thinking: { label: 'Thinking...', dotClass: 'bg-blue-400 animate-pulse', ringClass: 'ring-2 ring-blue-500/30 animate-pulse' },
  judging: { label: 'Being Judged', dotClass: 'bg-amber-400 animate-pulse', ringClass: 'ring-2 ring-amber-500/30' },
  complete: { label: 'Complete', dotClass: 'bg-emerald-400', ringClass: '' },
  error: { label: 'Error', dotClass: 'bg-red-500', ringClass: 'ring-2 ring-red-500/30' },
};

const BAR_COLOR: Record<AgentStatus, string> = {
  idle: 'bg-slate-600',
  thinking: 'bg-gradient-to-r from-blue-500 to-cyan-400',
  judging: 'bg-gradient-to-r from-amber-500 to-orange-400',
  complete: 'bg-gradient-to-r from-emerald-500 to-green-400',
  error: 'bg-red-500',
};

function defaultAgent(agentId: string): AgentState {
  const meta = AGENT_META[agentId] || AGENT_META['agent-1'];
  return {
    status: 'idle',
    persona: meta.persona,
    description: meta.description,
    reasoning: [],
    tokens: 0,
    time: 0,
    response: '',
    progress: 0,
    isWinner: false,
    skillUsage: [],
    displayTokens: 0,
  };
}

function defaultAgents(): Record<string, AgentState> {
  return {
    'agent-1': defaultAgent('agent-1'),
    'agent-2': defaultAgent('agent-2'),
    'agent-3': defaultAgent('agent-3'),
  };
}

function nextProgress(current: number, reasoningCount: number): number {
  return Math.max(current, Math.min(90, 10 + reasoningCount * 7));
}

function normalizeWeights(weights: JudgeWeights): JudgeWeights {
  const safe = {
    accuracy: Number.isFinite(weights.accuracy) && weights.accuracy >= 0 ? weights.accuracy : 0,
    completeness: Number.isFinite(weights.completeness) && weights.completeness >= 0 ? weights.completeness : 0,
    clarity: Number.isFinite(weights.clarity) && weights.clarity >= 0 ? weights.clarity : 0,
    insight: Number.isFinite(weights.insight) && weights.insight >= 0 ? weights.insight : 0,
  };
  const total = safe.accuracy + safe.completeness + safe.clarity + safe.insight;
  if (total <= 0) return { ...DEFAULT_JUDGE_WEIGHTS };
  return {
    accuracy: Number((safe.accuracy / total).toFixed(6)),
    completeness: Number((safe.completeness / total).toFixed(6)),
    clarity: Number((safe.clarity / total).toFixed(6)),
    insight: Number((safe.insight / total).toFixed(6)),
  };
}

// ─── Sub-components ────────────────────────────────────────────────────────────

function AgentCard({
  agentId,
  agent,
  isActive,
  onClick,
}: {
  agentId: string;
  agent: AgentState;
  isActive: boolean;
  onClick: () => void;
}) {
  const meta = AGENT_META[agentId] || AGENT_META['agent-1'];
  const statusCfg = STATUS_CONFIG[agent.status];
  const barColor = BAR_COLOR[agent.status];
  const barWidth = Math.max(0, Math.min(100, Math.round(agent.progress)));

  return (
    <button
      onClick={onClick}
      className={`w-full text-left rounded-2xl border transition-all duration-300 p-5 relative overflow-hidden
        ${isActive ? 'border-white/20 shadow-lg shadow-black/40' : 'border-white/8 hover:border-white/15'}
        ${agent.isWinner ? 'ring-2 ring-emerald-500/60 border-emerald-600/40' : ''}
        bg-gradient-to-br ${meta.gradient} backdrop-blur-sm
        ${statusCfg.ringClass}
      `}
    >
      {agent.isWinner && (
        <div className="absolute top-3 right-3 text-2xl animate-bounce">🏆</div>
      )}
      <div className="flex items-center gap-3 mb-4">
        <div className="text-3xl">{meta.emoji}</div>
        <div>
          <div className="font-bold text-white text-sm">{agent.persona}</div>
          <div className="text-xs text-white/50">{agent.description}</div>
        </div>
      </div>

      <div className="flex items-center gap-2 mb-4">
        <div className={`w-2 h-2 rounded-full ${statusCfg.dotClass}`} />
        <span className="text-xs text-white/60">{statusCfg.label}</span>
      </div>

      <div className="grid grid-cols-2 gap-3 mb-4 text-center">
        <div className="bg-black/20 rounded-lg p-2">
          <div className="text-lg font-bold text-white">
            {agent.displayTokens > 0 ? agent.displayTokens.toLocaleString() : '—'}
          </div>
          <div className="text-[10px] text-white/40 uppercase tracking-wide">Tokens</div>
        </div>
        <div className="bg-black/20 rounded-lg p-2">
          <div className="text-lg font-bold text-white">
            {agent.time > 0 ? `${(agent.time / 1000).toFixed(1)}s` : '—'}
          </div>
          <div className="text-[10px] text-white/40 uppercase tracking-wide">Time</div>
        </div>
      </div>

      {agent.judgeScore !== undefined && (
        <div className="mb-3 bg-black/20 rounded-lg p-2 text-center">
          <div className="text-xl font-bold text-emerald-400">{agent.judgeScore.total}<span className="text-sm text-white/40">/40</span></div>
          <div className="text-[10px] text-white/40 uppercase tracking-wide">Judge Score</div>
        </div>
      )}

      <div className="space-y-1">
        <div className="flex justify-between text-[10px] text-white/30">
          <span>Progress</span>
          <span>{barWidth}%</span>
        </div>
        <div className="h-1.5 rounded-full bg-black/30 overflow-hidden">
          <div
            className={`h-full rounded-full transition-all duration-700 ${barColor}`}
            style={{ width: `${barWidth}%` }}
          />
        </div>
      </div>

      {agent.skillUsage.length > 0 && (
        <div className="mt-3 flex flex-wrap gap-1">
          {Array.from(new Set(agent.skillUsage.map(u => u.name))).map(name => (
            <span key={name} className="text-[10px] bg-black/30 border border-white/10 rounded px-1.5 py-0.5 text-white/50">
              🔧 {name}
            </span>
          ))}
        </div>
      )}
    </button>
  );
}

function PodiumReveal({ winner, agents, judgeResult }: {
  winner: string;
  agents: Record<string, AgentState>;
  judgeResult: JudgeResult;
}) {
  const [visible, setVisible] = useState(false);
  useEffect(() => {
    const t = setTimeout(() => setVisible(true), 100);
    return () => clearTimeout(t);
  }, []);

  const sorted = [...judgeResult.scores].sort((a, b) => b.total - a.total);

  return (
    <div className={`transition-all duration-700 ${visible ? 'opacity-100 translate-y-0' : 'opacity-0 translate-y-6'}`}>
      <div className="relative mb-2 text-center">
        <div className="text-4xl mb-1">🏆</div>
        <h2 className="text-2xl font-black text-white">
          {agents[winner]?.persona || winner} wins!
        </h2>
        <p className="text-sm text-emerald-300/80 mt-1 max-w-xl mx-auto">{judgeResult.summary}</p>
      </div>

      <div className="grid grid-cols-3 gap-3 mt-6">
        {sorted.map((score, i) => {
          const meta = AGENT_META[score.agentId] || AGENT_META['agent-1'];
          const isWinner = score.agentId === winner;
          const medals = ['🥇', '🥈', '🥉'];
          return (
            <div
              key={score.agentId}
              className={`rounded-xl border p-4 text-center transition-all duration-500 delay-${i * 100}
                ${isWinner
                  ? 'border-emerald-500/50 bg-gradient-to-b from-emerald-900/30 to-emerald-950/20'
                  : 'border-white/10 bg-black/20'}
              `}
            >
              <div className="text-2xl mb-1">{medals[i] || '🏅'}</div>
              <div className="text-lg">{meta.emoji}</div>
              <div className="font-bold text-sm text-white mt-1">{meta.persona}</div>
              <div className="text-2xl font-black mt-2 text-emerald-400">{score.total}<span className="text-sm text-white/30">/40</span></div>
              <div className="mt-2 grid grid-cols-2 gap-1 text-[10px] text-white/40">
                <span>Acc: {score.accuracy}</span>
                <span>Com: {score.completeness}</span>
                <span>Cla: {score.clarity}</span>
                <span>Ins: {score.insight}</span>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ─── Main component ─────────────────────────────────────────────────────────

export default function Dashboard() {
  const [prompt, setPrompt] = useState('');
  const [providerStatuses, setProviderStatuses] = useState<ProviderStatus[]>([]);
  const [providerLoading, setProviderLoading] = useState(false);
  const [providerError, setProviderError] = useState<string | null>(null);
  const [selectedProvider, setSelectedProvider] = useState<ProviderId>('anthropic');
  const [selectedModel, setSelectedModel] = useState('');
  const [judgeMode, setJudgeMode] = useState<JudgeMode>('single');
  const [judgeWeights, setJudgeWeights] = useState<JudgeWeights>(DEFAULT_JUDGE_WEIGHTS);
  const [judgeWeightsCustomized, setJudgeWeightsCustomized] = useState(false);
  const [judgePromptVersion, setJudgePromptVersion] = useState('judge-v2');
  const [taskId, setTaskId] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [judging, setJudging] = useState(false);
  const [winnerId, setWinnerId] = useState<string | null>(null);
  const [judgeResult, setJudgeResult] = useState<JudgeResult | null>(null);
  const [agents, setAgents] = useState<Record<string, AgentState>>(defaultAgents());
  const [activeTab, setActiveTab] = useState('agent-1');
  const [availableSkills, setAvailableSkills] = useState<SkillManifest[]>([]);
  const [selectedSkills, setSelectedSkills] = useState<string[]>([]);
  const [skillsLoading, setSkillsLoading] = useState(false);
  const [skillsError, setSkillsError] = useState<string | null>(null);
  const [activeDomain, setActiveDomain] = useState<DomainRunMeta | null>(null);

  const socketRef = useRef<Socket | null>(null);
  const taskIdRef = useRef<string | null>(null);
  const reasoningRef = useRef<HTMLDivElement | null>(null);
  const tokenAnimRef = useRef<Record<string, ReturnType<typeof setInterval>>>({});

  // Token counter animation
  const startTokenAnim = (agentId: string, target: number) => {
    if (tokenAnimRef.current[agentId]) clearInterval(tokenAnimRef.current[agentId]);
    const step = Math.ceil(target / 30);
    tokenAnimRef.current[agentId] = setInterval(() => {
      setAgents(prev => {
        const agent = prev[agentId];
        if (!agent) return prev;
        const next = Math.min(agent.displayTokens + step, target);
        const done = next >= target;
        if (done) clearInterval(tokenAnimRef.current[agentId]);
        return { ...prev, [agentId]: { ...agent, displayTokens: next } };
      });
    }, 30);
  };

  // Socket setup
  useEffect(() => {
    socketRef.current = io(API_URL, {
      reconnection: true,
      reconnectionDelay: 1000,
      reconnectionDelayMax: 5000,
    });

    socketRef.current.on('connect', () => {
      const id = taskIdRef.current;
      if (id) socketRef.current?.emit('watch_task', id);
    });

    socketRef.current.on('task_update', (update: any) => {
      if (update?.type === 'orchestration_started') {
        const incoming: Array<AgentProfile | string> = Array.isArray(update.agents) ? update.agents : [];
        const rawDomain = (update && typeof update.domain === 'object' && update.domain !== null)
          ? update.domain as DomainRunMeta
          : null;
        if (rawDomain && typeof rawDomain.id === 'string') {
          setActiveDomain({
            id: rawDomain.id,
            label: typeof rawDomain.label === 'string' ? rawDomain.label : rawDomain.id,
            objectiveMode: typeof rawDomain.objectiveMode === 'string' ? rawDomain.objectiveMode : undefined,
          });
        }
        if (update?.judge) {
          const incomingMode = update.judge.mode === 'consensus' ? 'consensus' : 'single';
          setJudgeMode(incomingMode);
          if (typeof update.judge.promptVersion === 'string') {
            setJudgePromptVersion(update.judge.promptVersion);
          }
          if (update.judge.weights && typeof update.judge.weights === 'object') {
            setJudgeWeights((prev) => ({
              accuracy: Number((update.judge.weights.accuracy ?? prev.accuracy)),
              completeness: Number((update.judge.weights.completeness ?? prev.completeness)),
              clarity: Number((update.judge.weights.clarity ?? prev.clarity)),
              insight: Number((update.judge.weights.insight ?? prev.insight)),
            }));
          }
        }
        setAgents(prev => {
          const next = { ...prev };
          for (const info of incoming) {
            const id = typeof info === 'string' ? info : info.id;
            if (!id) continue;
            const base = next[id] || defaultAgent(id);
            next[id] = {
              ...base,
              status: 'thinking',
              persona: typeof info === 'string' ? base.persona : (info.name || base.persona),
              description: typeof info === 'string' ? base.description : (info.description || base.description),
              progress: Math.max(base.progress, 5),
            };
          }
          return next;
        });
      }

      if (update?.type === 'reasoning_step') {
        const { agentId, step } = update;
        setAgents(prev => {
          const base = prev[agentId] || defaultAgent(agentId);
          const reasoning = [...base.reasoning, step];
          return {
            ...prev,
            [agentId]: {
              ...base,
              status: 'thinking',
              reasoning,
              progress: nextProgress(base.progress, reasoning.length),
            },
          };
        });
        setTimeout(() => {
          if (reasoningRef.current) {
            reasoningRef.current.scrollTo({ top: reasoningRef.current.scrollHeight, behavior: 'smooth' });
          }
        }, 30);
      }

      if (update?.type === 'agent_complete') {
        const { agentId, tokensUsed, timeMs, success, response, skillUsage } = update;
        setAgents(prev => {
          const base = prev[agentId] || defaultAgent(agentId);
          return {
            ...prev,
            [agentId]: {
              ...base,
              status: success ? 'complete' : 'error',
              tokens: tokensUsed || 0,
              time: timeMs || 0,
              response: response || base.response,
              progress: 95,
              skillUsage: Array.isArray(skillUsage) ? skillUsage : base.skillUsage,
            },
          };
        });
        if (tokensUsed > 0) startTokenAnim(agentId, tokensUsed);
      }

      if (update?.type === 'judging_started') {
        setJudging(true);
        setAgents(prev => {
          const next = { ...prev };
          for (const id of Object.keys(next)) {
            if (next[id].status === 'complete') next[id] = { ...next[id], status: 'judging', progress: 98 };
          }
          return next;
        });
      }

      if (update?.type === 'orchestration_complete') {
        const incomingJudge = update.judgeResult as JudgeResult | undefined;
        const incomingWinner = update.winner?.agentId as string | undefined;
        setJudgeResult(incomingJudge || null);
        setWinnerId(incomingWinner || null);
        setLoading(false);
        setJudging(false);
        setAgents(prev => {
          const next = { ...prev };
          const scoreMap = new Map<string, JudgeScore>(
            (incomingJudge?.scores || []).map(s => [s.agentId, s])
          );
          for (const id of Object.keys(next)) {
            next[id] = {
              ...next[id],
              status: next[id].status === 'error' ? 'error' : 'complete',
              isWinner: id === incomingWinner,
              judgeScore: scoreMap.get(id) || next[id].judgeScore,
              progress: 100,
            };
          }
          return next;
        });
        if (incomingWinner) setActiveTab(incomingWinner);
      }
    });

    return () => {
      socketRef.current?.disconnect();
      socketRef.current = null;
      Object.values(tokenAnimRef.current).forEach(clearInterval);
    };
  }, []);

  // Skills fetch
  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      setSkillsLoading(true);
      setSkillsError(null);
      try {
        const res = await fetch(`${API_URL}/api/skills`);
        if (!res.ok) throw new Error(`Skills fetch failed (${res.status})`);
        const payload = await res.json();
        const skills = Array.isArray(payload?.skills) ? payload.skills as SkillManifest[] : [];
        if (cancelled) return;
        setAvailableSkills(skills);
        setSelectedSkills(prev => prev.length > 0
          ? prev.filter(n => skills.some(s => s.name === n))
          : skills.map(s => s.name)
        );
      } catch (e) {
        if (!cancelled) setSkillsError(e instanceof Error ? e.message : 'Failed to load skills');
      } finally {
        if (!cancelled) setSkillsLoading(false);
      }
    };
    load();
    return () => { cancelled = true; };
  }, []);

  // Provider readiness/status fetch
  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      setProviderLoading(true);
      setProviderError(null);
      try {
        const response = await fetch(`${API_URL}/api/system/status`);
        if (!response.ok) {
          throw new Error(`Provider status fetch failed (${response.status})`);
        }

        const payload = await response.json();
        if (cancelled) return;

        const incomingProviders = Array.isArray(payload?.providers)
          ? payload.providers as ProviderStatus[]
          : [];
        setProviderStatuses(incomingProviders);

        const defaultProvider = payload?.defaultProvider === 'gemini'
          ? 'gemini'
          : payload?.defaultProvider === 'openai'
            ? 'openai'
            : 'anthropic';
        setSelectedProvider(defaultProvider);
        const defaults = payload?.defaults || {};
        if (typeof defaults.judgePromptVersion === 'string' && defaults.judgePromptVersion.trim()) {
          setJudgePromptVersion(defaults.judgePromptVersion.trim());
        }
        if (
          defaults.judgeWeights &&
          typeof defaults.judgeWeights === 'object' &&
          defaults.judgeWeights !== null
        ) {
          setJudgeWeights((prev) => ({
            accuracy: Number((defaults.judgeWeights.accuracy ?? prev.accuracy)),
            completeness: Number((defaults.judgeWeights.completeness ?? prev.completeness)),
            clarity: Number((defaults.judgeWeights.clarity ?? prev.clarity)),
            insight: Number((defaults.judgeWeights.insight ?? prev.insight)),
          }));
          setJudgeWeightsCustomized(false);
        }
      } catch (error) {
        if (!cancelled) {
          const message = error instanceof Error ? error.message : 'Failed to load provider status';
          setProviderError(message);
        }
      } finally {
        if (!cancelled) setProviderLoading(false);
      }
    };

    load();
    return () => { cancelled = true; };
  }, []);

  // Task ID sync
  useEffect(() => {
    taskIdRef.current = taskId;
    if (taskId && socketRef.current) socketRef.current.emit('watch_task', taskId);
  }, [taskId]);

  // Keep selected model valid for provider
  useEffect(() => {
    const configuredModel = providerStatuses.find((item) => item.provider === selectedProvider)?.model;
    const availableModels = PROVIDER_MODELS[selectedProvider];
    setSelectedModel((current) => {
      if (current && availableModels.includes(current)) return current;
      if (configuredModel && availableModels.includes(configuredModel)) return configuredModel;
      return configuredModel || availableModels[0] || '';
    });
  }, [selectedProvider, providerStatuses]);

  const orderedAgentIds = useMemo(() => Object.keys(agents).sort(), [agents]);
  const totalReasoning = useMemo(() => Object.values(agents).reduce((s, a) => s + a.reasoning.length, 0), [agents]);
  const completedCount = useMemo(() => Object.values(agents).filter(a => ['complete', 'judging', 'error'].includes(a.status)).length, [agents]);
  const totalTokens = useMemo(() => Object.values(agents).reduce((s, a) => s + a.tokens, 0), [agents]);
  const activeAgent = agents[activeTab] || agents[orderedAgentIds[0]];
  const shareUrl = taskId ? `${window.location.origin}/race/${taskId}` : null;
  const selectedProviderStatus = providerStatuses.find((item) => item.provider === selectedProvider);
  const providerReady = selectedProviderStatus?.ready ?? false;
  const judgeWeightPercent = {
    accuracy: Math.round(judgeWeights.accuracy * 100),
    completeness: Math.round(judgeWeights.completeness * 100),
    clarity: Math.round(judgeWeights.clarity * 100),
    insight: Math.round(judgeWeights.insight * 100),
  };
  const judgeWeightTotal = (
    judgeWeightPercent.accuracy +
    judgeWeightPercent.completeness +
    judgeWeightPercent.clarity +
    judgeWeightPercent.insight
  );

  const toggleSkill = (name: string) => setSelectedSkills(p => p.includes(name) ? p.filter(v => v !== name) : [...p, name]);

  const handleRunTask = async () => {
    if (!prompt.trim() || !providerReady) return;
    const normalizedJudgeWeights = normalizeWeights(judgeWeights);
    setLoading(true);
    setJudging(false);
    setTaskId(null);
    setWinnerId(null);
    setJudgeResult(null);
    setActiveDomain(null);
    setActiveTab('agent-1');
    setAgents(defaultAgents());
    Object.values(tokenAnimRef.current).forEach(clearInterval);
    tokenAnimRef.current = {};

    try {
      const res = await fetch(`${API_URL}/api/tasks`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          prompt,
          skills: selectedSkills,
          provider: selectedProvider,
          model: selectedModel || undefined,
          judgeMode,
          criteriaWeights: judgeWeightsCustomized ? normalizedJudgeWeights : undefined,
        }),
      });
      if (!res.ok) throw new Error('Failed to create task');
      const data = await res.json();
      setTaskId(data.taskId);
      socketRef.current?.emit('watch_task', data.taskId);
      logger.info(`Task created: ${data.taskId}`);
    } catch (e) {
      logger.error('Failed to create task:', e);
      setLoading(false);
      alert('Failed to create task. Check your connection and try again.');
    }
  };

  const phase = judging ? 'Judging' : loading ? 'Racing' : judgeResult ? 'Done' : 'Ready';
  const phaseColor = judging ? 'text-amber-400' : loading ? 'text-blue-400' : judgeResult ? 'text-emerald-400' : 'text-slate-400';

  return (
    <div className="min-h-screen bg-[#0a0a0f] text-white">
      {/* Ambient blobs */}
      <div className="fixed inset-0 pointer-events-none overflow-hidden">
        <div className="absolute -top-40 -left-40 w-96 h-96 bg-blue-600/10 rounded-full blur-3xl" />
        <div className="absolute top-1/3 -right-20 w-96 h-96 bg-violet-600/10 rounded-full blur-3xl" />
        <div className="absolute bottom-0 left-1/3 w-96 h-96 bg-amber-600/8 rounded-full blur-3xl" />
      </div>

      <div className="relative z-10 max-w-7xl mx-auto px-6 py-8">

        {/* Header */}
        <div className="mb-10">
          <h1 className="text-5xl font-black tracking-tight bg-gradient-to-r from-white via-white/90 to-white/50 bg-clip-text text-transparent">
            Agent Strategy Lab
          </h1>
          <p className="text-white/40 mt-2">Watch AI personas race, reason, and compete for the best answer</p>
        </div>

        {/* Input card */}
        <div className="rounded-2xl border border-white/10 bg-white/5 backdrop-blur-sm p-6 mb-6">
          <div className="mb-4 rounded-xl border border-white/8 bg-black/20 p-3">
            <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
              <div>
                <label className="block text-xs font-semibold text-white/40 uppercase tracking-widest mb-2">
                  Provider
                </label>
                <select
                  value={selectedProvider}
                  onChange={(event) => setSelectedProvider(event.target.value as ProviderId)}
                  disabled={loading || providerLoading}
                  className="w-full bg-black/30 text-white px-3 py-2.5 rounded-xl border border-white/10 focus:border-blue-500/60 focus:outline-none text-sm"
                >
                  <option value="anthropic">Anthropic Claude</option>
                  <option value="gemini">Google Gemini</option>
                  <option value="openai">OpenAI</option>
                </select>
              </div>

              <div>
                <label className="block text-xs font-semibold text-white/40 uppercase tracking-widest mb-2">
                  Model
                </label>
                <select
                  value={selectedModel}
                  onChange={(event) => setSelectedModel(event.target.value)}
                  disabled={loading || providerLoading}
                  className="w-full bg-black/30 text-white px-3 py-2.5 rounded-xl border border-white/10 focus:border-blue-500/60 focus:outline-none text-sm"
                >
                  {PROVIDER_MODELS[selectedProvider].map((model) => (
                    <option key={model} value={model}>
                      {model}
                    </option>
                  ))}
                </select>
              </div>
            </div>

            <div className="mt-3 text-xs">
              {providerLoading ? (
                <span className="text-white/40">Checking provider readiness...</span>
              ) : providerError ? (
                <span className="text-red-400">{providerError}</span>
              ) : providerReady ? (
                <span className="text-emerald-400">
                  {selectedProviderStatus?.label || selectedProvider} is ready on backend
                </span>
              ) : (
                <span className="text-amber-400">
                  {selectedProviderStatus?.reason || 'Selected provider is not configured on backend.'}
                </span>
              )}
            </div>
          </div>

          <div className="mb-4 rounded-xl border border-white/8 bg-black/20 p-3">
            <div className="flex items-center justify-between mb-3">
              <label className="text-xs font-semibold text-white/40 uppercase tracking-widest">
                Judge Settings
              </label>
              <span className={`text-[11px] ${judgeWeightTotal === 100 ? 'text-emerald-400' : 'text-amber-400'}`}>
                Weight Total: {judgeWeightTotal}%
              </span>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-2 gap-3 mb-3">
              <div>
                <label className="block text-xs font-semibold text-white/40 uppercase tracking-widest mb-2">
                  Mode
                </label>
                <select
                  value={judgeMode}
                  onChange={(event) => setJudgeMode(event.target.value as JudgeMode)}
                  disabled={loading}
                  className="w-full bg-black/30 text-white px-3 py-2.5 rounded-xl border border-white/10 focus:border-blue-500/60 focus:outline-none text-sm"
                >
                  <option value="single">Single Judge</option>
                  <option value="consensus">Consensus (3 Judges)</option>
                </select>
              </div>
              <div className="flex flex-col justify-end">
                <span className="text-xs text-white/40">
                  Prompt version: <span className="text-white/60">{judgePromptVersion}</span>
                </span>
                <button
                  onClick={() => {
                    setJudgeWeights(DEFAULT_JUDGE_WEIGHTS);
                    setJudgeWeightsCustomized(true);
                  }}
                  disabled={loading}
                  className="text-left text-xs text-blue-400 hover:text-blue-300 disabled:opacity-40 mt-2"
                >
                  Reset Weights to Default
                </button>
              </div>
            </div>

            <div className="grid grid-cols-2 md:grid-cols-4 gap-2">
              {([
                { key: 'accuracy', label: 'Accuracy' },
                { key: 'completeness', label: 'Complete' },
                { key: 'clarity', label: 'Clarity' },
                { key: 'insight', label: 'Insight' },
              ] as const).map(({ key, label }) => (
                <label key={key} className="text-xs text-white/50">
                  <span className="block mb-1">{label}</span>
                  <input
                    type="number"
                    min={0}
                    max={100}
                    step={1}
                    value={judgeWeightPercent[key]}
                    disabled={loading}
                    onChange={(event) => {
                      const parsed = Number(event.target.value);
                      const percent = Number.isFinite(parsed) ? Math.max(0, Math.min(100, Math.round(parsed))) : 0;
                      setJudgeWeights((prev) => ({
                        ...prev,
                        [key]: percent / 100,
                      }));
                      setJudgeWeightsCustomized(true);
                    }}
                    className="w-full bg-black/30 text-white px-2.5 py-1.5 rounded-lg border border-white/10 focus:border-blue-500/60 focus:outline-none"
                  />
                </label>
              ))}
            </div>
          </div>

          <textarea
            value={prompt}
            onChange={e => setPrompt(e.target.value)}
            onKeyDown={e => {
              if (e.key === 'Enter' && (e.metaKey || e.ctrlKey) && !loading && providerReady && prompt.trim()) {
                handleRunTask();
              }
            }}
            placeholder="Enter a task for all three agents to solve simultaneously... (⌘+Enter to run)"
            className="w-full h-28 bg-black/30 text-white placeholder-white/20 p-4 rounded-xl mb-4 border border-white/10 focus:border-blue-500/60 focus:outline-none resize-none text-sm leading-relaxed transition-colors"
            disabled={loading}
          />

          {/* Skill toggles */}
          <div className="mb-4">
            <div className="flex items-center justify-between mb-3">
              <span className="text-xs font-semibold text-white/40 uppercase tracking-widest">
                Active Skills ({selectedSkills.length}/{availableSkills.length})
              </span>
              <div className="flex gap-2">
                <button onClick={() => setSelectedSkills(availableSkills.map(s => s.name))}
                  disabled={loading} className="text-xs text-blue-400 hover:text-blue-300 disabled:opacity-40 transition-colors">
                  All
                </button>
                <span className="text-white/20">|</span>
                <button onClick={() => setSelectedSkills([])}
                  disabled={loading} className="text-xs text-white/40 hover:text-white/60 disabled:opacity-40 transition-colors">
                  None
                </button>
              </div>
            </div>

            {skillsLoading ? (
              <p className="text-xs text-white/30">Loading skills...</p>
            ) : skillsError ? (
              <p className="text-xs text-red-400">{skillsError}</p>
            ) : (
              <div className="flex flex-wrap gap-2">
                {availableSkills.map(skill => {
                  const checked = selectedSkills.includes(skill.name);
                  const icons: Record<string, string> = { 'web-search': '🌐', 'calculator': '🔢', 'code-executor': '💻', 'file-reader': '📄', 'workspace-shell': '🛠️' };
                  const sourceTag = skill.source ? ` • ${skill.source}` : '';
                  const versionTag = skill.version ? ` v${skill.version}` : '';
                  return (
                    <button
                      key={skill.name}
                      onClick={() => toggleSkill(skill.name)}
                      disabled={loading}
                      title={`${skill.description}${versionTag}${sourceTag}`}
                      className={`flex items-center gap-1.5 px-3 py-1.5 rounded-full text-xs font-medium border transition-all duration-200
                        ${checked
                          ? 'bg-blue-600/20 border-blue-500/50 text-blue-300'
                          : 'bg-white/5 border-white/10 text-white/40 hover:border-white/20'}
                        disabled:opacity-40 disabled:cursor-not-allowed`}
                    >
                      <span>{icons[skill.name] || '🔧'}</span>
                      {skill.name}
                      {skill.source === 'managed' && <span className="text-[10px] text-cyan-300/80">M</span>}
                      {skill.source === 'workspace' && <span className="text-[10px] text-emerald-300/80">W</span>}
                      {checked && <span className="ml-0.5 text-blue-400">✓</span>}
                    </button>
                  );
                })}
                {selectedSkills.length === 0 && availableSkills.length > 0 && (
                  <span className="text-xs text-amber-400/70 self-center">No skills — agents run without tools</span>
                )}
              </div>
            )}
          </div>

          <div className="flex items-center gap-4">
            <button
              onClick={handleRunTask}
              disabled={loading || !prompt.trim() || !providerReady}
              className={`relative px-8 py-2.5 rounded-xl font-bold text-sm transition-all duration-200 
                ${loading || !prompt.trim()
                  ? 'bg-white/10 text-white/30 cursor-not-allowed'
                  : 'bg-gradient-to-r from-blue-600 to-violet-600 hover:from-blue-500 hover:to-violet-500 text-white shadow-lg shadow-blue-900/30 hover:shadow-blue-900/50 hover:scale-[1.02] active:scale-[0.98]'}
              `}
            >
              {loading ? (
                <span className="flex items-center gap-2">
                  <span className="w-3 h-3 rounded-full border-2 border-white/30 border-t-white animate-spin" />
                  {judging ? 'Judging...' : 'Racing...'}
                </span>
              ) : 'Launch Race ⚡'}
            </button>

            {taskId && (
              <div className="flex items-center gap-3 text-xs text-white/30">
                <span>#{taskId.slice(0, 8)}</span>
                {shareUrl && (
                  <a href={shareUrl} target="_blank" rel="noreferrer"
                    className="text-blue-400/70 hover:text-blue-400 underline underline-offset-2 transition-colors">
                    Share →
                  </a>
                )}
              </div>
            )}
          </div>
        </div>

        {/* Live stats bar */}
        {(loading || judgeResult) && (
          <div className="grid grid-cols-4 gap-3 mb-6">
            {[
              { label: 'Phase', value: phase, valueClass: phaseColor },
              { label: 'Finished', value: `${completedCount}/3`, valueClass: 'text-white' },
              { label: 'Reasoning Steps', value: totalReasoning.toString(), valueClass: 'text-blue-300' },
              { label: 'Total Tokens', value: totalTokens > 0 ? totalTokens.toLocaleString() : '—', valueClass: 'text-violet-300' },
            ].map(stat => (
              <div key={stat.label} className="rounded-xl border border-white/8 bg-white/5 p-4 text-center">
                <div className={`text-xl font-black ${stat.valueClass}`}>{stat.value}</div>
                <div className="text-[10px] text-white/30 uppercase tracking-widest mt-1">{stat.label}</div>
              </div>
            ))}
          </div>
        )}
        {(loading || judgeResult) && activeDomain && (
          <div className="-mt-3 mb-6 text-xs text-cyan-300/75">
            Domain: <span className="text-cyan-200">{activeDomain.label || activeDomain.id}</span>
            {activeDomain.objectiveMode && activeDomain.objectiveMode !== 'none' && (
              <span className="text-cyan-400/90"> • Objective judge: {activeDomain.objectiveMode}</span>
            )}
          </div>
        )}

        {/* Podium reveal */}
        {judgeResult && winnerId && (
          <div className="rounded-2xl border border-emerald-700/30 bg-gradient-to-br from-emerald-950/40 to-black/40 backdrop-blur-sm p-6 mb-6">
            <PodiumReveal winner={winnerId} agents={agents} judgeResult={judgeResult} />
            <div className="mt-4 pt-4 border-t border-white/10 text-xs text-white/45 flex flex-wrap gap-x-4 gap-y-2">
              <span>Mode: <span className="text-white/65">{judgeResult.mode || judgeMode}</span></span>
              <span>Prompt: <span className="text-white/65">{judgeResult.judgePromptVersion || judgePromptVersion}</span></span>
              {judgeResult.criteriaWeights && (
                <span>
                  Weights:
                  <span className="text-white/65 ml-1">
                    A {Math.round(judgeResult.criteriaWeights.accuracy * 100)}%
                    {' '}C {Math.round(judgeResult.criteriaWeights.completeness * 100)}%
                    {' '}Cl {Math.round(judgeResult.criteriaWeights.clarity * 100)}%
                    {' '}I {Math.round(judgeResult.criteriaWeights.insight * 100)}%
                  </span>
                </span>
              )}
              {judgeResult.runs && judgeResult.runs.length > 0 && (
                <span>Panels: <span className="text-white/65">{judgeResult.runs.length}</span></span>
              )}
            </div>
          </div>
        )}

        {/* Agent cards grid */}
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4 mb-6">
          {orderedAgentIds.map(id => (
            <AgentCard
              key={id}
              agentId={id}
              agent={agents[id]}
              isActive={activeTab === id}
              onClick={() => setActiveTab(id)}
            />
          ))}
        </div>

        {/* Detail panel */}
        <div className="rounded-2xl border border-white/8 bg-white/4 backdrop-blur-sm overflow-hidden">
          {/* Tab bar */}
          <div className="flex border-b border-white/8 bg-black/20 px-4 pt-4 gap-2">
            {orderedAgentIds.map(id => {
              const meta = AGENT_META[id] || AGENT_META['agent-1'];
              const agent = agents[id];
              const isActive = activeTab === id;
              return (
                <button
                  key={id}
                  onClick={() => setActiveTab(id)}
                  className={`flex items-center gap-2 px-4 py-2.5 rounded-t-lg text-sm font-medium border-t border-l border-r transition-all
                    ${isActive
                      ? 'bg-white/8 border-white/15 text-white'
                      : 'bg-transparent border-transparent text-white/40 hover:text-white/60 hover:bg-white/4'}
                  `}
                >
                  <span>{meta.emoji}</span>
                  <span>{meta.persona}</span>
                  {agent.isWinner && <span>🏆</span>}
                  <div className={`w-1.5 h-1.5 rounded-full ml-1 ${STATUS_CONFIG[agent.status].dotClass}`} />
                </button>
              );
            })}
          </div>

          {activeAgent && (
            <div className="p-6 grid grid-cols-1 lg:grid-cols-2 gap-6">
              {/* Reasoning stream */}
              <div>
                <div className="flex items-center justify-between mb-3">
                  <span className="text-xs font-semibold text-white/40 uppercase tracking-widest">
                    Live Reasoning
                  </span>
                  <span className="text-xs text-white/20">{activeAgent.reasoning.length} steps</span>
                </div>
                <div
                  ref={el => {
                    if (el && activeTab === activeTab) reasoningRef.current = el;
                  }}
                  className="h-80 overflow-y-auto space-y-2 rounded-xl bg-black/30 border border-white/5 p-3 scroll-smooth"
                >
                  {activeAgent.reasoning.length === 0 ? (
                    <div className="flex items-center justify-center h-full text-white/20 text-sm">
                      {activeAgent.status === 'idle' ? 'Waiting to start...' : 'Awaiting reasoning...'}
                    </div>
                  ) : (
                    activeAgent.reasoning.map(step => (
                      <div key={`${step.step}-${step.timestamp}`} className="rounded-lg bg-white/5 border border-white/5 p-3 text-xs leading-relaxed">
                        <div className="flex items-center gap-2 mb-1.5">
                          <span className="text-blue-400/60 font-mono font-bold">#{step.step}</span>
                          <div className="flex-1 h-px bg-white/5" />
                          <span className="text-white/20">{(step.confidence * 100).toFixed(0)}% conf</span>
                        </div>
                        <p className="text-white/70 break-words">{step.thought}</p>
                        <div className="mt-1.5 h-0.5 rounded bg-black/30 overflow-hidden">
                          <div className="h-full bg-blue-500/40 rounded" style={{ width: `${step.confidence * 100}%` }} />
                        </div>
                      </div>
                    ))
                  )}
                </div>
              </div>

              {/* Response & scores */}
              <div className="space-y-4">
                <div>
                  <div className="flex items-center gap-2 mb-3">
                    <span className="text-xs font-semibold text-white/40 uppercase tracking-widest">
                      Final Response
                    </span>
                    {activeAgent.isWinner && <span className="text-xs bg-emerald-900/40 border border-emerald-700/40 text-emerald-400 px-2 py-0.5 rounded-full">Winner</span>}
                  </div>
                  <div className="h-52 overflow-y-auto rounded-xl bg-black/30 border border-white/5 p-4 text-sm text-white/70 leading-relaxed whitespace-pre-wrap break-words">
                    {activeAgent.response || (
                      activeAgent.status === 'judging'
                        ? <span className="text-amber-300/60">Being evaluated by judge...</span>
                        : <span className="text-white/20">Response will appear here...</span>
                    )}
                  </div>
                </div>

                {activeAgent.judgeScore && (
                  <div className="rounded-xl bg-black/20 border border-white/5 p-4">
                    <p className="text-xs font-semibold text-white/40 uppercase tracking-widest mb-3">Judge Evaluation</p>
                    <p className="text-xs text-white/50 mb-3 leading-relaxed">{activeAgent.judgeScore.reasoning}</p>
                    <div className="grid grid-cols-2 gap-2">
                      {[
                        { label: 'Accuracy', val: activeAgent.judgeScore.accuracy },
                        { label: 'Completeness', val: activeAgent.judgeScore.completeness },
                        { label: 'Clarity', val: activeAgent.judgeScore.clarity },
                        { label: 'Insight', val: activeAgent.judgeScore.insight },
                      ].map(({ label, val }) => (
                        <div key={label} className="text-xs">
                          <div className="flex justify-between text-white/40 mb-1">
                            <span>{label}</span><span>{val}/10</span>
                          </div>
                          <div className="h-1 rounded-full bg-black/30">
                            <div className="h-full rounded-full bg-gradient-to-r from-blue-500 to-violet-500 transition-all duration-500"
                              style={{ width: `${val * 10}%` }} />
                          </div>
                        </div>
                      ))}
                    </div>
                    {activeAgent.judgeScore.diversityPenaltyApplied && (
                      <p className="mt-3 text-[11px] text-amber-300/80">
                        Diversity penalty applied due to high similarity ({Math.round((activeAgent.judgeScore.maxSimilarity || 0) * 100)}%).
                      </p>
                    )}
                    <div className="mt-3 pt-3 border-t border-white/5 text-center">
                      {typeof activeAgent.judgeScore.baseTotal === 'number' && activeAgent.judgeScore.baseTotal !== activeAgent.judgeScore.total && (
                        <div className="text-xs text-white/35 mb-1">
                          Base: {activeAgent.judgeScore.baseTotal}/40
                        </div>
                      )}
                      <span className="text-2xl font-black text-white">{activeAgent.judgeScore.total}</span>
                      <span className="text-white/30 text-sm">/40</span>
                    </div>
                    {activeAgent.judgeScore.metricEvidence && (
                      <div className="mt-4 pt-3 border-t border-white/5 space-y-2">
                        {(Object.entries(activeAgent.judgeScore.metricEvidence) as Array<[keyof JudgeScore['metricEvidence'], MetricEvidence]>).map(([metric, evidence]) => (
                          <div key={metric} className="text-[11px] bg-white/5 rounded-md border border-white/8 p-2">
                            <p className="text-white/45 uppercase tracking-widest mb-1">{metric}</p>
                            <p className="text-white/65 italic">"{evidence.quote}"</p>
                            <p className="text-white/40 mt-1">{evidence.reason}</p>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                )}

                {activeAgent.skillUsage.length > 0 && (
                  <div className="rounded-xl bg-black/20 border border-white/5 p-4">
                    <p className="text-xs font-semibold text-white/40 uppercase tracking-widest mb-3">Skills Used</p>
                    <div className="space-y-2">
                      {activeAgent.skillUsage.map((usage, i) => (
                        <div key={`${usage.name}-${i}`} className="flex items-start gap-2 text-xs rounded-lg bg-white/5 p-2 border border-white/5">
                          <span className={`mt-0.5 w-1.5 h-1.5 rounded-full flex-shrink-0 ${usage.success ? 'bg-emerald-400' : 'bg-red-400'}`} />
                          <div>
                            <span className="font-semibold text-white/70">{usage.name}</span>
                            <span className="text-white/30 ml-2">{usage.durationMs}ms</span>
                            {typeof usage.callIndex === 'number' && (
                              <span className="text-white/30 ml-2">#{usage.callIndex}</span>
                            )}
                            {typeof usage.turnIndex === 'number' && (
                              <span className="text-white/30 ml-2">turn {usage.turnIndex}</span>
                            )}
                            <p className="text-white/40 mt-0.5 leading-snug">{usage.summary}</p>
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            </div>
          )}
        </div>

      </div>
    </div>
  );
}

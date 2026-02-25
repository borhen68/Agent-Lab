import React from 'react';

interface AgentCardProps {
  agentId: string;
  status: 'idle' | 'thinking' | 'judging' | 'complete' | 'error';
  tokens: number;
  time: number;
  persona?: string;
  progress?: number;
  isWinner?: boolean;
  judgeScore?: number;
}

const statusColors = {
  idle: 'bg-gray-600',
  thinking: 'bg-blue-500 animate-pulse',
  judging: 'bg-amber-500 animate-pulse',
  complete: 'bg-green-500',
  error: 'bg-red-500',
};

const statusLabels = {
  idle: 'Idle',
  thinking: 'Thinking...',
  judging: 'Judging...',
  complete: 'Complete',
  error: 'Error',
};

export default function AgentCard({
  agentId,
  status,
  tokens,
  time,
  persona,
  progress = 0,
  isWinner = false,
  judgeScore,
}: AgentCardProps) {
  const barWidth = Math.max(0, Math.min(100, Math.round(progress)));

  return (
    <div
      className={`bg-slate-800 border p-6 rounded-lg transition ${
        isWinner ? 'border-green-600 shadow-[0_0_0_1px_rgba(22,163,74,0.35)]' : 'border-slate-700 hover:border-slate-600'
      }`}
    >
      <h3 className="text-xl font-bold mb-1">{agentId}</h3>
      {persona && <p className="text-sm text-gray-400 mb-4">{persona}</p>}

      <div className="space-y-3">
        <div>
          <p className="text-sm text-gray-400 mb-1">Status</p>
          <div className="flex items-center gap-2">
            <div className={`w-3 h-3 rounded-full ${statusColors[status]}`}></div>
            <span className="font-medium">{statusLabels[status]}</span>
          </div>
        </div>

        <div>
          <p className="text-sm text-gray-400 mb-1">Tokens Used</p>
          <p className="text-lg font-bold">{tokens > 0 ? tokens : '-'}</p>
        </div>

        <div>
          <p className="text-sm text-gray-400 mb-1">Time (ms)</p>
          <p className="text-lg font-bold">{time > 0 ? time : '-'}</p>
        </div>

        <div>
          <p className="text-sm text-gray-400 mb-1">Progress</p>
          <p className="text-lg font-bold">{barWidth}%</p>
        </div>

        {judgeScore !== undefined && (
          <div>
            <p className="text-sm text-gray-400 mb-1">Judge Total</p>
            <p className="text-lg font-bold">{judgeScore}/40</p>
          </div>
        )}
      </div>

      <div className="mt-4 h-2 bg-slate-700 rounded overflow-hidden">
        <div
          className={`h-full ${statusColors[status]} transition-all duration-300`}
          style={{ width: `${barWidth}%` }}
        ></div>
      </div>

      {isWinner && (
        <div className="mt-3 text-xs font-bold text-green-400 uppercase tracking-wide">Winner</div>
      )}
    </div>
  );
}

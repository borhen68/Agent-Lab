import React from 'react';

interface ReasoningStep {
  step: number;
  thought: string;
  confidence: number;
}

interface ReasoningViewProps {
  agentId: string;
  steps: ReasoningStep[];
  persona?: string;
  status?: 'idle' | 'thinking' | 'judging' | 'complete' | 'error';
  isWinner?: boolean;
  judgeScore?: number;
}

const statusLabel: Record<NonNullable<ReasoningViewProps['status']>, string> = {
  idle: 'Idle',
  thinking: 'Thinking...',
  judging: 'Judging...',
  complete: 'Complete',
  error: 'Error',
};

const statusDot: Record<NonNullable<ReasoningViewProps['status']>, string> = {
  idle: 'bg-slate-500',
  thinking: 'bg-blue-500 animate-pulse',
  judging: 'bg-amber-500 animate-pulse',
  complete: 'bg-green-500',
  error: 'bg-red-500',
};

export default function ReasoningView({
  agentId,
  steps,
  persona,
  status = 'idle',
  isWinner = false,
  judgeScore,
}: ReasoningViewProps) {
  return (
    <div
      className={`bg-slate-800 border p-6 rounded-lg ${
        isWinner ? 'border-green-600' : 'border-slate-700'
      }`}
    >
      <div className="flex items-center justify-between gap-3 mb-4">
        <div>
          <h3 className="text-lg font-bold">{agentId} Reasoning</h3>
          {persona && <p className="text-xs text-gray-400 mt-1">{persona}</p>}
        </div>
        <div className="text-right">
          <div className="flex items-center justify-end gap-2">
            <span className={`w-2.5 h-2.5 rounded-full ${statusDot[status]}`}></span>
            <span className="text-xs text-gray-300">{statusLabel[status]}</span>
          </div>
          {judgeScore !== undefined && (
            <p className="text-xs text-gray-400 mt-1">Judge: {judgeScore}/40</p>
          )}
        </div>
      </div>

      <div className="space-y-3 max-h-96 overflow-y-auto">
        {steps.length === 0 ? (
          <p className="text-gray-500 text-sm">Waiting for agent to start thinking...</p>
        ) : (
          steps.map((step, i) => (
            <div key={i} className="bg-slate-700 p-3 rounded border border-slate-600">
              <p className="text-blue-400 text-sm font-bold">Step {step.step}</p>
              <p className="text-white text-sm mt-1 break-words">{step.thought}</p>
              <p className="text-gray-500 text-xs mt-2">
                Confidence: {(step.confidence * 100).toFixed(0)}%
              </p>
            </div>
          ))
        )}
      </div>
    </div>
  );
}

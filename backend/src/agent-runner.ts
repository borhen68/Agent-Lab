import Anthropic from '@anthropic-ai/sdk';
import { config } from './config';
import logger from './logger';
import { SkillRegistry } from './skills/registry';
import type { SkillToolCallRecord } from './skills/types';
import type { ReplayConfig } from './orchestrator';
import {
  defaultModelForProvider,
  LLMProvider,
  normalizeProvider,
  resolveProviderApiKey,
} from './llm/provider';

export interface ReasoningStep {
  step: number;
  thought: string;
  confidence: number;
  timestamp: number;
}

export interface AgentRunResult {
  agentId: string;
  response: string;
  reasoning: ReasoningStep[];
  tokensUsed: number;
  timeMs: number;
  success: boolean;
  error?: string;
  persona: string;
  skillUsage: SkillToolCallRecord[];
  telemetry: AgentTelemetry;
}

export interface AgentRunOptions {
  timeout?: number;
  maxTurns?: number;
  activeSkills?: string[];
  skillRegistry?: SkillRegistry;
  apiKey?: string;
  provider?: LLMProvider | string;
  model?: string;
  replayMode?: boolean;
  replayContext?: ReplayConfig;
}

export interface AgentPersona {
  name: string;
  description: string;
  systemPrompt: string;
}

export interface AgentTelemetry {
  toolCallCount: number;
  successfulToolCalls: number;
  verificationSteps: number;
  firstToolName?: string;
  firstToolTurn?: number;
  usedSearchFirst: boolean;
  toolSequence: string[];
}

export const AGENT_PERSONAS: Record<string, AgentPersona> = {
  'agent-1': {
    name: 'The Analyst',
    description: 'Step-by-step logical decomposition',
    systemPrompt: `You are a methodical analyst. Break every problem into explicit steps.
Think sequentially: first principles -> sub-problems -> solution.
Label your reasoning clearly. Be precise and structured.
Behavior contract:
- Prioritize deterministic verification for numbers/code claims (calculator/code-executor when available).
- If uncertain, state uncertainty and gather evidence before concluding.
Format your final answer with clear sections.`,
  },
  'agent-2': {
    name: 'The Lateral Thinker',
    description: 'Analogical and creative reasoning',
    systemPrompt: `You are a lateral thinker. Approach problems through analogies, patterns, and creative connections.
Ask: "What is this similar to?" and "What is the unexpected angle?"
Challenge obvious assumptions. Look for non-obvious insights.
Behavior contract:
- Generate at least two alternative framings before selecting a final approach.
- For fact-sensitive tasks, prefer evidence gathering first (web-search/file-reader when available).
Format your final answer conversationally but insightfully.`,
  },
  'agent-3': {
    name: "The Devil's Advocate",
    description: 'Challenge assumptions and stress-test ideas',
    systemPrompt: `You are a critical thinker who stress-tests ideas.
Start by identifying what could be wrong or oversimplified about the obvious answer.
Challenge assumptions. Consider edge cases and counterarguments.
Then synthesize a robust answer that accounts for these challenges.
Behavior contract:
- Explicitly list assumptions and failure modes before giving recommendations.
- Run at least one verification step where possible (calculator/code-executor/file-reader/web-search).
Format your final answer with explicit tradeoffs.`,
  },
};

function estimateConfidence(thought: string, step: number): number {
  let score = 0.62;

  if (thought.length > 80) score += 0.08;
  if (thought.length > 140) score += 0.05;
  if (/[0-9]/.test(thought)) score += 0.03;
  if (/\b(because|therefore|however|assume|constraint|tradeoff|evidence|risk|verify|edge case)\b/i.test(thought)) {
    score += 0.12;
  }
  if (/\?/.test(thought)) score -= 0.04;
  if (step <= 2) score += 0.03;

  return Math.max(0.55, Math.min(0.95, Number(score.toFixed(2))));
}

function extractReasoningCandidates(value: string): string[] {
  return value
    .split('\n')
    .flatMap((line) => line.split(/(?<=[.!?])\s+/))
    .map((chunk) => chunk.trim())
    .filter((chunk) => chunk.length >= 20);
}

function getTextBlocks(content: any[]): string[] {
  return content
    .filter((block) => block?.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text as string);
}

function getThinkingBlocks(content: any[]): string[] {
  return content
    .filter((block) => block?.type === 'thinking' && typeof block.thinking === 'string')
    .map((block) => block.thinking as string);
}

function getToolUseBlocks(content: any[]): any[] {
  return content.filter((block) => block?.type === 'tool_use');
}

const VERIFICATION_SKILLS = new Set([
  'web-search',
  'calculator',
  'code-executor',
  'file-reader',
]);

function buildTelemetry(skillUsage: SkillToolCallRecord[]): AgentTelemetry {
  const firstCall = skillUsage[0];
  return {
    toolCallCount: skillUsage.length,
    successfulToolCalls: skillUsage.filter((record) => record.success).length,
    verificationSteps: skillUsage.filter((record) => VERIFICATION_SKILLS.has(record.name)).length,
    firstToolName: firstCall?.name,
    firstToolTurn: firstCall?.turnIndex,
    usedSearchFirst: firstCall?.name === 'web-search',
    toolSequence: skillUsage.map((record) => record.name),
  };
}

function buildReplayGuidanceBlock(replayContext?: ReplayConfig): string {
  if (!replayContext) return '';

  const reasoningSteps = replayContext.reasoningPath
    .slice(0, 6)
    .map((step, index) => `${index + 1}. ${step}`)
    .join('\n');

  const toolSequence = replayContext.toolSequence.length > 0
    ? replayContext.toolSequence.join(' -> ')
    : 'no-tools';

  return [
    'Replay guidance mode is enabled for this run.',
    `Reference race: ${replayContext.sourceTaskId}`,
    `Reference strategy: ${replayContext.sourceStrategyId || 'n/a'}`,
    `Reference persona: ${replayContext.sourcePersona || replayContext.sourceAgentId}`,
    `Reference tool sequence: ${toolSequence}`,
    'Reference reasoning path (adapt to current prompt, do not copy blindly):',
    reasoningSteps || '1. no reasoning path provided',
    'Instruction: start from this prior strategy, then adapt based on current task details and tool outputs.',
  ].join('\n');
}

async function createGeminiResponse(
  apiKey: string,
  model: string,
  payload: Record<string, unknown>
): Promise<any> {
  const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(apiKey)}`;
  const response = await fetch(endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });

  const json = await response.json().catch(() => ({}));
  if (!response.ok) {
    const detail = typeof json?.error?.message === 'string'
      ? json.error.message
      : response.statusText;
    throw new Error(`Gemini request failed (${response.status}): ${detail}`);
  }

  return json;
}

async function createOpenAIResponse(
  apiKey: string,
  payload: Record<string, unknown>
): Promise<any> {
  const endpoint = 'https://api.openai.com/v1/chat/completions';
  const response = await fetch(endpoint, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify(payload),
  });

  const json = await response.json().catch(() => ({}));
  if (!response.ok) {
    const detail = typeof json?.error?.message === 'string'
      ? json.error.message
      : response.statusText;
    throw new Error(`OpenAI request failed (${response.status}): ${detail}`);
  }

  return json;
}

function parseToolArgs(value: unknown): Record<string, unknown> {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }

  if (typeof value !== 'string' || !value.trim()) return {};
  try {
    const parsed = JSON.parse(value);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    return {};
  }

  return {};
}

function extractOpenAITextContent(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';

  return content
    .map((item) => {
      if (!item || typeof item !== 'object') return '';
      const record = item as Record<string, unknown>;
      if (typeof record.text === 'string') return record.text;
      if (record.type === 'text' && typeof record.content === 'string') return record.content;
      return '';
    })
    .filter(Boolean)
    .join('\n');
}

export async function runAgent(
  agentId: string,
  taskPrompt: string,
  onReasoningStep?: (step: ReasoningStep) => void,
  options: AgentRunOptions = {}
): Promise<AgentRunResult> {
  const timeout = options.timeout ?? config.AGENT_TIMEOUT_MS;
  const maxTurns = options.maxTurns ?? 8;
  const provider = normalizeProvider(
    typeof options.provider === 'string' ? options.provider : undefined
  );
  const model = options.model?.trim() || defaultModelForProvider(provider);
  const apiKey = resolveProviderApiKey(provider, options.apiKey);

  const startTime = Date.now();
  const reasoning: ReasoningStep[] = [];
  const skillUsage: SkillToolCallRecord[] = [];
  let toolCallIndex = 0;
  let stepCount = 0;
  const persona = AGENT_PERSONAS[agentId] ?? AGENT_PERSONAS['agent-1'];

  if (!apiKey) {
    return {
      agentId,
      response: '',
      reasoning,
      tokensUsed: 0,
      timeMs: Date.now() - startTime,
      success: false,
      error: `Provider ${provider} is not configured. Missing API key.`,
      persona: persona.name,
      skillUsage,
      telemetry: buildTelemetry(skillUsage),
    };
  }

  const timeoutPromise = new Promise<AgentRunResult>((_, reject) => {
    setTimeout(() => {
      reject(new Error(`Agent ${agentId} timeout after ${timeout}ms`));
    }, timeout);
  });

  try {
    const responsePromise = (async () => {
      logger.debug(
        `Agent ${agentId} (${persona.name}): Starting task with ${provider}/${model}`
      );

      const skillRegistry =
        options.skillRegistry ?? (await SkillRegistry.create(options.activeSkills));

      const replayGuidance =
        options.replayMode && options.replayContext
          ? buildReplayGuidanceBlock(options.replayContext)
          : '';

      const systemPrompt = [
        persona.systemPrompt,
        replayGuidance,
        '',
        skillRegistry.buildSystemPromptSection(),
        '',
        'When you use a skill, explain briefly why it helps and how you used its output.',
      ].join('\n');

      let finalResponse = '';
      let totalTokens = 0;

      const pushReasoning = (thought: string) => {
        const clean = thought.trim();
        if (clean.length < 20) return;

        stepCount += 1;
        const step: ReasoningStep = {
          step: stepCount,
          thought: clean,
          confidence: estimateConfidence(clean, stepCount),
          timestamp: Date.now(),
        };
        reasoning.push(step);
        onReasoningStep?.(step);
      };

      if (provider === 'anthropic') {
        const client = new Anthropic({ apiKey });
        const tools = skillRegistry.toAnthropicTools();
        const messages: any[] = [{ role: 'user', content: taskPrompt }];

        for (let turn = 0; turn < maxTurns; turn += 1) {
          const response: any = await client.messages.create({
            model,
            max_tokens: 4000,
            thinking: {
              type: 'enabled',
              budget_tokens: 2500,
            },
            system: systemPrompt,
            tools: tools as any,
            messages,
          });

          totalTokens +=
            (response?.usage?.input_tokens ?? 0) +
            (response?.usage?.output_tokens ?? 0);

          const content: any[] = Array.isArray(response.content) ? response.content : [];

          for (const thinkingText of getThinkingBlocks(content)) {
            for (const thought of extractReasoningCandidates(thinkingText)) {
              pushReasoning(thought);
            }
          }

          const textBlocks = getTextBlocks(content);
          if (textBlocks.length > 0) {
            finalResponse += `${textBlocks.join('\n')}\n`;
          }

          const toolUses = getToolUseBlocks(content);
          messages.push({ role: 'assistant', content });

          if (toolUses.length === 0) break;

          const toolResults = [];

          for (const toolUse of toolUses) {
            const execution = await skillRegistry.execute(
              toolUse.name,
              toolUse.input,
              { agentId, taskPrompt }
            );

            toolCallIndex += 1;
            const usageRecord: SkillToolCallRecord = {
              ...execution.record,
              turnIndex: turn + 1,
              callIndex: toolCallIndex,
            };
            skillUsage.push(usageRecord);
            pushReasoning(`[Skill ${toolUse.name}] ${execution.summary}`);

            const serializedResult = JSON.stringify(
              execution.success
                ? execution.data
                : { error: execution.error ?? execution.summary, data: execution.data }
            );

            toolResults.push({
              type: 'tool_result',
              tool_use_id: toolUse.id,
              content: serializedResult.length > 12000
                ? `${serializedResult.slice(0, 12000)}...[truncated]`
                : serializedResult,
            });
          }

          messages.push({ role: 'user', content: toolResults });
        }
      } else if (provider === 'gemini') {
        const tools = skillRegistry.toGeminiTools();
        const messages: Array<{ role: 'user' | 'model'; parts: Array<Record<string, unknown>> }> = [
          {
            role: 'user',
            parts: [{ text: taskPrompt }],
          },
        ];

        for (let turn = 0; turn < maxTurns; turn += 1) {
          const payload: Record<string, unknown> = {
            system_instruction: {
              parts: [{ text: systemPrompt }],
            },
            contents: messages,
            generationConfig: {
              maxOutputTokens: 4000,
              temperature: 0.7,
            },
          };
          if (tools.length > 0) {
            payload.tools = tools;
          }

          const response = await createGeminiResponse(apiKey, model, payload);
          totalTokens += Number(response?.usageMetadata?.promptTokenCount ?? 0);
          totalTokens += Number(response?.usageMetadata?.candidatesTokenCount ?? 0);

          const parts: any[] = Array.isArray(response?.candidates?.[0]?.content?.parts)
            ? response.candidates[0].content.parts
            : [];

          const textBlocks = parts
            .filter((part) => typeof part?.text === 'string')
            .map((part) => String(part.text));

          if (textBlocks.length > 0) {
            finalResponse += `${textBlocks.join('\n')}\n`;
            for (const text of textBlocks) {
              for (const thought of extractReasoningCandidates(text).slice(0, 2)) {
                pushReasoning(thought);
              }
            }
          }

          messages.push({
            role: 'model',
            parts,
          });

          const toolUses = parts.flatMap((part, index) => {
            const functionCall = part?.functionCall;
            if (!functionCall || typeof functionCall.name !== 'string') return [];
            return [
              {
                id: `gemini-${turn}-${index}-${functionCall.name}`,
                name: functionCall.name,
                input: functionCall.args ?? {},
              },
            ];
          });

          if (toolUses.length === 0) {
            break;
          }

          const toolResultParts: Array<Record<string, unknown>> = [];

          for (const toolUse of toolUses) {
            const execution = await skillRegistry.execute(
              toolUse.name,
              toolUse.input,
              { agentId, taskPrompt }
            );

            toolCallIndex += 1;
            const usageRecord: SkillToolCallRecord = {
              ...execution.record,
              turnIndex: turn + 1,
              callIndex: toolCallIndex,
            };
            skillUsage.push(usageRecord);
            pushReasoning(`[Skill ${toolUse.name}] ${execution.summary}`);

            toolResultParts.push({
              functionResponse: {
                name: toolUse.name,
                response: execution.success
                  ? execution.data
                  : { error: execution.error ?? execution.summary, data: execution.data },
              },
            });
          }

          messages.push({
            role: 'user',
            parts: toolResultParts,
          });
        }
      } else {
        const tools = skillRegistry.toOpenAITools();
        const messages: any[] = [{ role: 'user', content: taskPrompt }];

        for (let turn = 0; turn < maxTurns; turn += 1) {
          const payload: Record<string, unknown> = {
            model,
            temperature: 0.7,
            max_tokens: 4000,
            messages: [
              { role: 'system', content: systemPrompt },
              ...messages,
            ],
          };

          if (tools.length > 0) {
            payload.tools = tools;
            payload.tool_choice = 'auto';
          }

          const response = await createOpenAIResponse(apiKey, payload);
          totalTokens += Number(response?.usage?.prompt_tokens ?? 0);
          totalTokens += Number(response?.usage?.completion_tokens ?? 0);

          const message = response?.choices?.[0]?.message || {};
          const text = extractOpenAITextContent(message.content);
          if (text) {
            finalResponse += `${text}\n`;
            for (const thought of extractReasoningCandidates(text).slice(0, 2)) {
              pushReasoning(thought);
            }
          }

          const toolCalls: any[] = Array.isArray(message?.tool_calls) ? message.tool_calls : [];
          messages.push({
            role: 'assistant',
            content: typeof message.content === 'string' ? message.content : null,
            ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
          });

          if (toolCalls.length === 0) {
            break;
          }

          for (const toolCall of toolCalls) {
            const toolName = toolCall?.function?.name;
            if (typeof toolName !== 'string' || !toolName.trim()) continue;

            const toolInput = parseToolArgs(toolCall?.function?.arguments);
            const execution = await skillRegistry.execute(
              toolName,
              toolInput,
              { agentId, taskPrompt }
            );

            toolCallIndex += 1;
            const usageRecord: SkillToolCallRecord = {
              ...execution.record,
              turnIndex: turn + 1,
              callIndex: toolCallIndex,
            };
            skillUsage.push(usageRecord);
            pushReasoning(`[Skill ${toolName}] ${execution.summary}`);

            const serializedResult = JSON.stringify(
              execution.success
                ? execution.data
                : { error: execution.error ?? execution.summary, data: execution.data }
            );

            messages.push({
              role: 'tool',
              tool_call_id: toolCall.id,
              content: serializedResult.length > 12000
                ? `${serializedResult.slice(0, 12000)}...[truncated]`
                : serializedResult,
            });
          }
        }
      }

      finalResponse = finalResponse.trim();

      if (!finalResponse) {
        finalResponse = 'No final text response was produced.';
      }

      if (reasoning.length === 0) {
        for (const thought of extractReasoningCandidates(finalResponse).slice(0, 3)) {
          pushReasoning(thought);
        }
      }

      logger.debug(
        `Agent ${agentId} (${persona.name}) completed with ${provider}/${model}, ${totalTokens} tokens, ${reasoning.length} reasoning steps, ${skillUsage.length} skill calls`
      );

      return {
        agentId,
        response: finalResponse,
        reasoning,
        tokensUsed: totalTokens,
        timeMs: Date.now() - startTime,
        success: true,
        persona: persona.name,
        skillUsage,
        telemetry: buildTelemetry(skillUsage),
      };
    })();

    return await Promise.race([responsePromise, timeoutPromise]);
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    logger.error(`Agent ${agentId} error:`, errorMessage);

    return {
      agentId,
      response: '',
      reasoning,
      tokensUsed: 0,
      timeMs: Date.now() - startTime,
      success: false,
      error: errorMessage,
      persona: persona.name,
      skillUsage,
      telemetry: buildTelemetry(skillUsage),
    };
  }
}

import type { SkillExecutionResult, SkillHandler } from '../../src/skills/types';

export const inputSchema = {
  type: 'object',
  properties: {
    expression: { type: 'string', minLength: 1, maxLength: 200 },
  },
  required: ['expression'],
  additionalProperties: false,
};

const ALLOWED_EXPRESSION = /^[0-9+\-*/().%\s^]+$/;

function safeEvaluate(expression: string): number {
  const trimmed = expression.trim();

  if (!trimmed) {
    throw new Error('Expression is empty.');
  }

  if (!ALLOWED_EXPRESSION.test(trimmed)) {
    throw new Error('Expression contains unsupported characters.');
  }

  const normalized = trimmed.replace(/\^/g, '**');
  const value = Function(`"use strict"; return (${normalized});`)();

  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new Error('Expression did not evaluate to a finite number.');
  }

  return value;
}

export const handler: SkillHandler = async (input): Promise<SkillExecutionResult> => {
  const payload = (input || {}) as Record<string, unknown>;
  const expression = String(payload.expression || '');

  try {
    const result = safeEvaluate(expression);
    return {
      success: true,
      summary: `Calculated result for "${expression}" is ${result}.`,
      data: {
        expression,
        result,
      },
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      success: false,
      summary: `Calculation failed: ${message}`,
      data: {
        expression,
        result: null,
      },
      error: message,
    };
  }
};

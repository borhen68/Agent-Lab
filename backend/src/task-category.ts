export const TASK_CATEGORIES = [
  'coding',
  'finance',
  'math',
  'research',
  'analysis',
  'creative',
  'general',
] as const;

export type TaskCategory = (typeof TASK_CATEGORIES)[number];

const CATEGORY_RULES: Array<{ category: TaskCategory; patterns: RegExp[] }> = [
  {
    category: 'coding',
    patterns: [
      /\b(code|function|debug|refactor|typescript|javascript|python|sql|api|bug|test|tests|test suite|unit test)\b/i,
      /\b(stack trace|compile|runtime|repository|repo|pull request|lint|typecheck)\b/i,
    ],
  },
  {
    category: 'finance',
    patterns: [
      /\b(finance|financial|portfolio|allocation|rebalance|valuation|dcf|options|derivatives)\b/i,
      /\b(ticker|stock|bond|etf|market cap|returns?|volatility|drawdown|yield|interest rate)\b/i,
      /\b(revenue|ebitda|cash flow|balance sheet|income statement)\b/i,
    ],
  },
  {
    category: 'math',
    patterns: [
      /\b(calculate|equation|probability|statistics|algebra|integral|derivative|matrix)\b/i,
      /[\d)\]]\s*[\+\-\*\/\^]\s*[\d(\[]/,
    ],
  },
  {
    category: 'research',
    patterns: [
      /\b(latest|news|current|today|market|trend|verify|source|citation|evidence)\b/i,
      /\b(compare|benchmark|survey|report)\b/i,
    ],
  },
  {
    category: 'analysis',
    patterns: [
      /\b(analyze|analysis|summarize|document|file|pdf|contract|policy|requirements)\b/i,
      /\b(root cause|tradeoff|risk|postmortem)\b/i,
    ],
  },
  {
    category: 'creative',
    patterns: [
      /\b(story|poem|script|brainstorm|name ideas|creative|tagline|copywriting)\b/i,
      /\b(character|plot|worldbuilding)\b/i,
    ],
  },
];

export function categorizePrompt(prompt: string): TaskCategory {
  const value = prompt.trim();
  if (!value) return 'general';

  for (const rule of CATEGORY_RULES) {
    if (rule.patterns.some((pattern) => pattern.test(value))) {
      return rule.category;
    }
  }

  return 'general';
}

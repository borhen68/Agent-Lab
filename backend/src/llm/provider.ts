import { config } from '../config';

export const SUPPORTED_PROVIDERS = ['anthropic', 'gemini', 'openai'] as const;
export type LLMProvider = (typeof SUPPORTED_PROVIDERS)[number];

export interface ProviderStatus {
  provider: LLMProvider;
  label: string;
  ready: boolean;
  model: string;
  reason?: string;
}

export function isSupportedProvider(value: unknown): value is LLMProvider {
  return typeof value === 'string' && SUPPORTED_PROVIDERS.includes(value as LLMProvider);
}

export function normalizeProvider(value?: string): LLMProvider {
  if (!value) return config.DEFAULT_LLM_PROVIDER;
  const normalized = value.trim().toLowerCase();
  if (normalized === 'openai') return 'openai';
  return normalized === 'gemini' ? 'gemini' : 'anthropic';
}

export function defaultModelForProvider(provider: LLMProvider): string {
  if (provider === 'gemini') return config.GEMINI_MODEL;
  if (provider === 'openai') return config.OPENAI_MODEL;
  return config.ANTHROPIC_MODEL;
}

export function resolveProviderApiKey(
  provider: LLMProvider,
  overrideApiKey?: string
): string | undefined {
  const override = overrideApiKey?.trim();
  if (override) return override;
  if (provider === 'gemini') return config.GEMINI_API_KEY;
  if (provider === 'openai') return config.OPENAI_API_KEY;
  return config.ANTHROPIC_API_KEY;
}

export function providerStatuses(): ProviderStatus[] {
  const anthropicReady = Boolean(config.ANTHROPIC_API_KEY?.trim());
  const geminiReady = Boolean(config.GEMINI_API_KEY?.trim());
  const openaiReady = Boolean(config.OPENAI_API_KEY?.trim());

  return [
    {
      provider: 'anthropic',
      label: 'Anthropic Claude',
      ready: anthropicReady,
      model: config.ANTHROPIC_MODEL,
      reason: anthropicReady ? undefined : 'Missing ANTHROPIC_API_KEY in backend environment.',
    },
    {
      provider: 'gemini',
      label: 'Google Gemini',
      ready: geminiReady,
      model: config.GEMINI_MODEL,
      reason: geminiReady ? undefined : 'Missing GEMINI_API_KEY in backend environment.',
    },
    {
      provider: 'openai',
      label: 'OpenAI',
      ready: openaiReady,
      model: config.OPENAI_MODEL,
      reason: openaiReady ? undefined : 'Missing OPENAI_API_KEY in backend environment.',
    },
  ];
}

export interface GeminiFunctionDeclaration {
  name: string;
  description?: string;
  parameters?: Record<string, unknown>;
}

const GEMINI_TYPE_MAP: Record<string, string> = {
  string: 'STRING',
  number: 'NUMBER',
  integer: 'INTEGER',
  boolean: 'BOOLEAN',
  object: 'OBJECT',
  array: 'ARRAY',
};

function normalizeGeminiType(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const normalized = value.toLowerCase();
  return GEMINI_TYPE_MAP[normalized] ?? value.toUpperCase();
}

export function toGeminiSchema(schema: unknown): unknown {
  if (!schema || typeof schema !== 'object') return schema;
  if (Array.isArray(schema)) return schema.map((item) => toGeminiSchema(item));

  const source = schema as Record<string, unknown>;
  const converted: Record<string, unknown> = {};

  const type = normalizeGeminiType(source.type);
  if (type) converted.type = type;

  if (typeof source.description === 'string' && source.description.trim()) {
    converted.description = source.description;
  }

  if (typeof source.format === 'string' && source.format.trim()) {
    converted.format = source.format;
  }

  if (typeof source.nullable === 'boolean') {
    converted.nullable = source.nullable;
  }

  if (Array.isArray(source.enum)) {
    converted.enum = source.enum;
  }

  if (typeof source.minItems === 'number' && Number.isFinite(source.minItems)) {
    converted.minItems = source.minItems;
  }

  if (typeof source.maxItems === 'number' && Number.isFinite(source.maxItems)) {
    converted.maxItems = source.maxItems;
  }

  if (source.items && typeof source.items === 'object') {
    converted.items = toGeminiSchema(source.items);
  }

  if (source.properties && typeof source.properties === 'object' && !Array.isArray(source.properties)) {
    const properties: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(source.properties as Record<string, unknown>)) {
      properties[key] = toGeminiSchema(value);
    }
    converted.properties = properties;
    if (!converted.type) converted.type = 'OBJECT';
  }

  if (Array.isArray(source.required)) {
    converted.required = source.required
      .filter((item): item is string => typeof item === 'string' && item.trim().length > 0);
  }

  if (!converted.type && converted.items) {
    converted.type = 'ARRAY';
  }

  return converted;
}

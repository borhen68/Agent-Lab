import type { SkillExecutionResult, SkillHandler } from '../../src/skills/types';

const TAVILY_API_URL = 'https://api.tavily.com/search';
const SERPER_API_URL = 'https://google.serper.dev/search';

export const inputSchema = {
  type: 'object',
  properties: {
    query: {
      type: 'string',
      description: 'The search query to look up on the web.',
      minLength: 2,
    },
    max_results: {
      type: 'number',
      description: 'Maximum number of results to return (default: 5, max: 10).',
      minimum: 1,
      maximum: 10,
    },
    limit: {
      type: 'number',
      description: 'Alias for max_results (backward compatibility).',
      minimum: 1,
      maximum: 10,
    },
  },
  required: ['query'],
  additionalProperties: false,
};

interface SearchResult {
  title: string;
  url: string;
  snippet: string;
}

interface TavilyResponse {
  results?: Array<{
    title?: string;
    url?: string;
    content?: string;
  }>;
}

interface SerperResponse {
  organic?: Array<{
    title?: string;
    link?: string;
    snippet?: string;
  }>;
}

function parseInput(input: unknown): { query: string; maxResults: number } {
  const payload = (input || {}) as Record<string, unknown>;
  const query = String(payload.query || '').trim();
  const rawLimit = payload.max_results ?? payload.limit ?? 5;
  const parsedLimit = Number(rawLimit);
  const maxResults = Number.isFinite(parsedLimit)
    ? Math.max(1, Math.min(10, Math.floor(parsedLimit)))
    : 5;

  return { query, maxResults };
}

function normalizeResult(result: SearchResult): SearchResult | null {
  const title = result.title.trim();
  const url = result.url.trim();
  const snippet = result.snippet.replace(/\s+/g, ' ').trim();
  if (!title || !url) return null;
  return { title, url, snippet };
}

function dedupeResults(results: SearchResult[], limit: number): SearchResult[] {
  const unique = new Map<string, SearchResult>();
  for (const result of results) {
    const normalized = normalizeResult(result);
    if (!normalized) continue;
    const key = normalized.url.toLowerCase();
    if (unique.has(key)) continue;
    unique.set(key, normalized);
  }
  return Array.from(unique.values()).slice(0, limit);
}

async function searchTavily(query: string, maxResults: number, apiKey: string): Promise<SearchResult[]> {
  const response = await fetch(TAVILY_API_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      query,
      max_results: maxResults,
      search_depth: 'basic',
      include_answer: false,
      include_raw_content: false,
      include_images: false,
    }),
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Tavily ${response.status}: ${body.slice(0, 200)}`);
  }

  const data = await response.json() as TavilyResponse;
  return (data.results || []).map((item) => ({
    title: item.title || '',
    url: item.url || '',
    snippet: item.content || '',
  }));
}

async function searchSerper(query: string, maxResults: number, apiKey: string): Promise<SearchResult[]> {
  const response = await fetch(SERPER_API_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-API-KEY': apiKey,
    },
    body: JSON.stringify({ q: query, num: maxResults }),
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Serper ${response.status}: ${body.slice(0, 200)}`);
  }

  const data = await response.json() as SerperResponse;
  return (data.organic || []).slice(0, maxResults).map((item) => ({
    title: item.title || '',
    url: item.link || '',
    snippet: item.snippet || '',
  }));
}

export const handler: SkillHandler = async (input): Promise<SkillExecutionResult> => {
  const { query, maxResults } = parseInput(input);

  if (!query) {
    return {
      success: false,
      summary: 'Search failed: query is required.',
      data: { query, provider: null, results: [] },
      error: 'query is required',
    };
  }

  const tavilyKey = process.env.TAVILY_API_KEY?.trim();
  const serperKey = process.env.SERPER_API_KEY?.trim();

  if (!tavilyKey && !serperKey) {
    const message = 'No search API key configured. Set TAVILY_API_KEY (recommended) or SERPER_API_KEY in backend .env. Get a free Tavily key at https://tavily.com';
    return {
      success: false,
      summary: message,
      data: { query, provider: null, results: [] },
      error: message,
    };
  }

  const providerErrors: string[] = [];
  let providerUsed: 'Tavily' | 'Serper' | null = null;
  let results: SearchResult[] = [];

  if (tavilyKey) {
    try {
      results = await searchTavily(query, maxResults, tavilyKey);
      providerUsed = 'Tavily';
    } catch (error) {
      providerErrors.push(`Tavily: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  if (results.length === 0 && serperKey) {
    try {
      results = await searchSerper(query, maxResults, serperKey);
      providerUsed = 'Serper';
    } catch (error) {
      providerErrors.push(`Serper: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  const normalizedResults = dedupeResults(results, maxResults);
  if (normalizedResults.length === 0) {
    const detail = providerErrors.length > 0 ? ` Providers failed: ${providerErrors.join(' | ')}` : '';
    const message = `Search returned 0 results for "${query}".${detail}`;
    return {
      success: false,
      summary: message,
      data: { query, provider: providerUsed, results: [] },
      error: message,
    };
  }

  const formatted = normalizedResults
    .map((result, index) => `[${index + 1}] ${result.title}\n${result.url}\n${result.snippet}`)
    .join('\n\n');

  return {
    success: true,
    summary: `[Skill web-search] Found ${normalizedResults.length} result(s) for "${query}" via ${providerUsed}.`,
    data: {
      query,
      provider: providerUsed,
      results: normalizedResults,
      formatted,
    },
  };
};

import type { SkillExecutionResult, SkillHandler } from '../../src/skills/types';

export const inputSchema = {
  type: 'object',
  properties: {
    query: { type: 'string', minLength: 2 },
    limit: { type: 'integer', minimum: 1, maximum: 10 },
  },
  required: ['query'],
  additionalProperties: false,
};

interface SerperResult {
  title: string;
  link: string;
  snippet?: string;
  position?: number;
}

interface TavilyResult {
  title?: string;
  url?: string;
  content?: string;
}

interface SearchResult {
  title: string;
  url: string;
  snippet: string;
}

function parseInput(input: unknown): { query: string; limit: number } {
  const payload = (input || {}) as Record<string, unknown>;
  const query = String(payload.query || '').trim();
  const parsedLimit = Number(payload.limit ?? 5);
  const limit = Number.isFinite(parsedLimit) ? Math.max(1, Math.min(10, Math.floor(parsedLimit))) : 5;
  return { query, limit };
}

async function searchWithSerper(query: string, limit: number): Promise<SearchResult[]> {
  const apiKey = process.env.SERPER_API_KEY;
  if (!apiKey) {
    throw new Error('SERPER_API_KEY environment variable is not set');
  }

  const response = await fetch('https://google.serper.dev/search', {
    method: 'POST',
    headers: {
      'X-API-KEY': apiKey,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ q: query, num: limit }),
  });

  if (!response.ok) {
    throw new Error(`Serper API error: HTTP ${response.status}`);
  }

  const data = await response.json() as { organic?: SerperResult[] };
  const organic: SerperResult[] = data.organic || [];

  return organic.slice(0, limit).map((item) => ({
    title: item.title || '',
    url: item.link || '',
    snippet: item.snippet || '',
  }));
}

async function searchWithTavily(query: string, limit: number): Promise<SearchResult[]> {
  const apiKey = process.env.TAVILY_API_KEY;
  if (!apiKey) {
    throw new Error('TAVILY_API_KEY environment variable is not set');
  }

  const response = await fetch('https://api.tavily.com/search', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      api_key: apiKey,
      query,
      search_depth: 'basic',
      include_answer: false,
      include_images: false,
      include_raw_content: false,
      max_results: limit,
    }),
  });

  if (!response.ok) {
    throw new Error(`Tavily API error: HTTP ${response.status}`);
  }

  const data = await response.json() as { results?: TavilyResult[] };
  const results: TavilyResult[] = data.results || [];

  return results.slice(0, limit).map((item) => ({
    title: (item.title || '').trim(),
    url: (item.url || '').trim(),
    snippet: (item.content || '').replace(/\s+/g, ' ').trim(),
  })).filter((item) => item.title && item.url);
}

async function searchWithDuckDuckGoFallback(query: string, limit: number): Promise<SearchResult[]> {
  const url = `https://duckduckgo.com/html/?q=${encodeURIComponent(query)}`;
  const response = await fetch(url, {
    headers: { 'user-agent': 'agent-strategy-lab/1.0' },
  });

  if (!response.ok) {
    throw new Error(`DuckDuckGo fallback error: HTTP ${response.status}`);
  }

  const html = await response.text();
  const results: SearchResult[] = [];
  const itemRegex =
    /href="([^"]*?\/\/[^"]+)"[^>]*class="[^"]*result__a[^"]*"[^>]*>([\s\S]*?)<\/a>[\s\S]*?class="[^"]*result__snippet[^"]*"[^>]*>([\s\S]*?)<\/a>/gi;

  let match: RegExpExecArray | null;
  while ((match = itemRegex.exec(html)) && results.length < limit) {
    const url = match[1].replace(/<[^>]*>/g, '').trim();
    const title = match[2].replace(/<[^>]*>/g, '').replace(/\s+/g, ' ').trim();
    const snippet = match[3].replace(/<[^>]*>/g, '').replace(/\s+/g, ' ').trim();
    if (title && url) results.push({ title, url, snippet });
  }
  return results;
}

function dedupeResults(results: SearchResult[], limit: number): SearchResult[] {
  const unique = new Map<string, SearchResult>();
  for (const result of results) {
    const key = result.url.trim().toLowerCase();
    if (!key || unique.has(key)) continue;
    unique.set(key, result);
  }
  return Array.from(unique.values()).slice(0, limit);
}

export const handler: SkillHandler = async (input): Promise<SkillExecutionResult> => {
  const { query, limit } = parseInput(input);

  if (!query) {
    return {
      success: false,
      summary: 'Search failed: query is required.',
      data: { query, results: [] },
      error: 'query is required',
    };
  }

  try {
    const hasTavily = Boolean(process.env.TAVILY_API_KEY?.trim());
    const hasSerper = Boolean(process.env.SERPER_API_KEY?.trim());
    const providerErrors: string[] = [];
    let providerUsed = 'DuckDuckGo';
    let results: SearchResult[] = [];

    if (hasTavily) {
      try {
        results = await searchWithTavily(query, limit);
        providerUsed = 'Tavily';
      } catch (error) {
        providerErrors.push(`Tavily: ${error instanceof Error ? error.message : String(error)}`);
      }
    }

    if (results.length === 0 && hasSerper) {
      try {
        results = await searchWithSerper(query, limit);
        providerUsed = 'Serper';
      } catch (error) {
        providerErrors.push(`Serper: ${error instanceof Error ? error.message : String(error)}`);
      }
    }

    if (results.length === 0) {
      try {
        results = await searchWithDuckDuckGoFallback(query, limit);
        providerUsed = 'DuckDuckGo';
      } catch (error) {
        providerErrors.push(`DuckDuckGo: ${error instanceof Error ? error.message : String(error)}`);
      }
    }

    const normalizedResults = dedupeResults(results, limit);
    if (normalizedResults.length === 0) {
      const detail = providerErrors.length > 0
        ? ` Providers failed: ${providerErrors.join(' | ')}`
        : '';
      return {
        success: false,
        summary: `Search returned 0 results for "${query}".${detail}`,
        data: { query, provider: providerUsed, results: [] },
        error: `no search results${detail}`,
      };
    }

    return {
      success: true,
      summary: `Found ${normalizedResults.length} result(s) for "${query}" via ${providerUsed}.`,
      data: { query, provider: providerUsed, results: normalizedResults },
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      success: false,
      summary: `Search failed: ${message}`,
      data: { query, results: [] },
      error: message,
    };
  }
};

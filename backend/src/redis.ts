import logger from './logger';

// Simple in-memory cache to replace Redis for local zero-dependency setups
const cache = new Map<string, { value: any; expiresAt: number }>();

export async function initializeRedis(): Promise<void> {
  logger.info('✅ Using internal Memory Cache (Redis replacement)');
}

// We don't export a client interface since we aren't using real redis
// just keep the disconnect func for graceful shutdown
export async function disconnectRedis(): Promise<void> {
  cache.clear();
  logger.info('Memory Cache cleared');
}

// Cache utilities
export async function setCache(key: string, value: any, ttl = 3600): Promise<void> {
  const expiresAt = Date.now() + ttl * 1000;
  cache.set(key, { value, expiresAt });
}

export async function getCache<T>(key: string): Promise<T | null> {
  const item = cache.get(key);
  if (!item) return null;

  if (Date.now() > item.expiresAt) {
    cache.delete(key);
    return null;
  }

  return item.value as T;
}

export async function deleteCache(key: string): Promise<void> {
  cache.delete(key);
}

export async function clearCache(pattern: string): Promise<void> {
  // Simple pattern matching (e.g., 'task:*')
  const regex = new RegExp('^' + pattern.replace(/\*/g, '.*') + '$');
  for (const key of cache.keys()) {
    if (regex.test(key)) {
      cache.delete(key);
    }
  }
}

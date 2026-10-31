/**
 * High-Performance Multi-Tier Caching Service (L1 In-Memory + L2 Redis)
 * Automatically falls back to in-memory TTL caching if Redis is not configured or unavailable.
 */

const Redis = require('ioredis');

// In-Memory L1 Cache Store
const memoryStore = new Map();

// Metrics tracking
const stats = {
  hits: 0,
  misses: 0,
  redisConnected: false,
  memoryEntries: 0
};

let redisClient = null;

// Initialize Redis if REDIS_URL or REDIS_HOST is configured, or check localhost silently
const redisUrl = process.env.REDIS_URL || process.env.REDIS_URI;
const redisHost = process.env.REDIS_HOST;
const redisPort = parseInt(process.env.REDIS_PORT || '6379', 10);
const redisPassword = process.env.REDIS_PASSWORD;

if (redisUrl || redisHost) {
  try {
    const redisOptions = {
      maxRetriesPerRequest: 2,
      connectTimeout: 3000,
      enableOfflineQueue: false,
      lazyConnect: true,
      retryStrategy: (times) => {
        if (times > 3) {
          console.warn('⚠️ Redis connection attempts exhausted. Falling back to in-memory caching.');
          return null;
        }
        return Math.min(times * 500, 2000);
      }
    };

    if (redisPassword) redisOptions.password = redisPassword;

    redisClient = redisUrl ? new Redis(redisUrl, redisOptions) : new Redis(redisPort, redisHost, redisOptions);

    redisClient.on('connect', () => {
      stats.redisConnected = true;
      console.log('✅ Redis Cache: Connected to Redis server successfully.');
    });

    redisClient.on('error', (err) => {
      stats.redisConnected = false;
      // Log connection error quietly without crashing process
      if (err.code === 'ECONNREFUSED' || err.code === 'ENOTFOUND') {
        console.warn(`⚡ Redis Cache: Redis unavailable at ${redisUrl || `${redisHost}:${redisPort}`}. Operating on high-performance In-Memory cache.`);
      } else {
        console.warn('⚠️ Redis Cache warning:', err.message);
      }
    });

    redisClient.on('close', () => {
      stats.redisConnected = false;
    });

    // Connect asynchronously
    redisClient.connect().catch(() => {});
  } catch (err) {
    console.warn('⚠️ Failed to initialize Redis client. Falling back to In-Memory cache:', err.message);
    redisClient = null;
  }
} else {
  console.log('⚡ Redis Cache: REDIS_URL not set in environment. Running on high-performance In-Memory TTL cache.');
}

/**
 * Periodically purge expired L1 memory cache keys to avoid memory leaks
 */
setInterval(() => {
  const now = Date.now();
  for (const [key, item] of memoryStore.entries()) {
    if (item.expiresAt && item.expiresAt <= now) {
      memoryStore.delete(key);
    }
  }
  stats.memoryEntries = memoryStore.size;
}, 60 * 1000).unref();

/**
 * Get value from Cache (L1 Memory -> L2 Redis)
 * @param {string} key
 * @returns {Promise<any|null>}
 */
async function get(key) {
  const now = Date.now();

  // 1. Check L1 Memory Cache (Instant, 0ms)
  const memItem = memoryStore.get(key);
  if (memItem) {
    if (!memItem.expiresAt || memItem.expiresAt > now) {
      stats.hits++;
      return memItem.value;
    }
    memoryStore.delete(key);
  }

  // 2. Check L2 Redis if active
  if (redisClient && stats.redisConnected) {
    try {
      const raw = await redisClient.get(key);
      if (raw !== null && raw !== undefined) {
        stats.hits++;
        const parsed = JSON.parse(raw);
        // Backfill L1 memory cache with remaining TTL (or 60s minimum)
        memoryStore.set(key, {
          value: parsed,
          expiresAt: now + 60 * 1000
        });
        return parsed;
      }
    } catch (err) {
      // Ignore Redis read error and proceed as miss
    }
  }

  stats.misses++;
  return null;
}

/**
 * Set value in Cache (L1 Memory + L2 Redis)
 * @param {string} key
 * @param {any} value
 * @param {number} ttlSeconds Default: 300 (5 minutes)
 */
async function set(key, value, ttlSeconds = 300) {
  const expiresAt = ttlSeconds ? Date.now() + ttlSeconds * 1000 : null;

  // 1. Write to L1 Memory Cache
  memoryStore.set(key, { value, expiresAt });
  stats.memoryEntries = memoryStore.size;

  // 2. Write to L2 Redis if active
  if (redisClient && stats.redisConnected) {
    try {
      const serialized = JSON.stringify(value);
      if (ttlSeconds > 0) {
        await redisClient.set(key, serialized, 'EX', ttlSeconds);
      } else {
        await redisClient.set(key, serialized);
      }
    } catch (err) {
      // Ignore Redis write error
    }
  }
}

/**
 * Delete key from Cache
 * @param {string} key
 */
async function del(key) {
  memoryStore.delete(key);
  stats.memoryEntries = memoryStore.size;

  if (redisClient && stats.redisConnected) {
    try {
      await redisClient.del(key);
    } catch (_) {}
  }
}

/**
 * Delete all keys matching a prefix
 * @param {string} prefix e.g. 'audex:audit:'
 */
async function delByPrefix(prefix) {
  // L1 Memory purge
  for (const k of memoryStore.keys()) {
    if (k.startsWith(prefix)) {
      memoryStore.delete(k);
    }
  }
  stats.memoryEntries = memoryStore.size;

  // L2 Redis scan & purge
  if (redisClient && stats.redisConnected) {
    try {
      const stream = redisClient.scanStream({
        match: `${prefix}*`,
        count: 100
      });
      stream.on('data', async (keys = []) => {
        if (keys.length > 0) {
          const pipeline = redisClient.pipeline();
          keys.forEach(k => pipeline.del(k));
          await pipeline.exec();
        }
      });
    } catch (_) {}
  }
}

/**
 * High-level Cache Helper: Returns cached data or computes, caches, and returns it.
 * @param {string} key Cache key
 * @param {Function} fetcherFn Async function returning value on cache miss
 * @param {number} ttlSeconds Expiration in seconds
 */
async function getOrSet(key, fetcherFn, ttlSeconds = 300) {
  const cached = await get(key);
  if (cached !== null && cached !== undefined) {
    return cached;
  }

  const fresh = await fetcherFn();
  if (fresh !== null && fresh !== undefined) {
    await set(key, fresh, ttlSeconds);
  }
  return fresh;
}

/**
 * Clear all cache entries
 */
async function clear() {
  memoryStore.clear();
  stats.memoryEntries = 0;
  if (redisClient && stats.redisConnected) {
    try {
      await redisClient.flushdb();
    } catch (_) {}
  }
}

/**
 * Return current cache statistics and health
 */
function getStats() {
  return {
    hits: stats.hits,
    misses: stats.misses,
    hitRatio: (stats.hits + stats.misses) > 0 ? ((stats.hits / (stats.hits + stats.misses)) * 100).toFixed(1) + '%' : '0%',
    redisConnected: stats.redisConnected,
    memoryEntries: memoryStore.size,
    mode: stats.redisConnected ? 'Multi-Tier (L1 Memory + L2 Redis)' : 'High-Performance L1 In-Memory TTL'
  };
}

module.exports = {
  get,
  set,
  del,
  delByPrefix,
  getOrSet,
  clear,
  getStats,
  isRedisConnected: () => stats.redisConnected
};

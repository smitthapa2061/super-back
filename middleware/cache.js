const { Redis } = require('@upstash/redis');

// Warn if missing (use memory fallback)
if (!process.env.UPSTASH_REDIS_REST_URL || !process.env.UPSTASH_REDIS_REST_TOKEN) {
  console.warn('⚠️  Missing Redis env vars - using memory cache only');
  module.exports = { getCache: () => null, setCache: () => {}, cacheMiddleware: () => (req, res, next) => next(), invalidateCacheMiddleware: () => (req, res, next) => next() };
  return;
}

// Create Redis client with new hosted creds
const redisClient = new Redis({
  url: process.env.UPSTASH_REDIS_REST_URL,
  token: process.env.UPSTASH_REDIS_REST_TOKEN,
});

// Test connection on startup
(async () => {
  try {
    await redisClient.ping();
    console.log("✅ Upstash Redis connected (new hosted instance)");
  } catch (err) {
    console.error("❌ Upstash Redis connection failed:", err.message);
    process.exit(1);
  }
})();

// Simple in-memory cache as fallback
const memoryCache = new Map();

const getCache = async (key) => {
  try {
    const value = await redisClient.get(key);
    return value ?? null;
  } catch (error) {
    console.warn('Cache get error, using memory:', error.message);
    return memoryCache.get(key) || null;
  }
};

const setCache = async (key, value, ttlSeconds = 300) => {
  try {
    await redisClient.set(key, value, { ex: ttlSeconds });
  } catch (error) {
    console.warn('Cache set error:', error.message);
    memoryCache.set(key, value);
    setTimeout(() => memoryCache.delete(key), ttlSeconds * 1000);
  }
};

const deleteCache = async (key) => {
  try {
    await redisClient.del(key);
  } catch (error) {
    console.warn('Cache delete error:', error.message);
    memoryCache.delete(key);
  }
};

// Middleware
const cacheMiddleware = (ttlSeconds = 300) => {
  return async (req, res, next) => {
    if (req.method !== 'GET') return next();

    const key = `cache:${req.originalUrl}`;

    try {
      const cached = await getCache(key);
      if (cached) {
        console.log(`✅ Cache hit: ${key}`);
        return res.json(cached);
      }
    } catch (error) {
      console.warn('Cache middleware get error:', error.message);
    }

    const originalJson = res.json;
    res.json = function(data) {
      setCache(key, data, ttlSeconds).catch(console.warn);
      originalJson.call(this, data);
    };

    next();
  };
};

const invalidateCacheMiddleware = (keysOrFunc) => {
  return async (req, res, next) => {
    if (['POST', 'PUT', 'DELETE'].includes(req.method)) {
      const keys = typeof keysOrFunc === 'function' ? keysOrFunc(req) : keysOrFunc;
      for (const key of keys) {
        await deleteCache(key);
      }
    }
    next();
  };
};

module.exports = { getCache, setCache, deleteCache, cacheMiddleware, invalidateCacheMiddleware };

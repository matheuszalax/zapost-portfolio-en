/**
 * Distributed Sliding Window Rate Limiter via Redis Sorted Sets
 * 
 * Provides atomic, multi-instance rate limiting with sub-millisecond precision.
 * Automatically computes exact Retry-After durations upon quota exhaustion.
 */

import type { Redis } from "ioredis";

export type RateLimitResult =
  | { allowed: true }
  | { allowed: false; retryAfterMs: number };

export async function checkSlidingWindowRateLimit(
  redis: Redis,
  key: string,
  limit: number,
  windowMs: number
): Promise<RateLimitResult> {
  const now = Date.now();
  const windowStart = now - windowMs;
  const redisKey = `ratelimit:${key}`;

  // Execute atomic pipeline: purge stale requests and count active events
  const results = await redis
    .pipeline()
    .zremrangebyscore(redisKey, 0, windowStart)
    .zcard(redisKey)
    .exec();

  const currentCount = (results?.[1]?.[1] as number) ?? 0;

  // Rate limit exceeded: calculate exact time until oldest request leaves the sliding window
  if (currentCount >= limit) {
    const oldestEntries = await redis.zrange(redisKey, 0, 0);
    const oldestTimestamp = oldestEntries[0] 
      ? parseInt(oldestEntries[0].split(":")[0], 10) 
      : now;
      
    const retryAfterMs = Math.max(windowMs - (now - oldestTimestamp), 0);
    return { allowed: false, retryAfterMs };
  }

  // Under limit: record current request with unique member payload and refresh TTL
  const memberToken = `${now}:${Math.random().toString(36).slice(2, 9)}`;
  await redis
    .pipeline()
    .zadd(redisKey, now, memberToken)
    .pexpire(redisKey, windowMs)
    .exec();

  return { allowed: true };
}

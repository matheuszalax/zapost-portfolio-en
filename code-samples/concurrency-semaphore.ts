/**
 * Distributed Concurrency Semaphore via Redis Atomic Primitives
 * 
 * Throttles simultaneous execution of resource-intensive operations
 * (e.g., real-time LLM stream rewriting) across horizontally scaled services.
 */

import type { Redis } from "ioredis";

export type ConcurrencyResult =
  | { acquired: true; release: () => Promise<void> }
  | { acquired: false };

export async function acquireDistributedSemaphore(
  redis: Redis,
  key: string,
  maxConcurrency: number,
  ttlMs: number = 60_000
): Promise<ConcurrencyResult> {
  const semaphoreKey = `semaphore:${key}`;

  // Atomically increment the concurrency counter
  const currentCount = await redis.incr(semaphoreKey);

  // Set fail-safe TTL on initial key creation to prevent permanent deadlocks on crashed workers
  if (currentCount === 1) {
    await redis.pexpire(semaphoreKey, ttlMs);
  }

  // Quota exceeded: immediately decrement counter and reject lease
  if (currentCount > maxConcurrency) {
    await redis.decr(semaphoreKey);
    return { acquired: false };
  }

  // Return lease holder with cleanup closure
  const release = async () => {
    await redis.decr(semaphoreKey);
  };

  return { acquired: true, release };
}

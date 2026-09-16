# 02 — Distributed Queues, Workers & Rate Limiting

## Asynchronous Architecture Overview

In a generative AI and media-heavy SaaS, synchronous HTTP request handling causes socket timeouts, connection pool exhaustion, and poor user experience. 

zapost completely decouples long-running operations from the web tier using **BullMQ** running atop a dedicated **Redis 7** instance.

```
┌─────────────────┐      HTTP POST /api/posts/generate       ┌──────────────────────┐
│ Browser Client  ├─────────────────────────────────────────►│  Next.js API Server  │
└────────┬────────┘                                          └──────────┬───────────┘
         │                                                              │
         │  ◄── 202 Accepted { jobId: "ai_98765" } ────────────────────┤
         │                                                              │
         │  Poll GET /api/posts/generate/status/:jobId                  │ Enqueue Job
         │  (Every 2000ms with progressive UI states)                  ▼
         │                                                   ┌──────────────────────┐
         ├──────────────────────────────────────────────────►│  Redis 7 (BullMQ)    │
         │                                                   └──────────┬───────────┘
         │                                                              │
         ▼                                                              ▼ Dequeue
┌─────────────────┐                                          ┌──────────────────────┐
│ Render Finished │◄─────────────────────────────────────────┤  Dedicated Worker    │
│ Post & Assets   │           Status: "completed"            │  (Node 22 + tsx)     │
└─────────────────┘                                          └──────────────────────┘
```

---

## 1. BullMQ Queue Design

The application configures distinct queues with specialized lifecycle guarantees:

### A. Post Generation Queue (`post-generation`)
* **Concurrency:** 2 concurrent jobs per worker container to prevent local CPU/memory spikes during asset parsing and image downloads.
* **Rate Limiting:** Enforced at the worker level (maximum 10 jobs per minute).
* **Retry Strategy:** 2 retries with exponential backoff (`delay: 30000ms`).
* **Job Retention:** Completed jobs are retained for 24 hours for audit and status verification; failed jobs persist for 48 hours for Sentry debugging.

### B. Abandoned Checkout Queue (`abandoned-checkout`)
* **Scheduled Delay:** Enqueued when a visitor initiates a checkout; scheduled with a 30-minute delay.
* **State Verification:** When the job fires, it verifies whether the associated user is still in `PENDING` status. If the user already paid, the job self-terminates without sending recovery emails.

### C. Mercado Pago Reconciler Worker
* **Scheduled Execution:** Operates as an automated reconciler polling Mercado Pago search APIs every 10 minutes to verify approved PIX and credit card transactions that may have missed webhook delivery.

---

## 2. Distributed Rate Limiting (Sliding Window Algorithm)

Traditional in-memory token buckets fail in multi-container setups. zapost implements an atomic sliding window counter utilizing **Redis Sorted Sets**:

```
Timestamp (ms):   t - windowMs               now
                       │                      │
                       ▼                      ▼
Scores in Sorted Set: [ ●   ●   ●   ●   ●   ● ]
                       ▲
                       │
             ZREMRANGEBYSCORE: drops timestamps older than (now - windowMs)
             ZCARD: counts valid events in the sliding window
```

### Algorithm Highlights
1. `ZREMRANGEBYSCORE`: Purges entries outside the active window.
2. `ZCARD`: Calculates the count of requests made in the current window.
3. If count $\ge$ limit, reads the oldest entry via `ZRANGE` to calculate the exact `Retry-After` header.
4. If under limit, appends the current timestamp via `ZADD` and sets a TTL via `PEXPIRE` in a single atomic pipeline.

---

## 3. Distributed Concurrency Semaphore

For operations that cannot be queued (such as user-interactive real-time caption rewriting), the system protects upstream LLM concurrency quotas with a distributed semaphore:

```typescript
export async function acquireConcurrencySlot(
  key: string,
  maxConcurrency: number,
  ttlMs: number = 60_000
): Promise<ConcurrencyResult> {
  const current = await redis.incr(key);

  if (current === 1) {
    await redis.pexpire(key, ttlMs);
  }

  if (current > maxConcurrency) {
    await redis.decr(key);
    return { acquired: false };
  }

  const release = async () => {
    await redis.decr(key);
  };

  return { acquired: true, release };
}
```

If the lease cannot be acquired, the API immediately returns `HTTP 429 Too Many Requests` with a `Retry-After: 5` header, preventing request pileups and protecting provider rate limits.

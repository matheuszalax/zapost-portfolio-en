# 03 — 4-Tier AI Resiliency & Web Search Grounding

## Resilient LLM Orchestration

Public LLM APIs suffer from intermittent rate limits, capacity constraints, model outages, and occasional format deviations. 

zapost implements an enterprise **4-tier cascading fallback engine** orchestrated via **OpenRouter**, ensuring that user generation requests succeed even during severe upstream provider downtime.

```
                  ┌──────────────────────────────┐
                  │ Briefing / Carousel Request  │
                  └──────────────┬───────────────┘
                                 │
                     Heuristic check: Factual news?
                                 ├──────────────────────┐
                                 │ Yes                  │ No
                                 ▼                      │
                     ┌───────────────────────┐          │
                     │  Tavily AI Web Search │          │
                     │  (Extracts Top Sources│          │
                     │   and Citations)      │          │
                     └───────────┬───────────┘          │
                                 │                      │
                                 ▼                      ▼
                    ┌────────────────────────────────────────┐
                    │ Prompt with Brand Identity & Context   │
                    └───────────────────┬────────────────────┘
                                        │
                 ┌──────────────────────┴──────────────────────┐
                 ▼ Layer 1                                     │
   ┌───────────────────────────┐                               │
   │  openai/gpt-4o-mini       ├─► Success? ──► Return Output  │
   └─────────────┬─────────────┘                               │
                 │ Transient Error / Rate Limit                │
                 ▼ Layer 2                                     │
   ┌───────────────────────────┐                               │
   │  openai/gpt-4o-mini Retry ├─► Success? ──► Return Output  │
   └─────────────┬─────────────┘                               │
                 │ Fails again                                 │
                 ▼ Layer 3                                     │
   ┌───────────────────────────┐                               │
   │  google/gemini-2.0-flash  ├─► Success? ──► Return Output  │
   └─────────────┬─────────────┘                               │
                 │ Fails / Content Filter                      │
                 ▼ Layer 4                                     │
   ┌───────────────────────────┐                               │
   │  anthropic/claude-3.5-hku ├─► Success? ──► Return Output  │
   └─────────────┬─────────────┘                               │
                 │ Exhausted                                   │
                 ▼                                             │
      Record Sentry + Discord Alert                            ▼
```

---

## 1. Multi-Tier Fallback Engine

When invoking `callWithFallback()`, the engine categorizes errors into two classifications:
1. **Fatal / Configuration Errors:** (`401 Unauthorized`, `400 Bad Request`, `ContentPolicyViolation`). In these cases, the pipeline immediately aborts because switching models will not resolve an invalid API key or explicit prompt violation.
2. **Transient Provider Errors:** (`429 RateLimit`, `502 Bad Gateway`, `504 Gateway Timeout`, network disconnects, or schema formatting failures). These trigger automatic promotion to the next tier in the cascade.

### Telemetry & Audit Trail
Every generation attempt records a comprehensive diagnostic record in `PostGenerationLog`:
* `durationMs`: Total execution time across all layers.
* `provider` and `model`: The exact model that successfully answered.
* `attempts`: A JSON trace recording each layer attempt, latency, and specific error message encountered.
* `hasWebSearch`: Boolean flag indicating if Tavily search was injected.

---

## 2. Real-Time Web Grounding with Tavily

LLMs possess static knowledge cutoff dates and frequently hallucinate recent news, sports results, product launches, and industry trends.

zapost incorporates a heuristic evaluator (`shouldUseWebSearch`):
* Detects keywords such as *lançamento*, *polêmica*, *notícia*, *atualização*, *resultado*, *tendência*.
* Dispatches an asynchronous request to **Tavily Search API** with `search_depth: "basic"` and `max_results: 5`.
* Formats and summarizes the top 5 verified sources into an objective briefing block injected directly into the LLM system prompt:

```text
CONTEXTO FACTUAL OBTIDO NA WEB EM TEMPO REAL:
Resumo: ...
Fontes verificadas:
- [Fonte 1] https://...: conteúdo relevante
- [Fonte 2] https://...: conteúdo relevante
```

If Tavily times out or errors, the pipeline gracefully degrades without blocking post generation, logging a warning to Discord.

---

## 3. Brand Identity Scraping with Apify

During user onboarding, zapost integrates **Apify Actors** to scrape public Instagram profile metadata:
* Downloads avatar images and mirrors them to **Cloudflare R2** to prevent external CDN hotlinking issues.
* Scrapes the user's bio and the captions of their last 15 posts.
* Uses the LLM to extract target audience demographics, brand tone, recurring themes, and visual palette preferences, persisting them into a reusable `BrandProfile` entity.

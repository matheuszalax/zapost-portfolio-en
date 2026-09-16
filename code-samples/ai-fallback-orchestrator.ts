/**
 * 4-Tier Resilient Multi-Provider LLM Fallback Orchestrator
 * 
 * Implements cascading model execution with intelligent transient error retry,
 * strict schema validation via Zod, and full execution latency telemetry.
 */

import { z } from "zod";

export interface FallbackLayerConfig {
  layer: number;
  model: string;
  maxRetries: number;
  timeoutMs: number;
}

export interface FallbackAttemptTrace {
  layer: number;
  model: string;
  durationMs: number;
  error?: string;
  success: boolean;
}

export class TransientProviderError extends Error {
  constructor(message: string, public readonly status?: number) {
    super(message);
    this.name = "TransientProviderError";
  }
}

export class FatalConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FatalConfigurationError";
  }
}

const DEFAULT_FALLBACK_LAYERS: FallbackLayerConfig[] = [
  { layer: 1, model: "openai/gpt-4o-mini", maxRetries: 1, timeoutMs: 20_000 },
  { layer: 2, model: "openai/gpt-4o-mini", maxRetries: 1, timeoutMs: 25_000 },
  { layer: 3, model: "google/gemini-2.0-flash-lite-001", maxRetries: 0, timeoutMs: 20_000 },
  { layer: 4, model: "anthropic/claude-3.5-haiku", maxRetries: 0, timeoutMs: 25_000 },
];

export async function executeWithResilientFallback<T>(
  prompt: string,
  schema: z.ZodType<T>,
  invokeModel: (model: string, timeoutMs: number) => Promise<string>,
  layers: FallbackLayerConfig[] = DEFAULT_FALLBACK_LAYERS
): Promise<{ data: T; attempts: FallbackAttemptTrace[]; resolvedModel: string }> {
  const traces: FallbackAttemptTrace[] = [];

  for (const layer of layers) {
    const startMs = Date.now();
    try {
      // 1. Invoke upstream model via gateway
      const rawResponse = await invokeModel(layer.model, layer.timeoutMs);

      // 2. Parse JSON and enforce schema contract
      const parsedJson = JSON.parse(rawResponse);
      const validatedData = schema.parse(parsedJson);

      traces.push({
        layer: layer.layer,
        model: layer.model,
        durationMs: Date.now() - startMs,
        success: true,
      });

      return {
        data: validatedData,
        attempts: traces,
        resolvedModel: layer.model,
      };
    } catch (err: any) {
      const durationMs = Date.now() - startMs;
      const errorMessage = err?.message || "Unknown error";

      traces.push({
        layer: layer.layer,
        model: layer.model,
        durationMs,
        error: errorMessage,
        success: false,
      });

      // Fatal errors should not cascade through other models
      if (err instanceof FatalConfigurationError) {
        throw err;
      }

      // Continue to next fallback tier for transient timeouts or parsing failures
      console.warn(`[AI Fallback] Layer ${layer.layer} (${layer.model}) failed: ${errorMessage}. Escalating...`);
    }
  }

  throw new Error(`All ${layers.length} AI fallback layers exhausted without success.`);
}

import {
  createClassifier,
  type ClassificationInput,
  type ClassificationResult,
  type LatchClassifier,
  type OutputSchema,
} from "../classifier.js";
import type { ClassifierThresholds, FallbackStrategy } from "../types.js";

/**
 * Build a classifier from a decision model on the Vercel AI Gateway
 * (`typesafe-ai/jev` and friends): typed questions about shared state,
 * answered with calibrated probabilities over one round trip. Decision models
 * return no prose, so this adapter asks exactly what latch's contract needs —
 * a choice plus four boolean probabilities — and skips prompt engineering
 * entirely. Uses fetch only.
 *
 * ```ts
 * const judge = createDecisionClassifier({
 *   model: "typesafe-ai/jev",
 *   apiKey: process.env.AI_GATEWAY_API_KEY,
 * });
 * ```
 */
export function createDecisionClassifier(options: DecisionClassifierOptions): LatchClassifier {
  const baseURL = (options.baseURL ?? "https://ai-gateway.vercel.sh/v1").replace(/\/+$/, "");
  const apiKey =
    options.apiKey ?? process.env["AI_GATEWAY_API_KEY"] ?? process.env["VERCEL_AI_GATEWAY_API_KEY"];
  const model = options.model;
  if (typeof model !== "string" || model.trim() === "") {
    throw new TypeError(
      `latch: createDecisionClassifier requires a decision model id, e.g. "typesafe-ai/jev" (got ${JSON.stringify(options.model)})`,
    );
  }
  const timeoutMs = options.timeoutMs ?? 15_000;
  const instructions = { ...DEFAULT_INSTRUCTIONS, ...options.instructions };

  return createClassifier({
    id: options.id ?? "decision-judge",
    version: options.version ?? model,
    model: { model, baseURL, apiKey, timeoutMs, instructions },
    predict: async (http, input) => {
      if (!http.apiKey) {
        throw new Error(
          "no API key — set AI_GATEWAY_API_KEY (or pass apiKey), the decision model cannot run without one",
        );
      }
      return requestEvaluation(http, input);
    },
    // The adapter's own schema+decide: the response is validated into the
    // five signals plus gateway metadata, then mapped to the canonical
    // result. A caller-supplied decide recombines the same validated signals.
    schema: answersSchema,
    decide: (answers) =>
      options.decide !== undefined ? options.decide(answers) : mapAnswers(answers),
    thresholds: options.thresholds,
    fallback: options.fallback,
    timeoutMs,
    onUncertain: options.onUncertain,
    redact: options.redact,
  });
}

export interface DecisionClassifierOptions {
  /** Decision model id, e.g. `"typesafe-ai/jev"`. */
  model: string;
  /** OpenAI-compatible-adjacent base URL. Default: the Vercel AI Gateway. */
  baseURL?: string;
  /** Defaults to AI_GATEWAY_API_KEY / VERCEL_AI_GATEWAY_API_KEY. */
  apiKey?: string;
  /** Classification timeout in ms. Default 15000. */
  timeoutMs?: number;
  thresholds?: ClassifierThresholds;
  fallback?: FallbackStrategy;
  onUncertain?: LatchClassifier;
  redact?: (input: ClassificationInput) => ClassificationInput;
  /** Overrides for the five questions' instructions. */
  instructions?: Partial<DecisionInstructions>;
  /**
   * Replaces the default answer→result mapping. Receives the validated
   * answers (the choice plus the four probabilities); the questions asked are
   * the adapter's five — for fully custom signals, build on createClassifier.
   */
  decide?: (answers: DecisionAnswers) => ClassificationResult | Promise<ClassificationResult>;
  id?: string;
  version?: string;
}

/**
 * The five validated signals a decision-model round trip yields, plus gateway
 * metadata. The choice is the model's raw answer — an off-contract value
 * still fails canonical validation downstream.
 */
export interface DecisionAnswers {
  decision: string;
  relevance: number;
  necessity: number;
  urgency: number;
  confidence: number;
  model?: string;
  usage?: Record<string, unknown>;
  gateway?: Record<string, unknown>;
}

const answersSchema: OutputSchema<DecisionAnswers> = {
  safeParse: (data) => {
    const response = data as EvaluateResponse;
    const answers = response?.answers;
    if (answers === null || typeof answers !== "object") {
      return { success: false, error: new Error("the response carried no answers object") };
    }
    return {
      success: true,
      data: {
        decision: ((answers["decision"] as { choice?: unknown } | undefined)?.choice ??
          "") as string,
        relevance: probabilityOf(answers, "relevance"),
        necessity: probabilityOf(answers, "necessity"),
        urgency: probabilityOf(answers, "urgency"),
        confidence: probabilityOf(answers, "confidence"),
        model: response.model,
        usage: response.usage,
        gateway: response.providerMetadata?.gateway as Record<string, unknown> | undefined,
      },
    };
  },
};

function probabilityOf(answers: Record<string, unknown>, key: string): number {
  return (answers[key] as { probability?: unknown } | undefined)?.probability as number;
}

/** The instructions sent for each question; defaults fit latch's contract. */
export interface DecisionInstructions {
  decision: string;
  relevance: string;
  necessity: string;
  urgency: string;
  confidence: string;
}

const DEFAULT_INSTRUCTIONS: DecisionInstructions = {
  decision:
    "Should the agent run this proposed tool call now? The call is already permitted; judge only whether it fits the task and context.",
  relevance: "Does this proposed call serve the task objective at all?",
  necessity: "Would the task fail or meaningfully degrade without this call?",
  urgency: "Is delaying this call costly right now?",
  confidence: "Is the provided context sufficient to make this judgment confidently?",
};

interface HttpConfig {
  model: string;
  baseURL: string;
  apiKey: string | undefined;
  timeoutMs: number;
  instructions: DecisionInstructions;
}

interface EvaluateResponse {
  model?: string;
  answers?: Record<string, unknown>;
  usage?: Record<string, unknown>;
  providerMetadata?: { gateway?: { cost?: string; generationId?: string } };
}

async function requestEvaluation(
  http: HttpConfig,
  input: ClassificationInput,
): Promise<EvaluateResponse> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), http.timeoutMs);
  timeout.unref?.();
  let response: Response;
  try {
    response = await fetch(`${http.baseURL}/evaluate`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${http.apiKey}` },
      // The state is the classification input as-is: the endpoint accepts
      // structured state, so nothing is stringified by hand.
      body: JSON.stringify({
        model: http.model,
        state: input,
        questions: {
          decision: {
            type: "choice",
            instructions: http.instructions.decision,
            criteria: {
              execute: "the call clearly serves the stated task, and the task needs it now or soon",
              skip: "the call is unnecessary, premature, redundant, or unrelated to the task",
              abstain: "the provided context is genuinely insufficient to tell",
            },
          },
          relevance: { type: "boolean", instructions: http.instructions.relevance },
          necessity: { type: "boolean", instructions: http.instructions.necessity },
          urgency: { type: "boolean", instructions: http.instructions.urgency },
          confidence: { type: "boolean", instructions: http.instructions.confidence },
        },
      }),
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timeout);
  }
  const text = await response.text();
  if (!response.ok) {
    throw new Error(`the endpoint returned HTTP ${response.status}: ${text.slice(0, 300)}`);
  }
  try {
    return JSON.parse(text) as EvaluateResponse;
  } catch {
    throw new Error(`the endpoint returned non-JSON output: ${text.slice(0, 200)}`);
  }
}

function mapAnswers(answers: DecisionAnswers): ClassificationResult {
  return {
    decision: answers.decision as ClassificationResult["decision"],
    scores: {
      relevance: answers.relevance,
      necessity: answers.necessity,
      urgency: answers.urgency,
    },
    confidence: answers.confidence,
    metadata: {
      ...(answers.model !== undefined ? { model: answers.model } : {}),
      ...(answers.usage !== undefined ? { usage: answers.usage } : {}),
      ...(answers.gateway !== undefined ? { gateway: answers.gateway } : {}),
    },
  };
}

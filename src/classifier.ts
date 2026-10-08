import type { ClassificationHistoryEntry } from "./history.js";
import type {
  ClassifierThresholds,
  FallbackStrategy,
  InvocationConditions,
  InvocationStrategy,
} from "./types.js";

/**
 * Everything a classifier may consider when judging a proposed action. Every
 * field except the identifiers is optional-shaped on purpose: agent frameworks
 * expose wildly different context, and the contract supports data minimization
 * (see `redact` on createClassifier) so only what a model needs is sent.
 */
export interface ClassificationInput {
  agent: {
    id: string;
    name?: string;
  };
  task: {
    id?: string;
    objective: string;
    description?: string;
    /** The agent's own claim about urgency — context to weigh, never authority. */
    urgency?: "low" | "medium" | "high" | "critical";
  };
  action: {
    tool: string;
    arguments: Record<string, unknown>;
  };
  context: {
    currentMessage?: string;
    conversation?: unknown[];
    taskState?: Record<string, unknown>;
  };
  history?: ClassificationHistoryEntry[];
}

export type ClassifierDecision = "execute" | "skip" | "abstain";

export interface ClassificationScores {
  /** Does this call serve the task objective at all? */
  relevance: number;
  /** Would the task fail or degrade without this call? */
  necessity: number;
  /** Is delaying this call costly right now? */
  urgency: number;
}

/**
 * The validated output every classifier must normalize to. Scores and
 * confidence are [0, 1]. Confidence is the classifier's self-assessed
 * certainty, not a calibrated probability that the decision is correct.
 */
export interface ClassificationResult {
  decision: ClassifierDecision;
  scores: ClassificationScores;
  confidence: number;
  reason?: string;
  metadata?: Record<string, unknown>;
}

export type ExecutionRecommendation = "execute" | "skip" | "review";

/**
 * The classifier's verdict after validation and thresholds. `via` distinguishes
 * the model's own judgment from an outcome the configuration produced because
 * the model failed, abstained, or was low-confidence — the engine reads it
 * (with the classifier's `fallback`) to decide whether a `deny` fallback
 * applies. Never a throw: classification failures are values, fail closed.
 */
export type ClassificationOutcome =
  | {
      ok: true;
      via: "model" | "fallback";
      execution: ExecutionRecommendation;
      result: ClassificationResult;
      evaluatorId: string;
      evaluatorVersion?: string;
      /** True when an `onUncertain` fallback evaluator produced the result. */
      escalated: boolean;
    }
  | {
      ok: false;
      via: "fallback";
      execution: "skip" | "review";
      fallback: FallbackStrategy;
      error: string;
      evaluatorId: string;
    };

/** A model-agnostic classifier. Build one with createClassifier. */
export interface LatchClassifier {
  readonly id: string;
  readonly version?: string;
  /** Configured failure strategy; the engine honors `"deny"` by denying. */
  readonly fallback: FallbackStrategy;
  /** Default invocation strategy, overridden by policy settings when present. */
  readonly invoke?: InvocationStrategy;
  readonly conditions?: InvocationConditions;
  /** The second-level maximum escalation depth is an internal guard. */
  classify(input: ClassificationInput, escalationDepth?: number): Promise<ClassificationOutcome>;
}

/**
 * A structural validator for model output — the "schema" half of a custom
 * classifier contract. Two accepted shapes:
 * - an object with a zod-style `safeParse` (zod, and wrappers around it), or
 * - a plain function that parses or throws (valibot, arktype, hand-rolled).
 *
 * Latch ships no validation dependency; schemas are duck-typed on purpose.
 */
export type OutputSchema<TOutput> =
  | {
      safeParse: (
        data: unknown,
      ) => { success: true; data: TOutput } | { success: false; error: { message?: string } };
    }
  | ((data: unknown) => TOutput);

export interface CreateClassifierOptions<
  TModel = unknown,
  TRaw = unknown,
  TOutput = ClassificationResult,
> {
  /**
   * The model instance — opaque to latch. Anything with a `predict` method, or
   * supply `predict` yourself to invoke it however your model works.
   */
  model: TModel;
  /** How to run the model. Defaults to `model.predict(input)`. */
  predict?: (model: TModel, input: ClassificationInput) => TRaw | Promise<TRaw>;
  /**
   * What the model's output looks like. Validated before anything else sees
   * it — output that fails the schema is a classifier failure and resolves
   * through the fallback. Without a schema, the raw output must satisfy the
   * canonical ClassificationResult contract.
   */
  schema?: OutputSchema<TOutput>;
  /**
   * Maps schema-validated output to the canonical ClassificationResult — where
   * domain-specific signals (risk, reversibility, …) become the execute/skip/
   * abstain decision. The mapped result is still validated against the
   * canonical contract, so a buggy mapper fails closed rather than poisoning
   * the policy engine.
   */
  decide?: (output: TOutput) => ClassificationResult | Promise<ClassificationResult>;
  thresholds?: ClassifierThresholds;
  /** Failure strategy: skip the call, ask for review, or deny. Default `"skip"`. */
  fallback?: FallbackStrategy;
  /** Classification timeout in ms. Default 10000. */
  timeoutMs?: number;
  /**
   * Default invocation strategy for this classifier, used when the policy does
   * not configure one: "always" (default), "conditional", or "manual".
   */
  invoke?: InvocationStrategy;
  /** Conditions for `invoke: "conditional"`. */
  conditions?: InvocationConditions;
  /**
   * Fallback evaluator for abstentions and (when it is itself uncertain) the
   * gap a small model leaves — typically a larger LLM judge.
   */
  onUncertain?: LatchClassifier;
  /**
   * Data minimization: transform the input before it reaches the model. Strip
   * messages, arguments, or history the model should not see.
   */
  redact?: (input: ClassificationInput) => ClassificationInput;
  id?: string;
  version?: string;
}

const DEFAULT_EXECUTE_THRESHOLD = 0.85;
const DEFAULT_REVIEW_THRESHOLD = 0.55;
const DEFAULT_TIMEOUT_MS = 10_000;
const MAX_ESCALATION_DEPTH = 3;

export function createClassifier<TModel = unknown, TRaw = unknown, TOutput = ClassificationResult>(
  options: CreateClassifierOptions<TModel, TRaw, TOutput>,
): LatchClassifier {
  if (options === null || typeof options !== "object") {
    throw new TypeError("latch: createClassifier expects an options object");
  }
  if (!("model" in options)) {
    throw new TypeError(
      "latch: createClassifier requires a model — pass your classifier implementation (anything with a predict method), or a predict function that invokes it",
    );
  }

  const hasExplicitPredict = options.predict !== undefined;
  if (!hasExplicitPredict) {
    const callable = options.model as { predict?: unknown } | null;
    if (
      callable === null ||
      typeof callable !== "object" ||
      typeof callable.predict !== "function"
    ) {
      throw new TypeError(
        "latch: the classifier model has no predict method — pass one via the predict option, e.g. predict: (model, input) => model.run(input)",
      );
    }
  }
  const predict =
    options.predict ??
    ((model: TModel, classificationInput: ClassificationInput) => {
      return (model as { predict: (i: ClassificationInput) => TRaw }).predict(classificationInput);
    });
  const schema = options.schema;
  const decide = options.decide;
  const thresholds = resolveThresholds(options.thresholds);
  const fallback = options.fallback ?? "skip";
  if (fallback !== "skip" && fallback !== "review" && fallback !== "deny") {
    throw new TypeError(
      `latch: classifier fallback must be "skip", "review", or "deny" (got ${JSON.stringify(fallback)})`,
    );
  }
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  if (typeof timeoutMs !== "number" || !Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new TypeError(
      `latch: classifier timeoutMs must be a positive number of milliseconds (got ${JSON.stringify(options.timeoutMs)})`,
    );
  }
  const id = options.id ?? "classifier";
  const redact = options.redact;
  const onUncertain = options.onUncertain;

  return {
    id,
    version: options.version,
    fallback,
    invoke: options.invoke,
    conditions: options.conditions,
    async classify(
      input: ClassificationInput,
      escalationDepth = 0,
    ): Promise<ClassificationOutcome> {
      const prepared = redact ? redact(input) : input;
      const failure = (error: string): ClassificationOutcome => ({
        ok: false,
        via: "fallback",
        execution: fallback === "deny" ? "skip" : fallback,
        fallback,
        error,
        evaluatorId: id,
      });

      let result: ClassificationResult;
      try {
        const raw = await withTimeout(Promise.resolve(predict(options.model, prepared)), timeoutMs);
        const output = schema !== undefined ? applySchema(schema, raw) : raw;
        const candidate =
          decide !== undefined
            ? await runDecide(decide, output as TOutput)
            : (output as ClassificationResult);
        const validated = validateClassificationResult(candidate);
        if (!validated.ok) return failure(validated.error);
        result = validated.result;
      } catch (error) {
        return failure(error instanceof Error ? error.message : String(error));
      }

      return resolve(result, prepared, escalationDepth);
    },
  };

  async function resolve(
    result: ClassificationResult,
    prepared: ClassificationInput,
    depth: number,
  ): Promise<ClassificationOutcome> {
    const from = { evaluatorId: id, evaluatorVersion: options.version, escalated: false };

    if (result.decision === "skip") {
      // A confidence threshold never converts an explicit skip into execute.
      return { ok: true, via: "model", execution: "skip", result, ...from };
    }

    if (result.decision === "abstain") {
      if (onUncertain !== undefined && depth < MAX_ESCALATION_DEPTH) {
        const escalated = await onUncertain.classify(prepared, depth + 1);
        return escalated.ok ? { ...escalated, escalated: true } : escalated;
      }
      return {
        ok: true,
        via: "fallback",
        execution: fallback === "deny" ? "skip" : fallback === "review" ? "review" : "skip",
        result,
        ...from,
      };
    }

    // decision === "execute": floors first — a weak dimension is review, not failure.
    for (const dimension of ["relevance", "necessity", "urgency"] as const) {
      const floor = thresholds[dimension];
      if (floor !== undefined && result.scores[dimension] < floor) {
        return { ok: true, via: "model", execution: "review", result, ...from };
      }
    }
    if (result.confidence >= thresholds.execute) {
      return { ok: true, via: "model", execution: "execute", result, ...from };
    }
    if (result.confidence >= thresholds.review) {
      return { ok: true, via: "model", execution: "review", result, ...from };
    }
    // Low confidence cannot execute; apply the configured fallback.
    return {
      ok: true,
      via: "fallback",
      execution: fallback === "review" ? "review" : "skip",
      result,
      ...from,
    };
  }
}

export type ValidatedClassification =
  | { ok: true; result: ClassificationResult }
  | { ok: false; error: string };

/**
 * Runtime validation of classifier output. Latch never trusts a model's shape:
 * any deviation is a failure that resolves through the fallback strategy.
 */
export function validateClassificationResult(value: unknown): ValidatedClassification {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return { ok: false, error: `classification output must be an object (got ${describe(value)})` };
  }
  const record = value as Record<string, unknown>;

  if (
    record["decision"] !== "execute" &&
    record["decision"] !== "skip" &&
    record["decision"] !== "abstain"
  ) {
    return {
      ok: false,
      error: `classification decision must be "execute", "skip", or "abstain" (got ${describe(record["decision"])})`,
    };
  }

  const scores = record["scores"];
  if (scores === null || typeof scores !== "object" || Array.isArray(scores)) {
    return {
      ok: false,
      error: `classification scores must be an object (got ${describe(scores)})`,
    };
  }
  const validatedScores: ClassificationScores = { relevance: 0, necessity: 0, urgency: 0 };
  for (const dimension of ["relevance", "necessity", "urgency"] as const) {
    const score = (scores as Record<string, unknown>)[dimension];
    if (typeof score !== "number" || !Number.isFinite(score) || score < 0 || score > 1) {
      return {
        ok: false,
        error: `classification scores.${dimension} must be a number between 0 and 1 (got ${describe(score)})`,
      };
    }
    validatedScores[dimension] = score;
  }

  const confidence = record["confidence"];
  if (
    typeof confidence !== "number" ||
    !Number.isFinite(confidence) ||
    confidence < 0 ||
    confidence > 1
  ) {
    return {
      ok: false,
      error: `classification confidence must be a number between 0 and 1 (got ${describe(confidence)})`,
    };
  }

  if (record["reason"] !== undefined && typeof record["reason"] !== "string") {
    return {
      ok: false,
      error: `classification reason must be a string (got ${describe(record["reason"])})`,
    };
  }
  if (record["metadata"] !== undefined) {
    const metadata = record["metadata"];
    if (metadata === null || typeof metadata !== "object" || Array.isArray(metadata)) {
      return {
        ok: false,
        error: `classification metadata must be an object (got ${describe(metadata)})`,
      };
    }
  }

  return {
    ok: true,
    result: {
      decision: record["decision"],
      scores: validatedScores,
      confidence: record["confidence"] as number,
      reason: record["reason"] as string | undefined,
      metadata: record["metadata"] as Record<string, unknown> | undefined,
    },
  };
}

function describe(value: unknown): string {
  if (value === null) return "null";
  if (value === undefined) return "undefined";
  if (typeof value === "string") return JSON.stringify(value);
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (Array.isArray(value)) return "an array";
  return typeof value;
}

/** Run the schema over raw model output; throws with the schema's reason on failure. */
function applySchema<TOutput>(schema: OutputSchema<TOutput>, raw: unknown): TOutput {
  if (typeof schema === "function") {
    try {
      return schema(raw);
    } catch (error) {
      throw new Error(
        `the model output did not match the schema: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
  const result = schema.safeParse(raw);
  if (!result.success) {
    const reason = result.error?.message ?? "the schema rejected it";
    throw new Error(`the model output did not match the schema: ${reason}`);
  }
  return result.data;
}

async function runDecide<TOutput>(
  decide: (output: TOutput) => ClassificationResult | Promise<ClassificationResult>,
  output: TOutput,
): Promise<ClassificationResult> {
  try {
    return await decide(output);
  } catch (error) {
    throw new Error(
      `the decide mapper threw: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

function resolveThresholds(
  thresholds: ClassifierThresholds | undefined,
): Required<Pick<ClassifierThresholds, "execute" | "review">> & ClassifierThresholds {
  if (thresholds === undefined) {
    return { execute: DEFAULT_EXECUTE_THRESHOLD, review: DEFAULT_REVIEW_THRESHOLD };
  }
  for (const [key, value] of Object.entries(thresholds)) {
    if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 1) {
      throw new TypeError(
        `latch: classifier threshold "${key}" must be a number between 0 and 1 (got ${JSON.stringify(value)})`,
      );
    }
  }
  const execute = thresholds.execute ?? DEFAULT_EXECUTE_THRESHOLD;
  // Keep the bands ordered without punishing an author who only sets `execute`.
  const review = Math.min(thresholds.review ?? DEFAULT_REVIEW_THRESHOLD, execute);
  return { ...thresholds, execute, review };
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`classification timed out after ${timeoutMs}ms`)),
      timeoutMs,
    );
    timer.unref?.();
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

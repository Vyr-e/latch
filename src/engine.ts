import type {
  ClassificationInput,
  ClassificationOutcome,
  ClassificationResult,
  LatchClassifier,
} from "./classifier.js";
import { check } from "./evaluate.js";
import type { DecisionOutcome, HistoryStore, ClassificationHistoryEntry } from "./history.js";
import { newHistoryId } from "./history.js";
import type { InvocationConditions, LatchDecision, LatchPolicy, PolicyMode } from "./types.js";

/**
 * The runtime half of a policy: model bindings and storage that cannot live in
 * the (pure-data) policy itself. Everything here is optional — a runtime with
 * no classifier is exactly today's deterministic latch.
 */
export interface PolicyRuntime {
  /** A resolved classifier. Takes precedence over the policy's provider reference. */
  classifier?: LatchClassifier;
  /** History store. `false` disables recording even when the policy enables it. */
  history?: HistoryStore | false;
  /**
   * How many recent history entries to feed into ClassificationInput.history.
   * Default 0 (off) — feeding history back into classification can reinforce
   * earlier mistakes, so it is an explicit opt-in.
   */
  feedHistory?: number;
}

export interface EvaluateOptions {
  /**
   * Force classification for this call in `manual` invocation mode. Ignored
   * otherwise (the configured strategy decides).
   */
  classify?: boolean;
}

/**
 * The combined decision. Authorization (may this agent do this?) is always
 * separate from execution (should it happen now?): a classifier can affect
 * execution, but never upgrades authorization.
 */
export interface LatchEvaluation {
  action: string;
  authorization: "allow" | "deny" | "requires_approval";
  execution: "execute" | "skip" | "review";
  source: "deterministic" | "classifier" | "hybrid";
  reason?: string;
  /** The classifier's validated output, when one ran. */
  classification?: ClassificationResult;
  /** The underlying deterministic decision, for callers that need rule detail. */
  decision: LatchDecision;
  /** History entry id, when the outcome was recorded. */
  historyId?: string;
}

/**
 * Resolve a policy's `classifier.provider` against a registry of runtime
 * implementations. This is how YAML-referenced classifiers become callable.
 */
export function resolveClassifier(
  policy: LatchPolicy,
  classifiers: Record<string, LatchClassifier> | undefined,
): LatchClassifier | undefined {
  if (policy.classifier === undefined) return undefined;
  const provider = policy.classifier.provider;
  const resolved = classifiers?.[provider];
  if (resolved === undefined) {
    throw new Error(
      `latch: the policy references classifier "${provider}", but no such classifier is registered — pass classifiers: { ${provider}: <LatchClassifier> } to createGate (or classifier: <instance> to bind one directly)`,
    );
  }
  return resolved;
}

/**
 * Evaluate a proposed action end to end: deterministic authorization first
 * (deny wins, constraints fail closed, approvals hold), then — only for calls
 * that pass — contextual classification under the configured invocation rules.
 * Classification failure, invalid output, and timeouts resolve through the
 * fallback strategy; none of them can produce an execution.
 */
export async function evaluate(
  policy: LatchPolicy,
  runtime: PolicyRuntime,
  input: ClassificationInput,
  options: EvaluateOptions = {},
): Promise<LatchEvaluation> {
  const action = input.action.tool;
  const decision = check(policy, action, input.action.arguments);
  const classifier = runtime.classifier;
  const mode: PolicyMode = policy.mode ?? (classifier !== undefined ? "hybrid" : "deterministic");

  if (decision.effect === "deny" || mode === "deterministic" || classifier === undefined) {
    // Lazy inference: a denied call never reaches the model, and a runtime
    // with no classifier has nothing contextual to add.
    return {
      action,
      authorization: toAuthorization(decision.effect),
      execution: decision.effect === "deny" ? "skip" : "execute",
      source: "deterministic",
      decision,
      reason: decision.effect === "deny" ? decision.reason : undefined,
    };
  }

  if (!shouldInvoke(policy, classifier, input, decision, options)) {
    return {
      action,
      authorization: toAuthorization(decision.effect),
      execution: "execute",
      source: "deterministic",
      decision,
    };
  }

  const store = runtime.history || undefined;
  const prepared =
    store !== undefined && (runtime.feedHistory ?? 0) > 0 && store.recent !== undefined
      ? { ...input, history: store.recent(runtime.feedHistory!) }
      : input;

  const outcome = await classifier.classify(prepared);
  const evaluation = resolveOutcome(outcome, classifier, mode, decision, action);
  recordHistory(store, input, evaluation, outcome);
  return evaluation;
}

function resolveOutcome(
  outcome: ClassificationOutcome,
  classifier: LatchClassifier,
  mode: PolicyMode,
  decision: LatchDecision,
  action: string,
): LatchEvaluation {
  const classifiedBy: LatchEvaluation["source"] = mode === "classifier" ? "classifier" : "hybrid";
  const base = {
    action,
    authorization: toAuthorization(decision.effect),
    decision,
  };

  if (outcome.ok) {
    // A fallback-applied "deny" (low confidence or abstention under
    // fallback: deny) restricts; it never widens.
    const deniedByFallback = outcome.via === "fallback" && classifier.fallback === "deny";
    return {
      ...base,
      authorization: deniedByFallback ? "deny" : base.authorization,
      execution: deniedByFallback ? "skip" : outcome.execution,
      source: outcome.via === "fallback" ? "deterministic" : classifiedBy,
      reason: deniedByFallback
        ? `classification was ${outcome.result.decision} below the configured thresholds, and the fallback is "deny"`
        : (outcome.result.reason ??
          (outcome.via === "fallback"
            ? `the classifier's "${outcome.result.decision}" recommendation fell below the configured thresholds`
            : undefined)),
      classification: outcome.result,
    };
  }

  // Classification failed — invalid output, timeout, unavailable model. The
  // fallback may deny, but it never executes.
  const denied = outcome.fallback === "deny";
  return {
    ...base,
    authorization: denied ? "deny" : base.authorization,
    execution: denied ? "skip" : outcome.execution,
    source: "deterministic",
    reason: `classification failed (${outcome.error}) — fallback "${outcome.fallback}" applied`,
  };
}

function shouldInvoke(
  policy: LatchPolicy,
  classifier: LatchClassifier,
  input: ClassificationInput,
  decision: LatchDecision,
  options: EvaluateOptions,
): boolean {
  if (options.classify === true) return true;
  const settings = policy.classifier;
  const strategy = settings?.invoke ?? classifier.invoke ?? "always";
  if (strategy === "always") return true;
  if (strategy === "manual") return false;
  const conditions: InvocationConditions = settings?.conditions ?? classifier.conditions ?? {};
  if (conditions.onUrgency && input.task.urgency !== undefined) return true;
  if (conditions.onUnmatched && !matchedExactly(decision)) return true;
  return false;
}

/**
 * "Matched" means an exact allow rule spoke to this action. Wildcards
 * (`stripe.*`, `*`) and the default fallback authorize broadly — exactly the
 * situations where a classifier fills the contextual gap.
 */
function matchedExactly(decision: LatchDecision): boolean {
  const pattern = decision.matched?.pattern;
  return (
    pattern !== undefined && pattern !== "(default)" && !pattern.endsWith(".*") && pattern !== "*"
  );
}

function toAuthorization(effect: LatchDecision["effect"]): LatchEvaluation["authorization"] {
  return effect === "approval" ? "requires_approval" : effect;
}

function recordHistory(
  store: HistoryStore | undefined,
  input: ClassificationInput,
  evaluation: LatchEvaluation,
  outcome: ClassificationOutcome,
): void {
  if (store === undefined) return;
  const outcomeRecord: DecisionOutcome = {
    authorization: evaluation.authorization,
    execution: evaluation.execution,
    source: evaluation.source,
  };
  const entry: ClassificationHistoryEntry = {
    id: newHistoryId(),
    timestamp: Date.now(),
    agentId: input.agent.id,
    taskId: input.task.id,
    tool: input.action.tool,
    decision: outcome.ok ? outcome.result.decision : "none",
    confidence: outcome.ok ? outcome.result.confidence : 0,
    scores: outcome.ok ? outcome.result.scores : { relevance: 0, necessity: 0, urgency: 0 },
    executed: false,
    evaluatorId: outcome.evaluatorId,
    evaluatorVersion: outcome.ok ? (outcome.evaluatorVersion ?? undefined) : undefined,
    reason: outcome.ok ? outcome.result.reason : outcome.error,
    outcome: outcomeRecord,
  };
  evaluation.historyId = entry.id;
  // History is observability: a failing or slow store must never change a decision.
  try {
    void Promise.resolve(store.record(entry)).catch(() => {});
  } catch {
    // ignored on purpose
  }
}

import {
  LatchApprovalRequiredError,
  LatchDeniedError,
  LatchReviewRequiredError,
  LatchSkippedError,
} from "./errors.js";
import { writeActionTypes } from "./codegen.js";
import type { ClassificationInput, LatchClassifier } from "./classifier.js";
import { check } from "./evaluate.js";
import { evaluate, resolveClassifier } from "./engine.js";
import type { EvaluateOptions, LatchEvaluation, PolicyRuntime } from "./engine.js";
import type { HistoryStore } from "./history.js";
import { createMemoryHistory } from "./history.js";
import { loadPolicy } from "./load.js";
import type { LatchDecision, LatchPolicy } from "./types.js";

/**
 * Anything with an execute — an AI SDK tool, an eve tool, or a plain object.
 * wrap preserves the full type of what it wraps, so framework tool types flow
 * through unchanged.
 */
export interface LatchToolLike {
  execute: (...args: never[]) => unknown;
}

/**
 * Filled in by `latch-env.d.ts`, which `latch init`, `latch types`, and
 * createGate generate from latch.yaml. Once it registers an `action` union,
 * every gate narrows to those names without a type argument.
 */
export interface Register {}

/** The action names registered from latch.yaml, or `string` until latch-env.d.ts exists. */
export type RegisteredAction = Register extends { action: infer Action extends string }
  ? Action
  : string;

export interface ApprovalRequest<Action extends string = string> {
  action: Action;
  input: unknown;
  decision: LatchDecision & { effect: "approval" };
}

export type ApprovalHandler<Action extends string = string> = (
  request: ApprovalRequest<Action>,
) => boolean | Promise<boolean>;

export interface LatchGateOptions<Action extends string = string> {
  /** A parsed policy, or a path to a `latch.yaml` file. */
  policy: LatchPolicy | string;
  /**
   * Called when the policy requires human approval. Return true to proceed.
   * Default: throw LatchApprovalRequiredError, which durable runtimes can
   * catch and turn into a pause-and-resume prompt.
   */
  onApproval?: ApprovalHandler<Action>;
  /**
   * Keep `latch-env.d.ts` beside the policy file in sync whenever the gate
   * loads it, so action names autocomplete without running `latch types`.
   * Default: on, except when NODE_ENV is "production".
   */
  types?: boolean;
  /** Bind a classifier instance directly — the runtime half of `mode: hybrid`. */
  classifier?: LatchClassifier;
  /**
   * Registry of classifiers a policy file may reference by provider name:
   * `classifiers: { judge: myJudge }` resolves `classifier: { provider: judge }`.
   */
  classifiers?: Record<string, LatchClassifier>;
  /**
   * History store for classification decisions. `false` disables recording
   * even when the policy enables it. Default: an in-memory store when the
   * policy sets `history: { enabled: true }`, otherwise none.
   */
  history?: HistoryStore | false;
  /** How many recent history entries to feed into classifications. Default 0 (off). */
  feedHistory?: number;
  /**
   * When true (default), a bound classifier also gates `wrap`: calls the
   * classifier judges inappropriate throw instead of running. Set false to
   * classify for observability only (via gate.evaluate) while wrap stays
   * purely deterministic.
   */
  enforce?: boolean;
  /**
   * Supplies the situation around a wrapped call — everything a classifier
   * considers except the action itself. Required when a classifier enforces
   * wrap; without it there is no context to classify against.
   */
  situation?: (input: unknown) => Omit<ClassificationInput, "action">;
}

/**
 * A policy-bound checker and tool wrapper. `Action` narrows the action names
 * check/assert/wrap accept; it defaults to the names registered from
 * latch.yaml by `latch types`, or any string before that.
 */
export interface LatchGate<Action extends string = RegisteredAction> {
  readonly policy: LatchPolicy;
  /** Absolute path the policy was loaded from, when loaded from disk. */
  readonly file?: string;
  /** The bound history store, when one is. */
  readonly history?: HistoryStore;
  /** Evaluate an action without executing anything. */
  check: (action: Action, input?: unknown) => LatchDecision;
  /** Like check, but throws LatchDeniedError / LatchApprovalRequiredError. */
  assert: (action: Action, input?: unknown) => LatchDecision;
  /**
   * Full contextual evaluation: deterministic authorization plus (when a
   * classifier is bound) an execution recommendation. Inspect-only — it never
   * executes or records "executed" history.
   */
  evaluate: (input: ClassificationInput, options?: EvaluateOptions) => Promise<LatchEvaluation>;
  /**
   * Wrap a tool so its execute only runs when the policy allows. Every other
   * property is preserved, so it drops into defineTool-style registries
   * unchanged. With a classifier bound and enforce on (the default), wrapped
   * calls the classifier judges inappropriate throw before running.
   */
  wrap: <Tool extends LatchToolLike>(action: Action, tool: Tool) => Tool;
}

/**
 * Create a gate: a policy-bound checker and tool wrapper. This is the
 * enforcement surface; the YAML file is the declaration surface.
 *
 * Action names autocomplete and type-check against latch.yaml through
 * `latch-env.d.ts`, which loading the policy here keeps in sync:
 *
 * ```ts
 * const gate = createGate({ policy: "latch.yaml" });
 * gate.wrap("stripe.refund.create", tool); // type error: not in latch.yaml
 * ```
 *
 * A type argument overrides the registered names for one gate.
 */
export function createGate<Action extends string = RegisteredAction>(
  options: LatchGateOptions<Action>,
): LatchGate<Action> {
  const { policy, file } = load(
    options.policy,
    options.types ?? process.env["NODE_ENV"] !== "production",
  );
  const onApproval = options.onApproval;

  const classifier = options.classifier ?? resolveClassifier(policy, options.classifiers);
  const mode = policy.mode ?? (classifier !== undefined ? "hybrid" : "deterministic");
  if (mode === "deterministic" && classifier !== undefined) {
    throw new Error(
      "latch: the policy sets mode: deterministic, but a classifier is bound — set mode: hybrid in the policy, or remove the classifier binding",
    );
  }
  if (mode !== "deterministic" && classifier === undefined) {
    // Wrapped tools would otherwise run every authorized call unjudged.
    throw new Error(
      `latch: the policy sets mode: ${mode}, but no classifier is bound — pass classifier: <LatchClassifier> (or classifiers: { name: … } with a classifier block) to createGate, or set mode: deterministic`,
    );
  }
  const enforce = options.enforce ?? true;
  const enforceClassifier = classifier !== undefined && mode !== "deterministic" && enforce;
  const situation = options.situation;

  const historyStore =
    options.history === false
      ? undefined
      : (options.history ??
        (policy.history?.enabled
          ? createMemoryHistory({ maxEntries: policy.history.maxEntries })
          : undefined));
  const runtime: PolicyRuntime = {
    classifier,
    history: historyStore ?? false,
    feedHistory: options.feedHistory,
  };

  function checkAction(action: Action, input?: unknown): LatchDecision {
    return check(policy, action, input);
  }

  function assert(action: Action, input?: unknown): LatchDecision {
    const decision = checkAction(action, input);
    if (decision.effect === "deny") throw new LatchDeniedError(action, decision.reason);
    if (decision.effect === "approval")
      throw new LatchApprovalRequiredError(action, decision.reason);
    return decision;
  }

  async function evaluateInput(
    input: ClassificationInput,
    evaluateOptions?: EvaluateOptions,
  ): Promise<LatchEvaluation> {
    return evaluate(policy, runtime, input, evaluateOptions);
  }

  function wrap<Tool extends LatchToolLike>(action: Action, tool: Tool): Tool {
    if (enforceClassifier && situation === undefined) {
      throw new Error(
        `latch: wrapping "${action}" needs a situation for the classifier — pass situation: (input) => ({ agent, task, context }) to createGate so the classifier knows what the call is for`,
      );
    }
    const execute = async (input: unknown, ...args: unknown[]) => {
      const decision = checkAction(action, input);
      if (decision.effect === "deny") {
        throw new LatchDeniedError(action, decision.reason);
      }

      let historyId: string | undefined;
      if (enforceClassifier) {
        const classificationInput: ClassificationInput = {
          ...situation!(input),
          action: { tool: action, arguments: toArguments(input) },
        };
        const evaluation = await evaluateInput(classificationInput);
        historyId = evaluation.historyId;
        // Precedence: the classifier may restrict (skip/review/deny-fallback),
        // never widen. Deterministic denials threw above; approvals run below.
        if (evaluation.authorization === "deny") {
          throw new LatchDeniedError(
            action,
            evaluation.reason ?? "the contextual layer denied this call",
          );
        }
        if (evaluation.execution === "skip") {
          throw new LatchSkippedError(action, evaluation.reason);
        }
        if (evaluation.execution === "review") {
          throw new LatchReviewRequiredError(action, evaluation.reason);
        }
      }

      if (decision.effect === "approval") {
        const request: ApprovalRequest<Action> = { action, input, decision };
        const approved = onApproval ? await onApproval(request) : false;
        if (!approved) throw new LatchApprovalRequiredError(action, decision.reason);
      }
      const result = await (tool.execute as (i: unknown, ...a: unknown[]) => unknown).call(
        tool,
        input,
        ...args,
      );
      if (historyId !== undefined && historyStore?.markExecuted !== undefined) {
        try {
          void Promise.resolve(historyStore.markExecuted(historyId)).catch(() => {});
        } catch {
          // history is observability; it must not break the call it recorded
        }
      }
      return result;
    };
    return { ...tool, execute } as Tool;
  }

  return {
    policy,
    file,
    history: historyStore,
    check: checkAction,
    assert,
    evaluate: evaluateInput,
    wrap,
  };
}

function toArguments(input: unknown): Record<string, unknown> {
  if (input !== null && typeof input === "object" && !Array.isArray(input)) {
    return input as Record<string, unknown>;
  }
  return input === undefined ? {} : { value: input };
}

function load(
  policy: LatchPolicy | string,
  types: boolean,
): { policy: LatchPolicy; file?: string } {
  if (typeof policy !== "string") return { policy };
  const loaded = loadPolicy(policy);
  if (types) {
    try {
      writeActionTypes(loaded.policy, loaded.file);
    } catch {
      // Types are a dev convenience; a read-only filesystem must not break the gate.
    }
  }
  return { policy: loaded.policy, file: loaded.file };
}

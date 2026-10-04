import { LatchApprovalRequiredError, LatchDeniedError } from "./errors.js";
import { writeActionTypes } from "./codegen.js";
import { check } from "./evaluate.js";
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
  /** Evaluate an action without executing anything. */
  check: (action: Action, input?: unknown) => LatchDecision;
  /** Like check, but throws LatchDeniedError / LatchApprovalRequiredError. */
  assert: (action: Action, input?: unknown) => LatchDecision;
  /**
   * Wrap a tool so its execute only runs when the policy allows. Every other
   * property is preserved, so it drops into defineTool-style registries
   * unchanged.
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

  function wrap<Tool extends LatchToolLike>(action: Action, tool: Tool): Tool {
    const execute = async (input: unknown, ...args: unknown[]) => {
      const decision = checkAction(action, input);
      if (decision.effect === "deny") {
        throw new LatchDeniedError(action, decision.reason);
      }
      if (decision.effect === "approval") {
        const request: ApprovalRequest<Action> = { action, input, decision };
        const approved = onApproval ? await onApproval(request) : false;
        if (!approved) throw new LatchApprovalRequiredError(action, decision.reason);
      }
      return (tool.execute as (i: unknown, ...a: unknown[]) => unknown).call(tool, input, ...args);
    };
    return { ...tool, execute } as Tool;
  }

  return { policy, file, check: checkAction, assert, wrap };
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

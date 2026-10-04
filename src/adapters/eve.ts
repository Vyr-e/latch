import { check } from "../evaluate.js";
import type { LatchGate } from "../gate.js";
import type { LatchPolicy } from "../types.js";

/**
 * eve's request-time approval statuses, mapped from a latch decision.
 * Kept as plain strings/objects — no eve import, so latch stays independent.
 */
export type EveApprovalStatus =
  | "approved"
  | "denied"
  | "user-approval"
  | { readonly type: "approved"; readonly reason?: string }
  | { readonly type: "denied"; readonly reason: string };

export interface EveApprovalContext {
  readonly toolName: string;
  readonly toolInput?: unknown;
}

/**
 * Turn a latch gate into an eve `approval` policy. Attach it to any authored
 * eve tool, and the YAML file becomes that tool's permission source:
 *
 * ```ts
 * import { defineTool } from "eve/tools";
 * import { toEveApprovalPolicy } from "@vyr-e/latch";
 *
 * export default defineTool({
 *   approval: toEveApprovalPolicy(gate),
 *   // ...
 * });
 * ```
 */
export function toEveApprovalPolicy<Action extends string>(
  source: LatchGate<Action> | LatchPolicy,
): (ctx: EveApprovalContext) => EveApprovalStatus {
  const policy =
    typeof (source as LatchGate<Action>).policy === "object"
      ? (source as LatchGate<Action>).policy
      : (source as LatchPolicy);

  return ({ toolName, toolInput }) => {
    const decision = check(policy, toolName, toolInput);
    switch (decision.effect) {
      case "allow":
        return decision.reason !== undefined
          ? { type: "approved", reason: decision.reason }
          : "approved";
      case "approval":
        return "user-approval";
      case "deny":
        return { type: "denied", reason: decision.reason };
    }
  };
}

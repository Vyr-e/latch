export type {
  ApprovalRequest,
  ApprovalHandler,
  LatchGate,
  LatchGateOptions,
  LatchToolLike,
  Register,
  RegisteredAction,
} from "./gate.js";
export { actionType, renderActionTypes } from "./codegen.js";
export type { RenderActionTypesOptions } from "./codegen.js";
export { createGate } from "./gate.js";
export { check } from "./evaluate.js";
export { parsePolicy } from "./parse.js";
export { findPolicyFile, loadPolicy } from "./load.js";
export type { LoadedPolicy } from "./load.js";
export { renderPrompt } from "./prompt.js";
export type { RenderPromptOptions } from "./prompt.js";
export { patternMatches, specificity } from "./match.js";
export { findAmount, findAmounts, findPathValues, pathMatches } from "./constraints.js";
export { toEveApprovalPolicy } from "./adapters/eve.js";
export type { EveApprovalStatus, EveApprovalContext } from "./adapters/eve.js";
export {
  LatchError,
  LatchParseError,
  LatchDeniedError,
  LatchApprovalRequiredError,
} from "./errors.js";
export type { LatchIssue } from "./errors.js";
export type { Constraints, LatchPolicy, MatchedRule, Rule, LatchDecision } from "./types.js";

import type { LatchPolicy } from "./types.js";

/**
 * Type-checked authoring helper for policies written in TypeScript instead of
 * YAML. The result is a plain LatchPolicy — same engine, same semantics.
 */
export function definePolicy(policy: {
  agent?: string;
  default?: "deny" | "allow";
  allow?: Array<RuleInput>;
  deny?: Array<RuleInput>;
}): LatchPolicy {
  return {
    agent: policy.agent,
    version: 1,
    default: policy.default ?? "deny",
    allow: (policy.allow ?? []).map(normalizeRule),
    deny: (policy.deny ?? []).map(normalizeRule),
  };
}

interface RuleInput {
  action: string;
  maxAmount?: number;
  approval?: "required" | "never";
  paths?: string[];
  description?: string;
}

function normalizeRule(rule: RuleInput): LatchPolicy["allow"][number] {
  const constraints: LatchPolicy["allow"][number]["constraints"] = {};
  if (rule.maxAmount !== undefined) constraints.maxAmount = rule.maxAmount;
  if (rule.approval !== undefined) constraints.approval = rule.approval;
  if (rule.paths !== undefined) constraints.paths = rule.paths;
  if (rule.description !== undefined) constraints.description = rule.description;
  return { action: rule.action, constraints };
}

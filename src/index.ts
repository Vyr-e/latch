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
export { createLLMJudge } from "./adapters/llm-judge.js";
export type { LLMJudgeOptions } from "./adapters/llm-judge.js";
export { createDecisionClassifier } from "./adapters/decision-judge.js";
export type { DecisionClassifierOptions, DecisionInstructions } from "./adapters/decision-judge.js";
export { createClassifier, validateClassificationResult } from "./classifier.js";
export type {
  ClassificationInput,
  ClassificationResult,
  ClassificationScores,
  ClassificationOutcome,
  ClassifierDecision,
  CreateClassifierOptions,
  ExecutionRecommendation,
  LatchClassifier,
  OutputSchema,
  ValidatedClassification,
} from "./classifier.js";
export { evaluate, resolveClassifier } from "./engine.js";
export type { EvaluateOptions, LatchEvaluation, PolicyRuntime } from "./engine.js";
export { createMemoryHistory, MemoryHistoryStore } from "./history.js";
export type {
  ClassificationHistoryEntry,
  DecisionOutcome,
  HistoryStore,
  MemoryHistoryOptions,
} from "./history.js";
export {
  LatchError,
  LatchParseError,
  LatchDeniedError,
  LatchApprovalRequiredError,
  LatchReviewRequiredError,
  LatchSkippedError,
} from "./errors.js";
export type { LatchIssue } from "./errors.js";
export type {
  ClassifierSettings,
  ClassifierThresholds,
  Constraints,
  FallbackStrategy,
  HistorySettings,
  InvocationConditions,
  InvocationStrategy,
  LatchPolicy,
  MatchedRule,
  PolicyMode,
  Rule,
  LatchDecision,
} from "./types.js";

import type { LatchPolicy, PolicyMode } from "./types.js";

/**
 * Type-checked authoring helper for policies written in TypeScript instead of
 * YAML. The result is a plain LatchPolicy — same engine, same semantics.
 * Classifier implementations and history stores are runtime concerns: bind
 * them with createGate, not here, so a policy stays serializable data.
 */
export function definePolicy(policy: {
  agent?: string;
  default?: "deny" | "allow";
  allow?: Array<RuleInput>;
  deny?: Array<RuleInput>;
  mode?: PolicyMode;
}): LatchPolicy {
  return {
    agent: policy.agent,
    version: 1,
    default: policy.default ?? "deny",
    allow: (policy.allow ?? []).map(normalizeRule),
    deny: (policy.deny ?? []).map(normalizeRule),
    ...(policy.mode !== undefined ? { mode: policy.mode } : {}),
  };
}

interface RuleInput {
  action: string;
  maxAmount?: number;
  approval?: "required" | "never";
  paths?: string[];
  pathFields?: string[];
  description?: string;
}

function normalizeRule(rule: RuleInput): LatchPolicy["allow"][number] {
  const constraints: LatchPolicy["allow"][number]["constraints"] = {};
  if (rule.maxAmount !== undefined) constraints.maxAmount = rule.maxAmount;
  if (rule.approval !== undefined) constraints.approval = rule.approval;
  if (rule.paths !== undefined) constraints.paths = rule.paths;
  if (rule.pathFields !== undefined) constraints.pathFields = rule.pathFields;
  if (rule.description !== undefined) constraints.description = rule.description;
  return { action: rule.action, constraints };
}

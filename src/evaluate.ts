import {
  checkConstraints,
  denyPathsFire,
  describeValue,
  findAmounts,
  findMalformedAmount,
} from "./constraints.js";
import { bySpecificity, patternMatches } from "./match.js";
import type { LatchDecision, LatchPolicy, MatchedRule, Rule } from "./types.js";

/**
 * Evaluate one action (with its input) against a policy.
 *
 * Order of authority, in line with fail-closed defaults:
 * 1. Any matching deny rule wins — even against a more specific allow rule.
 * 2. The most specific matching allow rule decides; its constraints must pass
 *    (a failing constraint is a denial with the reason, and `approval:
 *    required` downgrades an allow to an approval decision).
 * 3. No matching allow rule: denied by default (or allowed, when the policy
 *    sets `default: allow` — deny rules still fire first).
 */
export function check(policy: LatchPolicy, action: string, input?: unknown): LatchDecision {
  if (typeof action !== "string" || action.trim() === "") {
    throw new Error("latch: action must be a non-empty string");
  }

  const matchedDeny = findFiringDeny(policy, action, input);
  if (matchedDeny) {
    return {
      effect: "deny",
      action,
      matched: matched(matchedDeny, "deny"),
      reason: matchedDeny.constraints.description ?? denyReason(matchedDeny, action, input),
    };
  }

  const allowRule = findAllowRule(policy, action);
  if (allowRule === undefined) {
    if (policy.default === "allow") {
      return { effect: "allow", action, matched: defaultMatched("allow") };
    }
    return {
      effect: "deny",
      action,
      reason:
        `"${action}" is not in the policy's allow list` +
        (policy.default === "deny" ? " (latch is default-deny)" : ""),
    };
  }

  const matchedAllow = matched(allowRule, "allow");
  const result = checkConstraints(allowRule.constraints, input);
  if (!result.ok) {
    return {
      effect: "deny",
      action,
      matched: matchedAllow,
      reason: result.reason ?? "a rule constraint failed",
    };
  }
  if (allowRule.constraints.approval === "required") {
    return {
      effect: "approval",
      action,
      matched: matchedAllow,
      reason:
        allowRule.constraints.description ??
        `the matched rule requires human approval before this call runs`,
    };
  }
  return {
    effect: "allow",
    action,
    matched: matchedAllow,
    reason: allowRule.constraints.description,
  };
}

function findFiringDeny(policy: LatchPolicy, action: string, input: unknown): Rule | undefined {
  for (const rule of bySpecificity(policy.deny)) {
    if (!patternMatches(rule.action, action)) continue;
    const unconditional =
      rule.constraints.paths === undefined && rule.constraints.maxAmount === undefined;
    if (unconditional) return rule;
    if (rule.constraints.paths !== undefined && denyPathsFire(rule.constraints, input)) return rule;
    if (rule.constraints.maxAmount !== undefined) {
      // An amount that is present but not a number can't be shown to be under
      // the threshold, so the deny fires (fail closed). An absent amount doesn't.
      if (findMalformedAmount(input) !== undefined) return rule;
      const amounts = findAmounts(input);
      if (amounts.some((amount) => amount > rule.constraints.maxAmount!)) return rule;
    }
  }
  return undefined;
}

function findAllowRule(policy: LatchPolicy, action: string): Rule | undefined {
  return bySpecificity(policy.allow).find((rule) => patternMatches(rule.action, action));
}

function denyReason(rule: Rule, action: string, input: unknown): string {
  const constraints = rule.constraints;
  if (constraints.paths !== undefined && denyPathsFire(constraints, input)) {
    return `the input touches a denied path (${constraints.paths.join(", ")})`;
  }
  if (constraints.maxAmount !== undefined) {
    const malformed = findMalformedAmount(input);
    if (malformed !== undefined) {
      return `amount ${describeValue(malformed)} is not a number, so the deny threshold of ${constraints.maxAmount} applies`;
    }
    const over = findAmounts(input).find((amount) => amount > constraints.maxAmount!);
    if (over !== undefined) {
      return `amount ${over} exceeds the deny threshold of ${constraints.maxAmount}`;
    }
  }
  return `"${action}" is denied by rule "${rule.action}"`;
}

function matched(rule: Rule, section: "allow" | "deny"): MatchedRule {
  return { section, pattern: rule.action, constraints: rule.constraints };
}

const DEFAULT_MATCHES: Record<"allow" | "deny", MatchedRule> = {
  allow: { section: "allow", pattern: "(default)", constraints: {} },
  deny: { section: "deny", pattern: "(default)", constraints: {} },
};

function defaultMatched(section: "allow" | "deny"): MatchedRule {
  return DEFAULT_MATCHES[section]!;
}

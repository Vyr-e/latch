import type { Rule } from "./types.js";

/**
 * Whether an action name matches a rule pattern:
 * - `stripe.customers.read` matches exactly `stripe.customers.read`
 * - `stripe.*` matches `stripe.customers`, `stripe.customers.read`, …
 *   (a trailing `*` covers one or more trailing segments)
 * - `*` matches every action
 *
 * Mid-pattern wildcards are rejected at parse time.
 */
export function patternMatches(pattern: string, action: string): boolean {
  if (pattern === "*") return true;
  if (pattern === action) return true;
  if (pattern.endsWith(".*")) {
    const prefix = pattern.slice(0, -2);
    return action.startsWith(`${prefix}.`) && action.length > prefix.length + 1;
  }
  return false;
}

/**
 * How specific a pattern is; larger is more specific. Used so that among
 * multiple matching rules, the author's most precise statement wins.
 */
export function specificity(pattern: string): number {
  if (pattern === "*") return 0;
  if (pattern.endsWith(".*")) return pattern.split(".").length;
  return pattern.split(".").length + 0.5;
}

/** Most specific first; ties keep authoring order (stable sort). */
export function bySpecificity(rules: Rule[]): Rule[] {
  return rules
    .map((rule, index) => ({ rule, index }))
    .sort((a, b) => specificity(b.rule.action) - specificity(a.rule.action) || a.index - b.index)
    .map((entry) => entry.rule);
}

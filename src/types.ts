/**
 * The normalized, authoring-independent shape of a latch policy. The YAML file
 * may nest namespaces as maps or use flat dotted keys; both normalize to a flat
 * list of rules so the engine only ever deals with one shape.
 */

/** Extra conditions attached to a rule. An empty object means "unconditional". */
export interface Constraints {
  /**
   * The input's numeric `amount` field must be less than or equal to this
   * value for an allow rule to pass (or for a deny rule to fire).
   */
  maxAmount?: number;
  /** Whether a human must approve each call before it runs. */
  approval?: "required" | "never";
  /**
   * Restrict (allow) or target (deny) calls by path-like input values.
   * Patterns may be literal directories (matched plus anything under them)
   * or globs using `*` and `**`. `~` expands to the user's home directory.
   */
  paths?: string[];
  /** Human-readable explanation surfaced in generated prompts and decisions. */
  description?: string;
}

export interface Rule {
  /**
   * Dotted action name. May end with a trailing `*` to match any number of
   * trailing segments (`stripe.*`), or be exactly `*` to match everything.
   */
  action: string;
  constraints: Constraints;
}

export interface LatchPolicy {
  /** Optional agent name this policy applies to. */
  agent?: string;
  /** Format version. Absent or `1`. */
  version: 1;
  /** What happens to actions no rule allows. Defaults to `"deny"`. */
  default: "deny" | "allow";
  allow: Rule[];
  deny: Rule[];
}

export interface MatchedRule {
  section: "allow" | "deny";
  /** The rule's action pattern as authored. */
  pattern: string;
  constraints: Constraints;
}

/** The outcome of checking one action (with its input) against a policy. */
export type LatchDecision =
  | {
      effect: "allow";
      action: string;
      matched: MatchedRule;
      /** Set when the matched rule carries a description. */
      reason?: string;
    }
  | {
      effect: "deny";
      action: string;
      /** The deny rule that fired, when a rule (not the default) denied it. */
      matched?: MatchedRule;
      reason: string;
    }
  | {
      effect: "approval";
      action: string;
      matched: MatchedRule;
      reason?: string;
    };

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
  /**
   * Extra input field names (case-insensitive) this rule's `paths` treats as
   * path-like, on top of the built-in set — for tools whose path argument is
   * named something generic like `output` or `uri`.
   */
  pathFields?: string[];
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
  /**
   * How the contextual layer treats proposed actions. Absent means
   * `"deterministic"` unless a `classifier` block is present, which implies
   * `"hybrid"`. The policy stays pure data — classifier implementations are
   * bound at runtime (createGate), never embedded here.
   */
  mode?: PolicyMode;
  /** Declarative classifier settings; the implementation is bound at runtime. */
  classifier?: ClassifierSettings;
  /** Optional decision-history settings. */
  history?: HistorySettings;
}

/**
 * How a policy treats execution of authorized actions:
 * - `deterministic` — allowed means execute; no classifier is ever invoked.
 * - `hybrid` — deterministic rules authorize; a classifier additionally judges
 *   whether each authorized call is appropriate in context.
 * - `classifier` — like hybrid, but the allow list is only a capability scope
 *   for classifier-driven execution, so it must be explicit and bounded.
 */
export type PolicyMode = "deterministic" | "hybrid" | "classifier";

/**
 * Confidence bands and per-dimension floors for turning classifier output into
 * an execution decision. Execution is an explicit conjunction, not a probability:
 * a call executes only when the classifier decides `execute`, authorization
 * allows, confidence is at or above `execute`, and every set dimension floor is
 * met. Any single failure routes to review (or, below `review`, the fallback).
 * Confidence measures certainty of judgment — never treat it as the probability
 * that the action should execute.
 */
export interface ClassifierThresholds {
  /** Confidence at or above this makes an `execute` recommendation eligible. Default 0.85. */
  execute?: number;
  /** Confidence below `execute` but at or above this calls for review. Default 0.55 (capped at `execute`). */
  review?: number;
  /** Optional floor for the relevance score. */
  relevance?: number;
  /** Optional floor for the necessity score. */
  necessity?: number;
  /** Optional floor for the urgency score. */
  urgency?: number;
}

export type FallbackStrategy = "skip" | "review" | "deny";

export type InvocationStrategy = "always" | "conditional" | "manual";

/** Which situations trigger classification when `invoke: "conditional"`. */
export interface InvocationConditions {
  /** Classify when authorization came from a wildcard or the default, not an exact rule. */
  onUnmatched?: boolean;
  /** Classify when the (untrusted) task urgency tag is present. */
  onUrgency?: boolean;
}

/** The declarative half of a classifier binding; the model itself is bound at runtime. */
export interface ClassifierSettings {
  /** Key into the runtime classifier registry (`createGate({ classifiers: { … } })`). */
  provider: string;
  thresholds?: ClassifierThresholds;
  /** What happens when classification fails, is invalid, abstains, or is low-confidence. Default `"skip"`. */
  fallback?: FallbackStrategy;
  /** When the classifier runs. Default `"always"` (for every authorized call). */
  invoke?: InvocationStrategy;
  /** Conditions for `invoke: "conditional"`. */
  conditions?: InvocationConditions;
  /** Classification timeout in milliseconds. Default 10000. */
  timeoutMs?: number;
}

export interface HistorySettings {
  enabled: boolean;
  /** Maximum retained entries in the bound store. */
  maxEntries?: number;
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

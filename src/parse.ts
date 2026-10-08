import { LineCounter, parseDocument } from "yaml";
import type {
  ClassifierSettings,
  ClassifierThresholds,
  Constraints,
  HistorySettings,
  InvocationConditions,
  LatchPolicy,
  Rule,
} from "./types.js";
import { LatchParseError } from "./errors.js";
import type { LatchIssue } from "./errors.js";

const CONSTRAINT_KEYS = ["max_amount", "approval", "paths", "path_fields", "description"] as const;
const ROOT_KEYS = [
  "agent",
  "version",
  "default",
  "allow",
  "deny",
  "mode",
  "classifier",
  "history",
] as const;
const CLASSIFIER_KEYS = [
  "enabled",
  "provider",
  "thresholds",
  "invoke",
  "conditions",
  "fallback",
  "timeout_ms",
] as const;
const CONDITION_KEYS = ["on_unmatched", "on_urgency"] as const;
const THRESHOLD_KEYS = ["execute", "review", "relevance", "necessity", "urgency"] as const;

type Section = "allow" | "deny";

interface Pos {
  line: number;
  col: number;
}

/**
 * Parse and validate a `latch.yaml` source string into a normalized policy.
 *
 * Rules may be written flat (`stripe.refunds.create: true`) or nested as maps
 * (`stripe: { refunds: { create: true } }`); both normalize to the same flat
 * rule list. All validation problems are collected and reported together, each
 * with its line and column in the source, so an agent can fix a file in one
 * round trip.
 */
export function parsePolicy(source: string, options: { file?: string } = {}): LatchPolicy {
  const file = options.file ?? "latch.yaml";
  const lineCounter = new LineCounter();
  const doc = parseDocument(source, { lineCounter, uniqueKeys: false });

  if (doc.errors.length > 0) {
    throw new LatchParseError(
      doc.errors.map((error) => ({
        message: error.message.split("\n")[0] ?? error.message,
        file,
        ...errorPos(error, lineCounter),
      })),
    );
  }

  const issues: LatchIssue[] = [];
  const posByPath = new Map<string, Pos>();
  if (doc.contents) walk(doc.contents, "", lineCounter, posByPath);

  const raw = doc.toJS() as unknown;
  const policy = validateRoot(raw, issues, posByPath, file);

  if (issues.length > 0) throw new LatchParseError(issues.map((issue) => ({ ...issue, file })));
  return policy;
}

function errorPos(
  error: { pos?: [number, number] | undefined },
  lineCounter: LineCounter,
): Pos | undefined {
  const start = error.pos?.[0];
  return start === undefined ? undefined : toPos(start, lineCounter);
}

function toPos(offset: number, lineCounter: LineCounter): Pos {
  const { line, col } = lineCounter.linePos(offset);
  return { line, col };
}

/** The slice of the yaml AST shape latch walks; read defensively on purpose.
 * Block collections carry no `type` tag, so mapping entries are detected by
 * having a `key` — the only reliable signal across block and flow styles. */
interface YamlAstNode {
  range?: [number, number, number];
  items?: unknown[];
  key?: unknown;
  value?: unknown;
}

/** Record the source position of every mapping key, keyed by its dotted path. */
function walk(node: unknown, path: string, lineCounter: LineCounter, out: Map<string, Pos>): void {
  const n = node as YamlAstNode;
  if (path !== "" && Array.isArray(n.range)) {
    out.set(path, toPos(n.range[0]!, lineCounter));
  }
  if (!Array.isArray(n.items)) return;

  n.items.forEach((item, index) => {
    const entry = item as YamlAstNode | null;
    if (entry === null || entry === undefined) return;
    if (entry.key !== undefined || entry.value !== undefined) {
      const keyValue = (entry.key as YamlAstNode | undefined)?.value;
      if (keyValue === null || keyValue === undefined) return;
      const segment = String(keyValue);
      walk(
        entry.value ?? entry.key,
        path === "" ? segment : `${path}.${segment}`,
        lineCounter,
        out,
      );
      return;
    }
    walk(item, path === "" ? String(index) : `${path}[${index}]`, lineCounter, out);
  });
}

function validateRoot(
  raw: unknown,
  issues: LatchIssue[],
  posByPath: Map<string, Pos>,
  file: string,
): LatchPolicy {
  if (!isPlainObject(raw)) {
    pushIssue(issues, posByPath, "", file, "the policy root must be a YAML mapping");
    return { version: 1, default: "deny", allow: [], deny: [] };
  }
  const root = raw;

  for (const key of Object.keys(root)) {
    if (!ROOT_KEYS.includes(key as (typeof ROOT_KEYS)[number])) {
      const hint = suggest(key, ROOT_KEYS);
      pushIssue(
        issues,
        posByPath,
        key,
        file,
        `unknown root key "${key}" (expected one of: ${ROOT_KEYS.join(", ")})${hint ? ` — did you mean "${hint}"?` : ""}`,
      );
    }
  }

  let agent: string | undefined;
  if (root["agent"] !== undefined) {
    const value = root["agent"];
    if (typeof value !== "string" || value.trim() === "") {
      pushIssue(issues, posByPath, "agent", file, '"agent" must be a non-empty string');
    } else {
      agent = value;
    }
  }

  if (root["version"] !== undefined && root["version"] !== 1) {
    pushIssue(
      issues,
      posByPath,
      "version",
      file,
      `"version" must be 1 (got ${formatValue(root["version"])})`,
    );
  }

  let def: "deny" | "allow" = "deny";
  if (root["default"] !== undefined) {
    if (root["default"] === "deny" || root["default"] === "allow") {
      def = root["default"];
    } else {
      pushIssue(
        issues,
        posByPath,
        "default",
        file,
        `"default" must be "deny" or "allow" (got ${formatValue(root["default"])})`,
      );
    }
  }

  const allow = validateSection(root["allow"], "allow", issues, posByPath, file);
  const deny = validateSection(root["deny"], "deny", issues, posByPath, file);

  const mode = validateMode(root["mode"], issues, posByPath, file);
  const classifier = validateClassifierBlock(root["classifier"], issues, posByPath, file);
  const history = validateHistoryBlock(root["history"], issues, posByPath, file);

  // Cross-checks: the contextual layer must not contradict itself or loosen scope.
  if (mode === "deterministic" && classifier !== undefined) {
    pushIssue(
      issues,
      posByPath,
      "classifier",
      file,
      "the policy sets mode: deterministic but configures a classifier — set mode: hybrid (or classifier), or remove the classifier block",
    );
  }
  if (mode === "classifier" && (allow.length === 0 || def === "allow")) {
    pushIssue(
      issues,
      posByPath,
      "mode",
      file,
      "mode: classifier requires an explicit, bounded capability scope — list the permitted actions under allow and keep default: deny (a classifier decides execution, never capability)",
    );
  }

  const policy: LatchPolicy = { agent, version: 1, default: def, allow, deny };
  // A classifier block without an explicit mode means hybrid; everything else
  // stays absent so policies without the contextual layer keep their exact shape.
  const effectiveMode = mode ?? (classifier !== undefined ? "hybrid" : undefined);
  if (effectiveMode !== undefined) policy.mode = effectiveMode;
  if (classifier !== undefined) policy.classifier = classifier;
  if (history !== undefined) policy.history = history;
  return policy;
}

function validateMode(
  value: unknown,
  issues: LatchIssue[],
  posByPath: Map<string, Pos>,
  file: string,
): LatchPolicy["mode"] {
  if (value === undefined) return undefined;
  if (value === "deterministic" || value === "hybrid" || value === "classifier") return value;
  pushIssue(
    issues,
    posByPath,
    "mode",
    file,
    `"mode" must be "deterministic", "hybrid", or "classifier" (got ${formatValue(value)})`,
  );
  return undefined;
}

function validateClassifierBlock(
  value: unknown,
  issues: LatchIssue[],
  posByPath: Map<string, Pos>,
  file: string,
): ClassifierSettings | undefined {
  if (value === undefined) return undefined;
  if (!isPlainObject(value)) {
    pushIssue(
      issues,
      posByPath,
      "classifier",
      file,
      `"classifier" must be a mapping of settings (got ${formatValue(value)})`,
    );
    return undefined;
  }
  if (value["enabled"] === false) return undefined;
  if (value["enabled"] !== undefined && typeof value["enabled"] !== "boolean") {
    pushIssue(
      issues,
      posByPath,
      "classifier.enabled",
      file,
      `"classifier.enabled" must be true or false (got ${formatValue(value["enabled"])})`,
    );
  }

  for (const key of Object.keys(value)) {
    if (!(CLASSIFIER_KEYS as readonly string[]).includes(key)) {
      const hint = suggest(key, CLASSIFIER_KEYS);
      pushIssue(
        issues,
        posByPath,
        `classifier.${key}`,
        file,
        `"${key}" is not a classifier setting (settings are: ${CLASSIFIER_KEYS.join(", ")})${hint ? ` — did you mean "${hint}"?` : ""}`,
      );
    }
  }

  let provider: string | undefined;
  if (typeof value["provider"] === "string" && value["provider"].trim() !== "") {
    provider = value["provider"];
  } else {
    pushIssue(
      issues,
      posByPath,
      "classifier.provider",
      file,
      `"classifier.provider" must be a non-empty string naming a classifier registered at runtime, e.g. provider: judge`,
    );
  }

  const thresholds = validateThresholds(value["thresholds"], issues, posByPath, file);

  let invoke: ClassifierSettings["invoke"];
  if (value["invoke"] !== undefined) {
    if (
      value["invoke"] === "always" ||
      value["invoke"] === "conditional" ||
      value["invoke"] === "manual"
    ) {
      invoke = value["invoke"];
    } else {
      pushIssue(
        issues,
        posByPath,
        "classifier.invoke",
        file,
        `"classifier.invoke" must be "always", "conditional", or "manual" (got ${formatValue(value["invoke"])})`,
      );
    }
  }

  const conditions = validateConditions(value["conditions"], issues, posByPath, file);
  if (conditions !== undefined && invoke !== undefined && invoke !== "conditional") {
    pushIssue(
      issues,
      posByPath,
      "classifier.conditions",
      file,
      `"classifier.conditions" only applies when invoke: conditional — set invoke: conditional, or remove conditions (got invoke: ${invoke})`,
    );
  }

  let fallback: ClassifierSettings["fallback"];
  if (value["fallback"] !== undefined) {
    if (
      value["fallback"] === "skip" ||
      value["fallback"] === "review" ||
      value["fallback"] === "deny"
    ) {
      fallback = value["fallback"];
    } else {
      pushIssue(
        issues,
        posByPath,
        "classifier.fallback",
        file,
        `"classifier.fallback" must be "skip", "review", or "deny" (got ${formatValue(value["fallback"])})`,
      );
    }
  }

  let timeoutMs: number | undefined;
  if (value["timeout_ms"] !== undefined) {
    if (
      typeof value["timeout_ms"] === "number" &&
      Number.isFinite(value["timeout_ms"]) &&
      value["timeout_ms"] > 0
    ) {
      timeoutMs = value["timeout_ms"];
    } else {
      pushIssue(
        issues,
        posByPath,
        "classifier.timeout_ms",
        file,
        `"classifier.timeout_ms" must be a positive number of milliseconds (got ${formatValue(value["timeout_ms"])})`,
      );
    }
  }

  if (provider === undefined) return undefined;
  const settings: ClassifierSettings = { provider };
  if (thresholds !== undefined) settings.thresholds = thresholds;
  if (invoke !== undefined) settings.invoke = invoke;
  if (conditions !== undefined) settings.conditions = conditions;
  if (fallback !== undefined) settings.fallback = fallback;
  if (timeoutMs !== undefined) settings.timeoutMs = timeoutMs;
  return settings;
}

function validateThresholds(
  value: unknown,
  issues: LatchIssue[],
  posByPath: Map<string, Pos>,
  file: string,
): ClassifierThresholds | undefined {
  if (value === undefined) return undefined;
  if (!isPlainObject(value)) {
    pushIssue(
      issues,
      posByPath,
      "classifier.thresholds",
      file,
      `"classifier.thresholds" must be a mapping (got ${formatValue(value)})`,
    );
    return undefined;
  }
  for (const key of Object.keys(value)) {
    if (!(THRESHOLD_KEYS as readonly string[]).includes(key)) {
      const hint = suggest(key, THRESHOLD_KEYS);
      pushIssue(
        issues,
        posByPath,
        `classifier.thresholds.${key}`,
        file,
        `"${key}" is not a threshold (thresholds are: ${THRESHOLD_KEYS.join(", ")})${hint ? ` — did you mean "${hint}"?` : ""}`,
      );
    }
  }

  const thresholds: ClassifierThresholds = {};
  for (const key of THRESHOLD_KEYS) {
    const threshold = value[key];
    if (threshold === undefined) continue;
    if (
      typeof threshold !== "number" ||
      !Number.isFinite(threshold) ||
      threshold < 0 ||
      threshold > 1
    ) {
      pushIssue(
        issues,
        posByPath,
        `classifier.thresholds.${key}`,
        file,
        `threshold "${key}" must be a number between 0 and 1 (got ${formatValue(threshold)})`,
      );
    } else {
      thresholds[key] = threshold;
    }
  }
  if (
    thresholds.execute !== undefined &&
    thresholds.review !== undefined &&
    thresholds.review > thresholds.execute
  ) {
    pushIssue(
      issues,
      posByPath,
      "classifier.thresholds.review",
      file,
      `the review threshold (${thresholds.review}) must not exceed the execute threshold (${thresholds.execute}) — confidence between them routes to review`,
    );
  }
  return Object.keys(thresholds).length > 0 ? thresholds : undefined;
}

function validateConditions(
  value: unknown,
  issues: LatchIssue[],
  posByPath: Map<string, Pos>,
  file: string,
): InvocationConditions | undefined {
  if (value === undefined) return undefined;
  if (!isPlainObject(value)) {
    pushIssue(
      issues,
      posByPath,
      "classifier.conditions",
      file,
      `"classifier.conditions" must be a mapping (got ${formatValue(value)})`,
    );
    return undefined;
  }
  for (const key of Object.keys(value)) {
    if (!(CONDITION_KEYS as readonly string[]).includes(key)) {
      const hint = suggest(key, CONDITION_KEYS);
      pushIssue(
        issues,
        posByPath,
        `classifier.conditions.${key}`,
        file,
        `"${key}" is not an invocation condition (conditions are: ${CONDITION_KEYS.join(", ")})${hint ? ` — did you mean "${hint}"?` : ""}`,
      );
    }
  }

  const conditions: InvocationConditions = {};
  for (const key of CONDITION_KEYS) {
    const flag = value[key];
    if (flag === undefined) continue;
    if (typeof flag !== "boolean") {
      pushIssue(
        issues,
        posByPath,
        `classifier.conditions.${key}`,
        file,
        `condition "${key}" must be true or false (got ${formatValue(flag)})`,
      );
    } else if (flag) {
      // YAML spells conditions in snake_case; the normalized policy is camelCase.
      conditions[key === "on_unmatched" ? "onUnmatched" : "onUrgency"] = true;
    }
  }
  return Object.keys(conditions).length > 0 ? conditions : undefined;
}

function validateHistoryBlock(
  value: unknown,
  issues: LatchIssue[],
  posByPath: Map<string, Pos>,
  file: string,
): HistorySettings | undefined {
  if (value === undefined) return undefined;
  if (!isPlainObject(value)) {
    pushIssue(
      issues,
      posByPath,
      "history",
      file,
      `"history" must be a mapping (got ${formatValue(value)})`,
    );
    return undefined;
  }
  for (const key of Object.keys(value)) {
    if (key !== "enabled" && key !== "max_entries") {
      const hint = suggest(key, ["enabled", "max_entries"]);
      pushIssue(
        issues,
        posByPath,
        `history.${key}`,
        file,
        `"${key}" is not a history setting (settings are: enabled, max_entries)${hint ? ` — did you mean "${hint}"?` : ""}`,
      );
    }
  }

  const enabled = value["enabled"];
  if (typeof enabled !== "boolean") {
    pushIssue(
      issues,
      posByPath,
      "history.enabled",
      file,
      `"history.enabled" must be true or false (got ${formatValue(enabled)}) — write history: { enabled: true } to record classification decisions`,
    );
    return undefined;
  }
  if (!enabled) return undefined;

  const settings: HistorySettings = { enabled: true };
  const maxEntries = value["max_entries"];
  if (maxEntries !== undefined) {
    if (typeof maxEntries === "number" && Number.isInteger(maxEntries) && maxEntries > 0) {
      settings.maxEntries = maxEntries;
    } else {
      pushIssue(
        issues,
        posByPath,
        "history.max_entries",
        file,
        `"history.max_entries" must be a positive integer (got ${formatValue(maxEntries)})`,
      );
    }
  }
  return settings;
}

function validateSection(
  section: unknown,
  name: Section,
  issues: LatchIssue[],
  posByPath: Map<string, Pos>,
  file: string,
): Rule[] {
  if (section === undefined) return [];
  if (section === null) {
    pushIssue(
      issues,
      posByPath,
      name,
      file,
      `"${name}" must be a mapping of actions (got null) — write "${name}:" with indented entries under it, or remove the key`,
    );
    return [];
  }
  if (!isPlainObject(section)) {
    pushIssue(
      issues,
      posByPath,
      name,
      file,
      `"${name}" must be a mapping of actions (got ${formatValue(section)})`,
    );
    return [];
  }
  const rules: Rule[] = [];
  flatten(section, null, name, rules, issues, posByPath, file);
  return rules;
}

function flatten(
  map: Record<string, unknown>,
  prefix: string | null,
  section: Section,
  rules: Rule[],
  issues: LatchIssue[],
  posByPath: Map<string, Pos>,
  file: string,
): void {
  for (const [key, value] of Object.entries(map)) {
    const action = prefix === null ? key : `${prefix}.${key}`;
    const path = prefix === null ? `${section}.${key}` : `${prefix}.${key}`;

    if (isPlainObject(value)) {
      flattenMapValue(value, action, path, section, rules, issues, posByPath, file);
      continue;
    }

    if (value === true) {
      addRule(rules, action, {}, issues, posByPath, file);
      continue;
    }

    pushIssue(issues, posByPath, path, file, describeScalarEntry(action, section, value));
  }
}

/**
 * A mapping value is either a constraints object for the action it sits under,
 * or a nested map of sub-actions. A mix of both is ambiguous, so it is an
 * error; a map of near-miss constraint keys (e.g. `max_amout`) is reported as
 * a typo rather than silently becoming sub-actions.
 */
function flattenMapValue(
  value: Record<string, unknown>,
  action: string,
  path: string,
  section: Section,
  rules: Rule[],
  issues: LatchIssue[],
  posByPath: Map<string, Pos>,
  file: string,
): void {
  const keys = Object.keys(value);
  const exactConstraints = keys.filter((k) => (CONSTRAINT_KEYS as readonly string[]).includes(k));
  const nearMisses =
    exactConstraints.length === 0
      ? keys.filter((k) => suggest(k, CONSTRAINT_KEYS) !== undefined)
      : [];

  if (exactConstraints.length > 0 || nearMisses.length > 0) {
    const foreign = keys.filter((k) => !exactConstraints.includes(k));
    for (const key of foreign) {
      if (exactConstraints.includes(key)) continue;
      const hint = suggest(key, CONSTRAINT_KEYS);
      pushIssue(
        issues,
        posByPath,
        `${path}.${key}`,
        file,
        `"${key}" is not a constraint (constraints are: ${CONSTRAINT_KEYS.join(", ")})${hint ? ` — did you mean "${hint}"?` : ""}`,
      );
    }
    if (foreign.some((k) => !nearMisses.includes(k))) {
      pushIssue(
        issues,
        posByPath,
        path,
        file,
        `"${action}" mixes constraints (${CONSTRAINT_KEYS.join(", ")}) with sub-actions — move the constraints to a leaf action so the intent is unambiguous`,
      );
    }
    const constraints = validateConstraints(value, path, issues, posByPath, file);
    addRule(rules, action, constraints, issues, posByPath, file);
    return;
  }

  if (keys.length === 0) {
    pushIssue(
      issues,
      posByPath,
      path,
      file,
      `"${action}" has no entries — write ${action}: true, add constraints like max_amount or approval, or remove it`,
    );
    return;
  }

  for (const [key, nested] of Object.entries(value)) {
    const nestedAction = `${action}.${key}`;
    if (isPlainObject(nested)) {
      flattenMapValue(
        nested,
        nestedAction,
        `${path}.${key}`,
        section,
        rules,
        issues,
        posByPath,
        file,
      );
      continue;
    }
    if (nested === true) {
      addRule(rules, nestedAction, {}, issues, posByPath, file);
      continue;
    }
    pushIssue(
      issues,
      posByPath,
      `${path}.${key}`,
      file,
      describeScalarEntry(nestedAction, section, nested),
    );
  }
}

function describeScalarEntry(action: string, section: Section, value: unknown): string {
  if (value === false) {
    return section === "allow"
      ? `"${action}: false" is not a valid allow entry — remove it (unlisted actions are already not allowed), or move it under deny to state the prohibition explicitly`
      : `"${action}: false" is not a valid deny entry — remove it (a deny that is false does nothing)`;
  }
  if (value === null) {
    return `"${action}" has no value — write "${action}: true" or add constraints like max_amount or approval`;
  }
  return `"${action}" must be true or a constraints map (got ${formatValue(value)})`;
}

function addRule(
  rules: Rule[],
  action: string,
  constraints: Constraints,
  issues: LatchIssue[],
  posByPath: Map<string, Pos>,
  file: string,
): void {
  const patternError = validatePattern(action);
  if (patternError) {
    pushIssue(
      issues,
      posByPath,
      action,
      file,
      `"${action}" is not a valid action pattern: ${patternError}`,
    );
    return;
  }

  // A bare `filesystem.paths` (or `fs.paths`) entry is a statement about the
  // paths themselves, so it applies to every action, not just actions named
  // `filesystem`. Extra constraint keys (a description, say) do not change
  // that — only the presence of `paths` decides. Scope it to filesystem tools
  // explicitly with `filesystem.*`.
  if ((action === "filesystem" || action === "fs") && constraints.paths !== undefined) {
    rules.push({ action: "*", constraints });
    return;
  }

  rules.push({ action, constraints });
}

function validatePattern(pattern: string): string | undefined {
  if (pattern === "") return "it is empty";
  const segments = pattern.split(".");
  if (segments.some((segment) => segment === "")) {
    return "it has an empty segment (check for consecutive or leading/trailing dots)";
  }
  const wildcardIndex = segments.indexOf("*");
  if (wildcardIndex !== -1 && wildcardIndex !== segments.length - 1) {
    return '"*" is only supported as the last segment (e.g. "stripe.*")';
  }
  return undefined;
}

function validateConstraints(
  value: Record<string, unknown>,
  path: string,
  issues: LatchIssue[],
  posByPath: Map<string, Pos>,
  file: string,
): Constraints {
  const constraints: Constraints = {};

  const maxAmount = value["max_amount"];
  if (maxAmount !== undefined) {
    if (typeof maxAmount !== "number" || !Number.isFinite(maxAmount) || maxAmount < 0) {
      pushIssue(
        issues,
        posByPath,
        `${path}.max_amount`,
        file,
        `"max_amount" must be a non-negative number (got ${formatValue(maxAmount)})`,
      );
    } else {
      constraints.maxAmount = maxAmount;
    }
  }

  const approval = value["approval"];
  if (approval !== undefined) {
    if (approval === "required" || approval === "never") {
      constraints.approval = approval;
    } else {
      pushIssue(
        issues,
        posByPath,
        `${path}.approval`,
        file,
        `"approval" must be "required" or "never" (got ${formatValue(approval)})`,
      );
    }
  }

  const paths = value["paths"];
  if (paths !== undefined) {
    if (
      !Array.isArray(paths) ||
      paths.length === 0 ||
      !paths.every((p) => typeof p === "string" && p.trim() !== "")
    ) {
      pushIssue(
        issues,
        posByPath,
        `${path}.paths`,
        file,
        '"paths" must be a non-empty list of non-empty strings',
      );
    } else {
      constraints.paths = paths;
    }
  }

  const pathFields = value["path_fields"];
  if (pathFields !== undefined) {
    if (
      !Array.isArray(pathFields) ||
      pathFields.length === 0 ||
      !pathFields.every((f) => typeof f === "string" && f.trim() !== "")
    ) {
      pushIssue(
        issues,
        posByPath,
        `${path}.path_fields`,
        file,
        '"path_fields" must be a non-empty list of input field names (e.g. [output, uri])',
      );
    } else if (paths === undefined) {
      pushIssue(
        issues,
        posByPath,
        `${path}.path_fields`,
        file,
        '"path_fields" only applies alongside "paths" — add the paths these fields are checked against, or remove it',
      );
    } else {
      constraints.pathFields = pathFields;
    }
  }

  const description = value["description"];
  if (description !== undefined) {
    if (typeof description !== "string" || description.trim() === "") {
      pushIssue(
        issues,
        posByPath,
        `${path}.description`,
        file,
        '"description" must be a non-empty string',
      );
    } else {
      constraints.description = description;
    }
  }

  return constraints;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function pushIssue(
  issues: LatchIssue[],
  posByPath: Map<string, Pos>,
  path: string,
  file: string,
  message: string,
): void {
  const pos = posByPath.get(path);
  issues.push({
    message,
    file,
    line: pos?.line,
    col: pos?.col,
    path: path === "" ? undefined : path,
  });
}

function formatValue(value: unknown): string {
  if (value === null) return "null";
  if (typeof value === "string") return JSON.stringify(value);
  if (typeof value === "boolean" || typeof value === "number") return String(value);
  if (Array.isArray(value)) return "a list";
  return "a mapping";
}

/** Closest candidate within an edit-distance threshold, or undefined. */
export function suggest(candidate: string, candidates: readonly string[]): string | undefined {
  let best: string | undefined;
  let bestDistance = Number.POSITIVE_INFINITY;
  for (const option of candidates) {
    const distance = levenshtein(candidate.toLowerCase(), option.toLowerCase());
    if (distance < bestDistance) {
      bestDistance = distance;
      best = option;
    }
  }
  return best !== undefined && bestDistance <= Math.max(2, Math.floor(best.length / 3))
    ? best
    : undefined;
}

function levenshtein(a: string, b: string): number {
  const prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  const curr: number[] = [];
  for (let i = 1; i <= a.length; i++) {
    curr[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const substitution = prev[j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1);
      curr[j] = Math.min(prev[j]! + 1, curr[j - 1]! + 1, substitution);
    }
    for (let j = 0; j <= b.length; j++) prev[j] = curr[j]!;
  }
  return prev[b.length]!;
}

import { LineCounter, parseDocument } from "yaml";
import type { Constraints, LatchPolicy, Rule } from "./types.js";
import { LatchParseError } from "./errors.js";
import type { LatchIssue } from "./errors.js";

const CONSTRAINT_KEYS = ["max_amount", "approval", "paths", "description"] as const;
const ROOT_KEYS = ["agent", "version", "default", "allow", "deny"] as const;

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

  return { agent, version: 1, default: def, allow, deny };
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

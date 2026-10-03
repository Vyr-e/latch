import { homedir } from "node:os";
import type { Constraints } from "./types.js";

/**
 * Input field names latch treats as filesystem paths when a rule carries a
 * `paths` constraint. Matched case-insensitively, up to three levels deep.
 */
const PATH_KEYS = new Set([
  "path",
  "paths",
  "file",
  "filepath",
  "file_path",
  "filename",
  "file_name",
  "directory",
  "dir",
  "folder",
  "target",
  "source",
  "src",
  "dest",
  "dst",
  "destination",
  "target_path",
  "source_path",
]);

const MAX_SEARCH_DEPTH = 3;

/**
 * All path-like string values in an input object, collected breadth-cheaply.
 * A path-like key may hold a single string or a list of strings (`paths: [...]`)
 * — both are collected. Shell command strings are deliberately not parsed — a
 * `paths` constraint guards structured path arguments, not arbitrary command
 * text.
 */
export function findPathValues(input: unknown): string[] {
  const values: string[] = [];
  collectPaths(input, 0, values);
  return values;
}

function collectPaths(value: unknown, depth: number, out: string[]): void {
  if (depth > MAX_SEARCH_DEPTH || value === null || typeof value !== "object") return;
  for (const [key, child] of Object.entries(value)) {
    if (PATH_KEYS.has(key.toLowerCase())) {
      collectFromPathKey(child, depth, out);
    } else {
      collectPaths(child, depth + 1, out);
    }
  }
}

/**
 * Strings under a path-like key: one string, a list of strings, or an object
 * whose own fields may include path-like keys. Only reached from a path key,
 * so bare strings elsewhere in the input (command arguments, names) are never
 * mistaken for paths.
 */
function collectFromPathKey(value: unknown, depth: number, out: string[]): void {
  if (typeof value === "string") {
    out.push(value);
    return;
  }
  if (Array.isArray(value)) {
    for (const element of value) collectFromPathKey(element, depth + 1, out);
    return;
  }
  if (value !== null && typeof value === "object") collectPaths(value, depth + 1, out);
}

/**
 * Every numeric `amount` field in the input, searched like path values. All of
 * them are returned — a batch input's second item can carry the number the
 * first item was checked against, so limits are enforced against every amount,
 * not the first one found.
 */
export function findAmounts(input: unknown): number[] {
  const values: number[] = [];
  collectAmounts(input, 0, values);
  return values;
}

function collectAmounts(value: unknown, depth: number, out: number[]): void {
  if (depth > MAX_SEARCH_DEPTH || value === null || typeof value !== "object") return;
  for (const [key, child] of Object.entries(value)) {
    if (key.toLowerCase() === "amount") {
      collectFromAmountKey(child, depth, out);
    } else {
      collectAmounts(child, depth + 1, out);
    }
  }
}

function collectFromAmountKey(value: unknown, depth: number, out: number[]): void {
  if (typeof value === "number" && Number.isFinite(value)) {
    out.push(value);
    return;
  }
  if (Array.isArray(value)) {
    for (const element of value) collectFromAmountKey(element, depth + 1, out);
    return;
  }
  if (value !== null && typeof value === "object") collectAmounts(value, depth + 1, out);
}

/**
 * The first numeric `amount` field in the input. Kept for callers that only
 * want to know whether an amount exists; limit checks use findAmounts so every
 * amount in a batch is enforced.
 */
export function findAmount(input: unknown): number | undefined {
  return findAmounts(input)[0];
}

export interface ConstraintResult {
  ok: boolean;
  /** Why the constraint failed, when ok is false. */
  reason?: string;
}

/**
 * Check an allow rule's constraints against the action input. Path coverage
 * and amount limits fail closed: missing values are violations, not passes.
 */
export function checkConstraints(constraints: Constraints, input: unknown): ConstraintResult {
  if (constraints.maxAmount !== undefined) {
    const amounts = findAmounts(input);
    if (amounts.length === 0) {
      return {
        ok: false,
        reason: `the rule sets max_amount ${constraints.maxAmount}, but the input has no numeric "amount" field`,
      };
    }
    const over = amounts.find((amount) => amount > constraints.maxAmount!);
    if (over !== undefined) {
      return {
        ok: false,
        reason: `amount ${over} exceeds max_amount ${constraints.maxAmount}`,
      };
    }
  }

  if (constraints.paths !== undefined && constraints.paths.length > 0) {
    const values = findPathValues(input);
    if (values.length === 0) {
      return {
        ok: false,
        reason: `the rule restricts the action to paths (${constraints.paths.join(", ")}), but the input has no path-like fields`,
      };
    }
    const outside = values.filter(
      (value) => !constraints.paths!.some((pattern) => pathMatches(pattern, value)),
    );
    if (outside.length > 0) {
      return {
        ok: false,
        reason: `path ${outside[0]} is outside the allowed paths (${constraints.paths.join(", ")})`,
      };
    }
  }

  return { ok: true };
}

/**
 * Whether a deny rule's paths constraint fires for the input: any path-like
 * value falling under a listed pattern triggers the deny.
 */
export function denyPathsFire(constraints: Constraints, input: unknown): boolean {
  if (constraints.paths === undefined || constraints.paths.length === 0) return false;
  const values = findPathValues(input);
  return values.some((value) => constraints.paths!.some((pattern) => pathMatches(pattern, value)));
}

/**
 * Whether a path matches a `paths` pattern:
 * - `~` expands to the user's home directory
 * - a literal pattern matches itself and anything inside it (`~/.ssh` covers
 *   `~/.ssh/id_rsa` and `~/.ssh/agents/eve`)
 * - `*` matches within one path segment, `**` across segments
 */
export function pathMatches(pattern: string, path: string): boolean {
  const expandedPattern = expandTilde(normalizePath(pattern));
  const expandedPath = expandTilde(normalizePath(path));
  if (expandedPattern === expandedPath) return true;

  if (!expandedPattern.includes("*")) {
    return expandedPath.startsWith(`${expandedPattern}/`);
  }

  return globToRegExp(expandedPattern).test(expandedPath);
}

function normalizePath(path: string): string {
  let normalized = path.replace(/\/{2,}/g, "/").replace(/\/+$/, "");
  while (normalized.startsWith("./")) normalized = normalized.slice(2);
  return normalized;
}

function expandTilde(path: string): string {
  if (path === "~") return homedir();
  if (path === "~/") return `${homedir()}/`;
  if (path.startsWith("~/")) return `${homedir()}/${path.slice(2)}`;
  return path;
}

const globCache = new Map<string, RegExp>();

function globToRegExp(glob: string): RegExp {
  let regExp = globCache.get(glob);
  if (regExp === undefined) {
    const segments = glob.split("/");
    let source = "";
    for (let i = 0; i < segments.length; i++) {
      const segment = segments[i]!;
      const last = i === segments.length - 1;
      if (segment === "**") {
        // `a/**` covers everything strictly inside `a`; a mid-pattern `**`
        // covers zero or more whole segments, so `a/**/b` also matches `a/b`.
        source += last ? ".+" : "(?:.+/)?";
      } else {
        source += segment.replaceAll(/[.+?^${}()|[\]\\]/g, "\\$&").replaceAll("*", "[^/]*");
        if (!last) source += "/";
      }
    }
    regExp = new RegExp(`^${source}$`);
    globCache.set(glob, regExp);
  }
  return regExp;
}

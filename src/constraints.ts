import { homedir } from "node:os";
import { posix } from "node:path";
import type { Constraints } from "./types.js";

/**
 * Input field names latch treats as filesystem paths when a rule carries a
 * `paths` constraint. Matched case-insensitively, at any depth.
 */
const PATH_KEYS = new Set([
  "path",
  "paths",
  "file",
  "files",
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
  "cwd",
  "workdir",
  "working_dir",
  "working_directory",
  "input_path",
  "input_file",
  "output_path",
  "output_file",
  "output_dir",
]);

/**
 * All path-like string values in an input object, at any depth — a depth cap
 * would let a deny rule miss a path nested one level further down. A path-like
 * key may hold a single string or a list of strings (`paths: [...]`) — both
 * are collected. Shell command strings are deliberately not parsed — a `paths`
 * constraint guards structured path arguments, not arbitrary command text.
 *
 * `extraFields` adds field names (a rule's `path_fields`) to the built-in set.
 */
export function findPathValues(input: unknown, extraFields: readonly string[] = []): string[] {
  const values: string[] = [];
  const extra = new Set(extraFields.map((field) => field.toLowerCase()));
  const walk: PathWalk = {
    seen: new WeakSet(),
    isPathKey: (key) => PATH_KEYS.has(key) || extra.has(key),
    out: values,
  };
  collectPaths(input, walk);
  return values;
}

interface PathWalk {
  seen: WeakSet<object>;
  /** Takes a lowercased key. */
  isPathKey: (key: string) => boolean;
  out: string[];
}

function collectPaths(value: unknown, walk: PathWalk): void {
  if (value === null || typeof value !== "object" || walk.seen.has(value)) return;
  walk.seen.add(value);
  for (const [key, child] of Object.entries(value)) {
    if (walk.isPathKey(key.toLowerCase())) {
      collectFromPathKey(child, walk);
    } else {
      collectPaths(child, walk);
    }
  }
}

/**
 * Strings under a path-like key: one string, a list of strings, or an object
 * whose own fields may include path-like keys. Only reached from a path key,
 * so bare strings elsewhere in the input (command arguments, names) are never
 * mistaken for paths.
 */
function collectFromPathKey(value: unknown, walk: PathWalk): void {
  if (typeof value === "string") {
    walk.out.push(value);
    return;
  }
  if (Array.isArray(value)) {
    if (walk.seen.has(value)) return;
    walk.seen.add(value);
    for (const element of value) collectFromPathKey(element, walk);
    return;
  }
  collectPaths(value, walk);
}

/**
 * Every numeric `amount` field in the input, searched like path values. All of
 * them are returned — a batch input's second item can carry the number the
 * first item was checked against, so limits are enforced against every amount,
 * not the first one found.
 */
export function findAmounts(input: unknown): number[] {
  return amountValues(input).filter(isAmount);
}

/**
 * The first value under an `amount` key that is not a finite number (`"9999"`,
 * `true`, `{ value: 10 }`), or undefined when every amount is numeric. Such a
 * value cannot be compared against a limit, so both allow and deny rules with
 * `max_amount` treat it as a violation rather than skipping it. `null` counts
 * as absent, not malformed.
 */
export function findMalformedAmount(input: unknown): unknown {
  return amountValues(input).find((value) => !isAmount(value));
}

function isAmount(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

/** Every leaf value under an `amount` key, at any depth. */
function amountValues(input: unknown): unknown[] {
  const values: unknown[] = [];
  collectAmounts(input, new WeakSet(), values);
  return values;
}

function collectAmounts(value: unknown, seen: WeakSet<object>, out: unknown[]): void {
  if (value === null || typeof value !== "object" || seen.has(value)) return;
  seen.add(value);
  for (const [key, child] of Object.entries(value)) {
    if (key.toLowerCase() === "amount") {
      collectFromAmountKey(child, seen, out);
    } else {
      collectAmounts(child, seen, out);
    }
  }
}

function collectFromAmountKey(value: unknown, seen: WeakSet<object>, out: unknown[]): void {
  if (value === null || value === undefined) return;
  if (Array.isArray(value)) {
    if (seen.has(value)) return;
    seen.add(value);
    for (const element of value) collectFromAmountKey(element, seen, out);
    return;
  }
  if (typeof value === "object") {
    // `amount: { value: 10, currency: "usd" }` holds no nested amount, so the
    // object itself is the (malformed) amount; `amount: { items: [...] }`
    // nesting further amounts contributes those instead.
    const before = out.length;
    collectAmounts(value, seen, out);
    if (out.length === before) out.push(value);
    return;
  }
  out.push(value);
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
    const malformed = findMalformedAmount(input);
    if (malformed !== undefined) {
      return {
        ok: false,
        reason: `the input's amount ${describeValue(malformed)} is not a number, so max_amount ${constraints.maxAmount} cannot be checked — pass amounts as numbers`,
      };
    }
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
    const values = findPathValues(input, constraints.pathFields);
    if (values.length === 0) {
      return {
        ok: false,
        reason: `the rule restricts the action to paths (${constraints.paths.join(", ")}), but the input has no path-like fields`,
      };
    }
    const outside = values.filter((value) => !allowCovers(constraints.paths!, value));
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
 *
 * latch never touches the filesystem, so it can't know how a tool will read a
 * path. Deny matching is deliberately loose: it fires if *any* plausible
 * reading matches — as written or with `..` resolved (the two differ when a
 * segment is a symlink), ignoring case (macOS and Windows defaults), as a
 * `file://` URL, or with backslashes as separators.
 */
export function denyPathsFire(constraints: Constraints, input: unknown): boolean {
  if (constraints.paths === undefined || constraints.paths.length === 0) return false;
  const values = findPathValues(input, constraints.pathFields);
  return values.some((value) =>
    spellings(value).some((spelling) =>
      constraints.paths!.some((pattern) =>
        READINGS.some((reading) => matches(pattern, spelling, reading)),
      ),
    ),
  );
}

/**
 * Allow matching is the strict mirror: every reading of the value must be
 * covered, case-sensitively, and a path with a `..` segment is covered only by
 * a pattern that has one too — `workspace/link/../secret` may leave
 * `workspace` if `link` is a symlink, so `workspace/**` never covers it.
 */
function allowCovers(patterns: readonly string[], value: string): boolean {
  return spellings(value).every((spelling) =>
    patterns.some(
      (pattern) =>
        matches(pattern, spelling, RESOLVED) && (!hasDotDot(spelling) || hasDotDot(pattern)),
    ),
  );
}

interface Reading {
  resolveDots: boolean;
  ignoreCase: boolean;
}

const RESOLVED: Reading = { resolveDots: true, ignoreCase: false };
const READINGS: Reading[] = [
  RESOLVED,
  { resolveDots: false, ignoreCase: false },
  { resolveDots: true, ignoreCase: true },
  { resolveDots: false, ignoreCase: true },
];

/**
 * The value as written, plus the path a `file://` URL names, the
 * percent-decoded form (a tool that decodes `%2e%2e` reads `..`), and a
 * `/`-separated form.
 */
function spellings(value: string): string[] {
  const out = new Set([value]);
  if (/^file:/i.test(value)) {
    try {
      out.add(decodeURIComponent(new URL(value).pathname));
    } catch {
      // not a parseable URL; the raw spelling still gets checked
    }
  }
  if (value.includes("%")) {
    try {
      out.add(decodeURIComponent(value));
    } catch {
      // malformed escapes can't decode to anything a tool would read either
    }
  }
  // Entries added here have no backslashes, so iterating the live set ends.
  for (const spelling of out) {
    if (spelling.includes("\\")) out.add(spelling.replaceAll("\\", "/"));
  }
  return [...out];
}

function hasDotDot(path: string): boolean {
  return /(?:^|[/\\])\.\.(?:[/\\]|$)/.test(path);
}

/**
 * Whether a path matches a `paths` pattern:
 * - `~` expands to the user's home directory
 * - a literal pattern matches itself and anything inside it (`~/.ssh` covers
 *   `~/.ssh/id_rsa` and `~/.ssh/agents/eve`)
 * - `*` matches within one path segment, `**` across segments
 * - `.` and `..` segments resolve first, so `~/tmp/../.ssh/id_rsa` is
 *   matched as `~/.ssh/id_rsa`
 */
export function pathMatches(pattern: string, path: string): boolean {
  return matches(pattern, path, RESOLVED);
}

function matches(pattern: string, path: string, reading: Reading): boolean {
  let expandedPattern = normalizePath(pattern, reading.resolveDots);
  let expandedPath = normalizePath(path, reading.resolveDots);
  if (reading.ignoreCase) {
    expandedPattern = expandedPattern.toLowerCase();
    expandedPath = expandedPath.toLowerCase();
  }
  if (expandedPattern === expandedPath) return true;

  if (!expandedPattern.includes("*")) {
    return expandedPath.startsWith(expandedPattern === "/" ? "/" : `${expandedPattern}/`);
  }

  return globToRegExp(expandedPattern).test(expandedPath);
}

/**
 * Expand `~`, then collapse repeated slashes and `.` segments, and — when
 * `resolveDots` — `..` segments too. Tilde goes first so `~/../x` resolves
 * against the home directory instead of dropping the `~`.
 */
function normalizePath(path: string, resolveDots: boolean): string {
  const expanded = expandTilde(path);
  const normalized = resolveDots
    ? posix.normalize(expanded)
    : expanded
        .replace(/\/{2,}/g, "/")
        .replace(/\/\.(?=\/|$)/g, "")
        .replace(/^(?:\.\/)+/, "");
  return normalized.length > 1 ? normalized.replace(/\/+$/, "") : normalized;
}

/** A value as it should appear in a reason string. */
export function describeValue(value: unknown): string {
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
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

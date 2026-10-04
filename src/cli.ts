#!/usr/bin/env node
/**
 * The latch CLI. Non-interactive by design — every command takes explicit
 * arguments, prints a decision, and communicates through documented exit codes
 * so agents (and CI) can script it.
 *
 * Exit codes:
 * - validate / list / prompt / init / types: 0 ok, 1 failed (types --check: 1 when stale)
 * - check: 0 allowed, 1 denied, 2 approval required, 3 invalid policy or usage
 */
import { existsSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { writeActionTypes } from "./codegen.js";
import { LatchParseError, formatIssues } from "./errors.js";
import { check } from "./evaluate.js";
import { loadPolicy } from "./load.js";
import { parsePolicy } from "./parse.js";
import { renderPrompt } from "./prompt.js";
import type { Constraints, LatchDecision } from "./types.js";

const INIT_TEMPLATE = `# Permissions for your AI agent, declared once and enforced everywhere.
# Docs: https://github.com/vyr-e/latch/blob/main/docs/schema.md

agent: my-agent

allow:
  # Unlisted actions are denied by default.
  web.search: true
  stripe.customers.read: true

  # Constraints tighten an action; every listed constraint must hold.
  stripe.refunds.create:
    max_amount: 50
    approval: required

deny:
  github.repositories.delete: true
  filesystem:
    paths:
      - ~/.ssh
      - ~/.aws
`;

const USAGE = `latch — a permission system for AI agents, declared in one YAML file

Usage:
  latch init [file]              Scaffold a starter policy (default: ./latch.yaml)
  latch validate [file]          Parse and validate a policy file
  latch check <action>           Evaluate one action against the policy
      [--input '<json>']         Input object, e.g. '{"amount": 80}'
      [--input-file <path>]      Read the input object from a file
      [--file <path>]            Policy file (default: nearest latch.yaml)
      [--json]                   Machine-readable decision
  latch list [file]              List the effective allow/deny rules
  latch prompt [file]            Print the policy as a system-prompt section
  latch types [file]             Generate action-name types for createGate
      [--out <path>]             Output file (default: latch-env.d.ts beside the policy)
      [--check]                  Exit 1 if the output is missing or stale; write nothing

Exit codes for check: 0 allowed, 1 denied, 2 approval required, 3 invalid policy.
`;

export function main(argv: string[]): number {
  const [command, ...rest] = argv;
  switch (command) {
    case "init":
      return cmdInit(rest);
    case "validate":
      return cmdValidate(rest);
    case "check":
      return cmdCheck(rest);
    case "list":
      return cmdList(rest);
    case "prompt":
      return cmdPrompt(rest);
    case "types":
      return cmdTypes(rest);
    case "--help":
    case "-h":
    case "help":
    case undefined:
      process.stdout.write(USAGE);
      return 0;
    default:
      process.stderr.write(`latch: unknown command "${command}"\n\n${USAGE}`);
      return 1;
  }
}

function cmdInit(rest: string[]): number {
  const positional = rest.filter((arg) => !arg.startsWith("-"));
  const file = resolve(positional[0] ?? "latch.yaml");
  if (existsSync(file)) {
    process.stderr.write(`latch: ${file} already exists — refusing to overwrite\n`);
    return 1;
  }
  writeFileSync(file, INIT_TEMPLATE);
  const types = writeActionTypes(parsePolicy(INIT_TEMPLATE, { file }), file);
  process.stdout.write(
    `created ${file}\ncreated ${types.file} (action-name types for createGate)\nnext: edit the allow/deny lists, then run \`latch validate\`\n`,
  );
  return 0;
}

function cmdValidate(rest: string[]): number {
  const file = rest.find((arg) => !arg.startsWith("-"));
  try {
    const loaded = loadPolicy(file);
    const { policy } = loaded;
    process.stdout.write(
      `${relative(loaded.file)} is valid — ${policy.allow.length} allow rule(s), ${policy.deny.length} deny rule(s), default: ${policy.default}\n`,
    );
    return 0;
  } catch (error) {
    process.stderr.write(`${formatError(error)}\n`);
    return 1;
  }
}

function cmdCheck(rest: string[]): number {
  const flags = parseFlags(rest, ["--input", "--input-file", "--file"]);
  const action = flags.positional[0];
  if (!action) {
    process.stderr.write(
      "latch check: an action is required, e.g. `latch check stripe.refunds.create --input '{\"amount\": 80}'`\n",
    );
    return 3;
  }

  let input: unknown;
  if (flags.get("--input") !== undefined) {
    try {
      input = JSON.parse(flags.get("--input")!);
    } catch (error) {
      process.stderr.write(`latch check: --input is not valid JSON: ${(error as Error).message}\n`);
      return 3;
    }
  } else if (flags.get("--input-file") !== undefined) {
    try {
      input = JSON.parse(readText(flags.get("--input-file")!));
    } catch (error) {
      process.stderr.write(
        `latch check: could not read --input-file: ${(error as Error).message}\n`,
      );
      return 3;
    }
  }

  try {
    const { policy } = loadPolicy(flags.get("--file"));
    const decision = check(policy, action, input);
    if (flags.has("--json")) {
      process.stdout.write(`${JSON.stringify(decision, null, 2)}\n`);
    } else {
      process.stdout.write(`${describeDecision(decision)}\n`);
    }
    return decision.effect === "allow" ? 0 : decision.effect === "deny" ? 1 : 2;
  } catch (error) {
    process.stderr.write(`${formatError(error)}\n`);
    return 3;
  }
}

function cmdList(rest: string[]): number {
  try {
    const { policy } = loadPolicy(rest.find((arg) => !arg.startsWith("-")));
    process.stdout.write(`agent: ${policy.agent ?? "(unnamed)"}  default: ${policy.default}\n\n`);
    process.stdout.write("ALLOW\n");
    if (policy.allow.length === 0) process.stdout.write("  (nothing)\n");
    for (const rule of policy.allow) {
      process.stdout.write(`  ${rule.action}${describeConstraints(rule)}\n`);
    }
    process.stdout.write("\nDENY\n");
    if (policy.deny.length === 0) process.stdout.write("  (nothing)\n");
    for (const rule of policy.deny) {
      process.stdout.write(`  ${rule.action}${describeConstraints(rule)}\n`);
    }
    return 0;
  } catch (error) {
    process.stderr.write(`${formatError(error)}\n`);
    return 1;
  }
}

function cmdPrompt(rest: string[]): number {
  try {
    const loaded = loadPolicy(rest.find((arg) => !arg.startsWith("-")));
    process.stdout.write(renderPrompt(loaded.policy, { file: relative(loaded.file) }));
    return 0;
  } catch (error) {
    process.stderr.write(`${formatError(error)}\n`);
    return 1;
  }
}

function cmdTypes(rest: string[]): number {
  const flags = parseFlags(rest, ["--out"]);
  try {
    const loaded = loadPolicy(flags.positional[0]);
    const out = flags.get("--out");
    const checkOnly = flags.has("--check");
    const result = writeActionTypes(loaded.policy, loaded.file, {
      out: out === undefined ? undefined : resolve(out),
      check: checkOnly,
    });
    if (!checkOnly) {
      process.stdout.write(`wrote ${relative(result.file)}\n`);
      return 0;
    }
    if (result.upToDate) {
      process.stdout.write(`${relative(result.file)} is up to date\n`);
      return 0;
    }
    process.stderr.write(
      `latch types: ${relative(result.file)} is out of date with ${relative(loaded.file)} — run \`latch types\` to regenerate it\n`,
    );
    return 1;
  } catch (error) {
    process.stderr.write(`${formatError(error)}\n`);
    return 1;
  }
}

function describeDecision(decision: LatchDecision): string {
  if (decision.effect === "allow") {
    return `ALLOWED ${decision.action} (matched: ${decision.matched.section} "${decision.matched.pattern}")${decision.reason ? ` — ${decision.reason}` : ""}`;
  }
  if (decision.effect === "deny") {
    const via = decision.matched
      ? ` (matched: ${decision.matched.section} "${decision.matched.pattern}")`
      : "";
    return `DENIED  ${decision.action}${via} — ${decision.reason}`;
  }
  return `APPROVAL REQUIRED  ${decision.action} (matched: ${decision.matched.section} "${decision.matched.pattern}") — ${decision.reason}`;
}

function describeConstraints(rule: { constraints: Constraints }): string {
  const parts: string[] = [];
  if (rule.constraints.maxAmount !== undefined)
    parts.push(`max_amount: ${rule.constraints.maxAmount}`);
  if (rule.constraints.approval !== undefined) parts.push(`approval: ${rule.constraints.approval}`);
  if (rule.constraints.paths !== undefined)
    parts.push(`paths: ${rule.constraints.paths.join(", ")}`);
  if (rule.constraints.description !== undefined) parts.push(rule.constraints.description);
  return parts.length > 0 ? `  (${parts.join("; ")})` : "";
}

function parseFlags(
  argv: string[],
  valued: string[],
): {
  positional: string[];
  has: (flag: string) => boolean;
  get: (flag: string) => string | undefined;
} {
  const positional: string[] = [];
  const values = new Map<string, string>();
  const booleans = new Set<string>();
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (valued.includes(arg)) {
      const value = argv[i + 1];
      if (value === undefined) {
        process.stderr.write(`latch: ${arg} expects a value\n`);
        process.exit(3);
      }
      values.set(arg, value);
      i++;
    } else if (arg.startsWith("-")) {
      booleans.add(arg);
    } else {
      positional.push(arg);
    }
  }
  return {
    positional,
    has: (flag) => booleans.has(flag) || values.has(flag),
    get: (flag) => values.get(flag),
  };
}

function formatError(error: unknown): string {
  if (error instanceof LatchParseError) {
    return `invalid policy:\n${formatIssues(error.issues)}`;
  }
  return error instanceof Error ? error.message : String(error);
}

function relative(file: string): string {
  const cwd = process.cwd();
  return file.startsWith(cwd) ? file.slice(cwd.length + 1) : file;
}

function readText(path: string): string {
  return readFileSync(path, "utf8");
}

if (isMainModule()) {
  process.exit(main(process.argv.slice(2)));
}

/** True when this module is the process entry — including through a symlinked bin shim. */
function isMainModule(): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  let entryReal: string;
  let moduleReal: string;
  try {
    entryReal = realpathSync(entry);
    moduleReal = realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
  return entryReal === moduleReal;
}

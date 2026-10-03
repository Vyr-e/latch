import { existsSync } from "node:fs";
import { readFileSync } from "node:fs";
import { dirname, isAbsolute, resolve, sep } from "node:path";
import { parsePolicy } from "./parse.js";
import type { LatchPolicy } from "./types.js";

const POLICY_FILENAMES = ["latch.yaml", "latch.yml", ".latch.yaml"];

export interface LoadedPolicy {
  policy: LatchPolicy;
  /** Absolute path of the file the policy was loaded from. */
  file: string;
}

/**
 * Load a policy from an explicit file, or discover one by walking up from
 * `from` (default: the current working directory) looking for `latch.yaml`,
 * `latch.yml`, or `.latch.yaml`. Throws LatchParseError when nothing is found
 * or the file is invalid — the error message is the fix-it guide.
 */
export function loadPolicy(path?: string, options: { from?: string } = {}): LoadedPolicy {
  const file = path ? resolvePath(path) : findPolicyFile(options.from ?? process.cwd());
  if (!file) {
    throw new Error(
      `latch: no policy file found walking up from ${options.from ?? process.cwd()} — looked for ${POLICY_FILENAMES.join(", ")}. Run \`latch init\` to create one, or pass an explicit path.`,
    );
  }
  return { policy: parsePolicy(readFileSync(file, "utf8"), { file }), file };
}

/**
 * Find the nearest policy file walking up from `from`. Returns its absolute
 * path, or undefined. Directories named `node_modules` are skipped.
 */
export function findPolicyFile(from: string = process.cwd()): string | undefined {
  let dir = resolvePath(from);
  for (;;) {
    if (dir.split(sep).at(-1) !== "node_modules") {
      for (const candidate of POLICY_FILENAMES) {
        const file = `${dir}${sep}${candidate}`;
        if (existsSync(file)) return file;
      }
    }
    const parent = dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
}

function resolvePath(path: string): string {
  return isAbsolute(path) ? path : resolve(process.cwd(), path);
}

import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { findPolicyFile, loadPolicy } from "./load.js";

const tmp = mkdtempSync(join(tmpdir(), "latch-load-"));
const root = join(tmp, "project");
const nested = join(root, "agent", "tools");
mkdirSync(nested, { recursive: true });
writeFileSync(join(root, "latch.yaml"), "agent: demo\nallow:\n  a.b: true\n");
writeFileSync(join(tmp, "standalone.yml"), "allow:\n  x.y: true\n");

afterAll(() => rmSync(tmp, { recursive: true, force: true }));

describe("findPolicyFile", () => {
  test("walks up to the nearest policy file", () => {
    expect(findPolicyFile(nested)).toBe(join(root, "latch.yaml"));
  });

  test("prefers latch.yaml over its siblings", () => {
    writeFileSync(join(root, "latch.yml"), "allow: {}\n");
    expect(findPolicyFile(root)).toBe(join(root, "latch.yaml"));
  });

  test("returns undefined when nothing is found", () => {
    expect(findPolicyFile(tmpdir())).toBeUndefined();
  });
});

describe("loadPolicy", () => {
  test("loads an explicit file", () => {
    const loaded = loadPolicy(join(tmp, "standalone.yml"));
    expect(loaded.policy.agent).toBeUndefined();
    expect(loaded.policy.allow[0]?.action).toBe("x.y");
    expect(loaded.file).toBe(join(tmp, "standalone.yml"));
  });

  test("discovers the nearest file from a start directory", () => {
    const loaded = loadPolicy(undefined, { from: nested });
    expect(loaded.policy.agent).toBe("demo");
  });

  test("explains itself when no policy exists", () => {
    expect(() => loadPolicy(undefined, { from: tmpdir() })).toThrow(/no policy file found/);
    expect(() => loadPolicy("/nonexistent/latch.yaml")).toThrow();
  });
});

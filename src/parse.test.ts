import { describe, expect, test } from "bun:test";
import { LatchParseError } from "./errors.js";
import { parsePolicy, suggest } from "./parse.js";

const SUPPORT_AGENT = `
agent: support-agent

allow:
  stripe.customers.read: true
  stripe.refunds.create:
    max_amount: 50
    approval: required
  github.issues.create: true

deny:
  github.repositories.delete: true
  filesystem:
    paths:
      - ~/.ssh
      - ~/.aws
`;

describe("parsePolicy", () => {
  test("parses the canonical support-agent policy", () => {
    const policy = parsePolicy(SUPPORT_AGENT);
    expect(policy.agent).toBe("support-agent");
    expect(policy.default).toBe("deny");
    expect(policy.allow).toEqual([
      { action: "stripe.customers.read", constraints: {} },
      { action: "stripe.refunds.create", constraints: { maxAmount: 50, approval: "required" } },
      { action: "github.issues.create", constraints: {} },
    ]);
    // A bare filesystem.paths entry is a statement about the paths themselves,
    // so it normalizes to a global path deny.
    expect(policy.deny).toEqual([
      { action: "github.repositories.delete", constraints: {} },
      { action: "*", constraints: { paths: ["~/.ssh", "~/.aws"] } },
    ]);
  });

  test("a bare filesystem.paths entry stays global when it carries extra constraint keys", () => {
    // Adding a description must not scope the rule down to an action literally
    // named "filesystem".
    const policy = parsePolicy(`
deny:
  filesystem:
    paths:
      - ~/.ssh
    description: secrets
`);
    expect(policy.deny).toEqual([
      { action: "*", constraints: { paths: ["~/.ssh"], description: "secrets" } },
    ]);
  });

  test("normalizes nested maps and flat dotted keys to the same rules", () => {
    const nested = parsePolicy(`
allow:
  stripe:
    customers:
      read: true
    refunds:
      create:
        max_amount: 50
`);
    const flat = parsePolicy(`
allow:
  stripe.customers.read: true
  stripe.refunds.create:
    max_amount: 50
`);
    expect(nested.allow).toEqual(flat.allow);
  });

  test("accepts an explicit default and preserves it", () => {
    const policy = parsePolicy("default: allow\ndeny:\n  exec.*: true\n");
    expect(policy.default).toBe("allow");
    expect(policy.allow).toEqual([]);
  });

  test("collects every validation problem, each with its line number", () => {
    let error: LatchParseError | undefined;
    try {
      parsePolicy(
        `agent: support-agent\nallow:\n  stripe.refunds.create:\n    max_amount: fifty\n    approval: sometimes\ndeny:\n  github.repositories.delete: false\n`,
        { file: "latch.yaml" },
      );
    } catch (e) {
      error = e as LatchParseError;
    }
    expect(error).toBeInstanceOf(LatchParseError);
    const messages = error!.issues.map((issue) => `${issue.line}: ${issue.message}`);
    expect(messages).toHaveLength(3);
    expect(messages[0]).toContain('"max_amount" must be a non-negative number');
    expect(messages[0]!.startsWith("4:")).toBe(true);
    expect(messages[1]).toContain('"approval" must be "required" or "never"');
    expect(messages[2]).toContain("false");
  });

  test("suggests the intended key for near-miss root keys", () => {
    try {
      parsePolicy("allowd:\n  x: true\n");
      throw new Error("expected LatchParseError");
    } catch (e) {
      const error = e as LatchParseError;
      expect(error.issues[0]!.message).toContain('did you mean "allow"?');
    }
  });

  test("reports typo'd constraint keys instead of creating sub-actions", () => {
    try {
      parsePolicy("allow:\n  stripe.refunds.create:\n    max_amout: 50\n");
      throw new Error("expected LatchParseError");
    } catch (e) {
      const messages = (e as LatchParseError).issues.map((issue) => issue.message);
      expect(messages.some((m) => m.includes('did you mean "max_amount"?'))).toBe(true);
    }
  });

  test("rejects mixing constraints with sub-actions", () => {
    try {
      parsePolicy("allow:\n  stripe:\n    max_amount: 50\n    customers.read: true\n");
      throw new Error("expected LatchParseError");
    } catch (e) {
      const messages = (e as LatchParseError).issues.map((issue) => issue.message);
      expect(messages.some((m) => m.includes("mixes constraints"))).toBe(true);
    }
  });

  test("gives false entries per-section guidance", () => {
    try {
      parsePolicy("allow:\n  a.b: false\ndeny:\n  c.d: false\n");
      throw new Error("expected LatchParseError");
    } catch (e) {
      const messages = (e as LatchParseError).issues.map((issue) => issue.message);
      expect(messages[0]).toContain("move it under deny");
      expect(messages[1]).toContain("does nothing");
    }
  });

  test("rejects mid-pattern wildcards", () => {
    try {
      parsePolicy("allow:\n  stripe.*.read: true\n");
      throw new Error("expected LatchParseError");
    } catch (e) {
      expect((e as LatchParseError).issues[0]!.message).toContain(
        "only supported as the last segment",
      );
    }
  });

  test("rejects malformed YAML with a syntax error and line info", () => {
    try {
      parsePolicy("allow: [1, 2\n", { file: "latch.yaml" });
      throw new Error("expected LatchParseError");
    } catch (e) {
      const error = e as LatchParseError;
      expect(error.issues).toHaveLength(1);
      // The unterminated flow sequence is still open at end of input, so the
      // parser reports the line after it starts.
      expect(error.issues[0]!.line).toBeGreaterThanOrEqual(1);
      expect(error.issues[0]!.file).toBe("latch.yaml");
    }
  });

  test("rejects unknown and empty constraints", () => {
    try {
      parsePolicy("allow:\n  fs.read:\n    paths: []\n    ttl: 5\n");
      throw new Error("expected LatchParseError");
    } catch (e) {
      const messages = (e as LatchParseError).issues.map((issue) => issue.message);
      expect(messages.some((m) => m.includes('"paths" must be a non-empty list'))).toBe(true);
      expect(messages.some((m) => m.includes('"ttl" is not a constraint'))).toBe(true);
    }
  });
});

describe("suggest", () => {
  test("finds close matches", () => {
    expect(suggest("allowd", ["agent", "version", "default", "allow", "deny"])).toBe("allow");
    expect(suggest("paths2", ["max_amount", "approval", "paths", "description"])).toBe("paths");
  });

  test("returns undefined for distant keys", () => {
    expect(suggest("totally-unrelated", ["allow", "deny"])).toBeUndefined();
  });
});

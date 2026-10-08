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

  test("parses path_fields beside paths, including on the global filesystem entry", () => {
    const policy = parsePolicy(`
allow:
  render.export:
    paths: [exports]
    path_fields: [output]
deny:
  filesystem:
    paths: [~/.ssh]
    path_fields: [uri]
`);
    expect(policy.allow).toEqual([
      { action: "render.export", constraints: { paths: ["exports"], pathFields: ["output"] } },
    ]);
    expect(policy.deny).toEqual([
      { action: "*", constraints: { paths: ["~/.ssh"], pathFields: ["uri"] } },
    ]);
  });

  test("rejects path_fields that are malformed or have no paths to check", () => {
    try {
      parsePolicy(`
allow:
  a.b:
    path_fields: [output]
  c.d:
    paths: [x]
    path_fields: output
`);
      throw new Error("expected LatchParseError");
    } catch (e) {
      const messages = (e as LatchParseError).issues.map((issue) => issue.message);
      expect(messages.some((m) => m.includes('only applies alongside "paths"'))).toBe(true);
      expect(messages.some((m) => m.includes('"path_fields" must be a non-empty list'))).toBe(true);
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

describe("parsePolicy: classifier, mode, and history", () => {
  test("parses a full classifier and history block into normalized settings", () => {
    const policy = parsePolicy(`
agent: support-agent
mode: hybrid
allow:
  github.issues.create: true
classifier:
  provider: judge
  thresholds:
    execute: 0.9
    review: 0.6
    necessity: 0.75
  invoke: conditional
  conditions:
    on_unmatched: true
    on_urgency: true
  fallback: review
  timeout_ms: 5000
history:
  enabled: true
  max_entries: 100
`);
    expect(policy.mode).toBe("hybrid");
    expect(policy.classifier).toEqual({
      provider: "judge",
      thresholds: { execute: 0.9, review: 0.6, necessity: 0.75 },
      invoke: "conditional",
      conditions: { onUnmatched: true, onUrgency: true },
      fallback: "review",
      timeoutMs: 5000,
    });
    expect(policy.history).toEqual({ enabled: true, maxEntries: 100 });
  });

  test("a classifier block without a mode implies hybrid", () => {
    const policy = parsePolicy("allow:\n  a.b: true\nclassifier:\n  provider: judge\n");
    expect(policy.mode).toBe("hybrid");
  });

  test("policies without the contextual keys keep their exact old shape", () => {
    const policy = parsePolicy("allow:\n  a.b: true\n");
    expect(policy.mode).toBeUndefined();
    expect(policy.classifier).toBeUndefined();
    expect(policy.history).toBeUndefined();
    expect(Object.keys(policy).sort()).toEqual(["agent", "allow", "default", "deny", "version"]);
  });

  test("classifier: enabled false is treated as absent", () => {
    const policy = parsePolicy(
      "allow:\n  a.b: true\nclassifier:\n  enabled: false\n  provider: judge\n",
    );
    expect(policy.classifier).toBeUndefined();
    expect(policy.mode).toBeUndefined();
  });

  test("rejects unknown classifier settings with a did-you-mean", () => {
    try {
      parsePolicy("classifier:\n  provider: judge\n  invok: always\n");
      throw new Error("expected LatchParseError");
    } catch (e) {
      const messages = (e as LatchParseError).issues.map((issue) => issue.message);
      expect(messages.some((m) => m.includes('"invok" is not a classifier setting'))).toBe(true);
      expect(messages.some((m) => m.includes('did you mean "invoke"'))).toBe(true);
    }
  });

  test("rejects an out-of-range threshold with line info", () => {
    try {
      parsePolicy("classifier:\n  provider: judge\n  thresholds:\n    execute: 1.4\n");
      throw new Error("expected LatchParseError");
    } catch (e) {
      const issue = (e as LatchParseError).issues[0]!;
      expect(issue.message).toContain("between 0 and 1");
      expect(issue.line).toBe(4);
    }
  });

  test("rejects review above execute", () => {
    try {
      parsePolicy(
        "classifier:\n  provider: judge\n  thresholds:\n    execute: 0.6\n    review: 0.9\n",
      );
      throw new Error("expected LatchParseError");
    } catch (e) {
      expect((e as LatchParseError).issues[0]!.message).toContain(
        "must not exceed the execute threshold",
      );
    }
  });

  test("rejects conditions without invoke: conditional", () => {
    try {
      parsePolicy(
        "classifier:\n  provider: judge\n  invoke: always\n  conditions:\n    on_urgency: true\n",
      );
      throw new Error("expected LatchParseError");
    } catch (e) {
      expect((e as LatchParseError).issues[0]!.message).toContain(
        "only applies when invoke: conditional",
      );
    }
  });

  test("rejects mode: deterministic with a classifier block", () => {
    try {
      parsePolicy("mode: deterministic\nclassifier:\n  provider: judge\n");
      throw new Error("expected LatchParseError");
    } catch (e) {
      expect((e as LatchParseError).issues[0]!.message).toContain(
        "mode: deterministic but configures a classifier",
      );
    }
  });

  test("rejects mode: classifier without a bounded capability scope", () => {
    try {
      parsePolicy("mode: classifier\nclassifier:\n  provider: judge\n");
      throw new Error("expected LatchParseError");
    } catch (e) {
      expect((e as LatchParseError).issues[0]!.message).toContain("bounded capability scope");
    }
    try {
      parsePolicy("mode: classifier\ndefault: allow\nclassifier:\n  provider: judge\n");
      throw new Error("expected LatchParseError");
    } catch (e) {
      expect((e as LatchParseError).issues[0]!.message).toContain("bounded capability scope");
    }
  });

  test("rejects an invalid mode value and a missing provider", () => {
    try {
      parsePolicy("mode: probabilistic\nclassifier:\n  thresholds:\n    execute: 0.5\n");
      throw new Error("expected LatchParseError");
    } catch (e) {
      const messages = (e as LatchParseError).issues.map((issue) => issue.message);
      expect(messages.some((m) => m.includes('"mode" must be'))).toBe(true);
      expect(
        messages.some((m) => m.includes('"classifier.provider" must be a non-empty string')),
      ).toBe(true);
    }
  });

  test("rejects malformed history blocks", () => {
    try {
      parsePolicy("history:\n  enabled: maybe\n");
      throw new Error("expected LatchParseError");
    } catch (e) {
      expect((e as LatchParseError).issues[0]!.message).toContain(
        '"history.enabled" must be true or false',
      );
    }
    try {
      parsePolicy("history:\n  enabled: true\n  max_entries: 0\n");
      throw new Error("expected LatchParseError");
    } catch (e) {
      expect((e as LatchParseError).issues[0]!.message).toContain("positive integer");
    }
  });

  test("history disabled parses to absent settings", () => {
    const policy = parsePolicy("history:\n  enabled: false\n");
    expect(policy.history).toBeUndefined();
  });
});

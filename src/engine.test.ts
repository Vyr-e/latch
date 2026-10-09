import { describe, expect, test } from "bun:test";
import {
  createClassifier,
  type ClassificationInput,
  type ClassificationResult,
} from "./classifier.js";
import { evaluate } from "./engine.js";
import { createMemoryHistory } from "./history.js";
import { definePolicy, parsePolicy } from "./index.js";
import type { LatchPolicy } from "./types.js";

const HYBRID_YAML = `
agent: support-agent
mode: hybrid

allow:
  stripe.customers.read: true
  github.issues.create: true
  stripe.refunds.create:
    max_amount: 50
    approval: required

deny:
  github.repositories.delete: true
`;

const CLASSIFIER_YAML = `
agent: support-agent
mode: classifier

allow:
  github.issues.create: true
  stripe.customers.read: true

classifier:
  provider: judge
  thresholds:
    execute: 0.85
    review: 0.55
  fallback: skip
`;

function input(overrides: Partial<ClassificationInput> = {}): ClassificationInput {
  return {
    agent: { id: "support-1" },
    task: { objective: "Investigate payment failures" },
    action: { tool: "github.issues.create", arguments: { title: "Payment failures" } },
    context: { currentMessage: "Payments are failing repeatedly, please track it" },
    ...overrides,
  };
}

function mockClassifier(
  returns: ClassificationResult | ((input: ClassificationInput) => ClassificationResult),
  options: { fallback?: "skip" | "review" | "deny"; id?: string } = {},
) {
  const predict = typeof returns === "function" ? returns : () => returns;
  return createClassifier({
    id: options.id ?? "mock",
    model: { predict },
    fallback: options.fallback,
  });
}

function execute_(
  confidence: number,
  decision: ClassificationResult["decision"] = "execute",
): ClassificationResult {
  return {
    decision,
    scores: { relevance: 0.95, necessity: 0.9, urgency: 0.8 },
    confidence,
  };
}

describe("evaluate: authorization never widens", () => {
  const policy = parsePolicy(HYBRID_YAML);

  test("an explicitly denied tool stays denied despite a high-confidence recommendation", async () => {
    const evaluation = await evaluate(
      policy,
      { classifier: mockClassifier(execute_(0.99)) },
      input({ action: { tool: "github.repositories.delete", arguments: {} } }),
    );
    expect(evaluation.authorization).toBe("deny");
    expect(evaluation.execution).toBe("skip");
    expect(evaluation.classification).toBeUndefined(); // lazy inference: denied calls never reach the model
  });

  test("an unrecognized tool stays denied (default deny)", async () => {
    const evaluation = await evaluate(
      policy,
      { classifier: mockClassifier(execute_(0.99)) },
      input({ action: { tool: "aws.s3.delete", arguments: {} } }),
    );
    expect(evaluation.authorization).toBe("deny");
    expect(evaluation.execution).toBe("skip");
  });

  test("a required approval survives a high-confidence recommendation", async () => {
    const evaluation = await evaluate(
      policy,
      { classifier: mockClassifier(execute_(0.99)) },
      input({ action: { tool: "stripe.refunds.create", arguments: { amount: 30 } } }),
    );
    expect(evaluation.authorization).toBe("requires_approval");
    expect(evaluation.execution).toBe("execute");
  });

  test("a failed constraint denies even when the classifier would execute", async () => {
    const evaluation = await evaluate(
      policy,
      { classifier: mockClassifier(execute_(0.99)) },
      input({ action: { tool: "stripe.refunds.create", arguments: { amount: 500 } } }),
    );
    expect(evaluation.authorization).toBe("deny");
    expect(evaluation.decision.reason).toContain("exceeds max_amount 50");
  });

  test("agent-tagged urgency on an unauthorized action is still denied", async () => {
    const evaluation = await evaluate(
      policy,
      { classifier: mockClassifier(execute_(0.99)) },
      input({
        task: { objective: "fix it", urgency: "critical" },
        action: { tool: "github.repositories.delete", arguments: {} },
      }),
    );
    expect(evaluation.authorization).toBe("deny");
  });
});

describe("evaluate: hybrid execution decisions", () => {
  const policy = parsePolicy(HYBRID_YAML);

  test("authorized + high-confidence execute executes, sourced hybrid", async () => {
    const evaluation = await evaluate(
      policy,
      { classifier: mockClassifier(execute_(0.95)) },
      input(),
    );
    expect(evaluation.authorization).toBe("allow");
    expect(evaluation.execution).toBe("execute");
    expect(evaluation.source).toBe("hybrid");
    expect(evaluation.classification?.decision).toBe("execute");
  });

  test("authorized + explicit skip skips", async () => {
    const evaluation = await evaluate(
      policy,
      { classifier: mockClassifier(execute_(0.95, "skip")) },
      input(),
    );
    expect(evaluation.authorization).toBe("allow");
    expect(evaluation.execution).toBe("skip");
  });

  test("authorized + mid confidence routes to review", async () => {
    const evaluation = await evaluate(
      policy,
      { classifier: mockClassifier(execute_(0.7)) },
      input(),
    );
    expect(evaluation.execution).toBe("review");
  });

  test("authorized + low confidence applies the skip fallback", async () => {
    const evaluation = await evaluate(
      policy,
      { classifier: mockClassifier(execute_(0.2)) },
      input(),
    );
    expect(evaluation.authorization).toBe("allow");
    expect(evaluation.execution).toBe("skip");
  });

  test("classifier failure with fallback: deny denies an authorized call", async () => {
    const classifier = createClassifier({
      id: "broken",
      model: {},
      predict: () => {
        throw new Error("model offline");
      },
      fallback: "deny",
    });
    const evaluation = await evaluate(policy, { classifier }, input());
    expect(evaluation.authorization).toBe("deny");
    expect(evaluation.execution).toBe("skip");
    expect(evaluation.reason).toContain("model offline");
  });

  test("classifier failure with fallback: review routes to review", async () => {
    const classifier = createClassifier({
      model: {},
      predict: () => {
        throw new Error("timeout");
      },
      fallback: "review",
    });
    const evaluation = await evaluate(policy, { classifier }, input());
    expect(evaluation.authorization).toBe("allow");
    expect(evaluation.execution).toBe("review");
  });

  test("a policy without mode and no classifier keeps deterministic behavior exactly", async () => {
    const plain = parsePolicy("allow:\n  github.issues.create: true\n");
    const evaluation = await evaluate(plain, {}, input());
    expect(evaluation.authorization).toBe("allow");
    expect(evaluation.execution).toBe("execute");
    expect(evaluation.source).toBe("deterministic");
    expect(evaluation.classification).toBeUndefined();
  });

  test("mode: hybrid with no classifier bound skips instead of executing unjudged", async () => {
    const evaluation = await evaluate(policy, {}, input());
    expect(evaluation.authorization).toBe("allow");
    expect(evaluation.execution).toBe("skip");
    expect(evaluation.reason).toContain("no classifier is bound");

    const denied = await evaluate(
      policy,
      {},
      input({ action: { tool: "github.repositories.delete", arguments: {} } }),
    );
    expect(denied.authorization).toBe("deny");
  });

  test("mode: deterministic with a bound classifier never invokes it", async () => {
    const strict = parsePolicy(`
allow:
  github.issues.create: true
mode: deterministic
`);
    const evaluation = await evaluate(
      strict,
      { classifier: mockClassifier(execute_(0.95, "skip")) },
      input(),
    );
    expect(evaluation.execution).toBe("execute");
    expect(evaluation.source).toBe("deterministic");
  });
});

describe("evaluate: invocation strategies", () => {
  test("invoke: manual only classifies when asked", async () => {
    const policy = parsePolicy(`
allow:
  github.issues.create: true
classifier:
  provider: mock
  invoke: manual
`);
    const seen: string[] = [];
    const classifier = mockClassifier((i) => {
      seen.push(i.action.tool);
      return execute_(0.95, "skip");
    });
    const runtime = { classifier };

    const unasked = await evaluate(policy, runtime, input());
    expect(unasked.execution).toBe("execute"); // manual + not asked: deterministic
    expect(seen).toHaveLength(0);

    const asked = await evaluate(policy, runtime, input(), { classify: true });
    expect(asked.execution).toBe("skip");
    expect(seen).toEqual(["github.issues.create"]);
  });

  test("conditional + on_urgency classifies only when urgency is present", async () => {
    const policy = parsePolicy(`
allow:
  github.issues.create: true
classifier:
  provider: mock
  invoke: conditional
  conditions:
    on_urgency: true
`);
    let calls = 0;
    const runtime = {
      classifier: mockClassifier(() => {
        calls++;
        return execute_(0.95, "skip");
      }),
    };

    await evaluate(policy, runtime, input()); // no urgency tag
    expect(calls).toBe(0);

    await evaluate(policy, runtime, input({ task: { objective: "fix", urgency: "high" } }));
    expect(calls).toBe(1);
  });

  test("conditional + on_unmatched classifies wildcard-authorized, not exact-match, calls", async () => {
    const policy = parsePolicy(`
allow:
  stripe.customers.read: true
  github.*: true
classifier:
  provider: mock
  invoke: conditional
  conditions:
    on_unmatched: true
`);
    let calls = 0;
    const runtime = {
      classifier: mockClassifier(() => {
        calls++;
        return execute_(0.95);
      }),
    };

    await evaluate(
      policy,
      runtime,
      input({ action: { tool: "stripe.customers.read", arguments: {} } }),
    );
    expect(calls).toBe(0); // exact rule spoke: no contextual gap to fill

    await evaluate(policy, runtime, input());
    expect(calls).toBe(1); // github.* wildcard authorized it: classify
  });
});

describe("evaluate: history", () => {
  const policy = parsePolicy(`
allow:
  github.issues.create: true
classifier:
  provider: mock
history:
  enabled: true
  max_entries: 5
`);

  test("records the classification and the final outcome", async () => {
    const store = createMemoryHistory();
    const evaluation = await evaluate(
      policy,
      { classifier: mockClassifier(execute_(0.95, "skip")), history: store },
      input(),
    );
    expect(store.size).toBe(1);
    const entry = store.list()[0]!;
    expect(entry.tool).toBe("github.issues.create");
    expect(entry.decision).toBe("skip");
    expect(entry.outcome.execution).toBe("skip");
    expect(entry.executed).toBe(false);
    expect(evaluation.historyId).toBe(entry.id);
  });

  test("no store means no recording, and nothing breaks", async () => {
    const evaluation = await evaluate(
      policy,
      { classifier: mockClassifier(execute_(0.95)) },
      input(),
    );
    expect(evaluation.historyId).toBeUndefined();
  });

  test("history: false disables recording even when the policy enables it", async () => {
    const evaluation = await evaluate(
      policy,
      { classifier: mockClassifier(execute_(0.95)), history: false },
      input(),
    );
    expect(evaluation.historyId).toBeUndefined();
  });

  test("feedHistory passes recent entries to the classifier without recorder-side effects", async () => {
    const store = createMemoryHistory();
    let seenHistoryLength = -1;
    const classifier = mockClassifier((i) => {
      seenHistoryLength = i.history?.length ?? 0;
      return execute_(0.95);
    });
    const runtime = { classifier, history: store, feedHistory: 3 };
    for (let i = 0; i < 5; i++) {
      await evaluate(policy, runtime, input({ task: { objective: `task ${i}` } }));
    }
    expect(seenHistoryLength).toBeLessThanOrEqual(3);
    expect(store.size).toBe(5);
  });
});

describe("evaluate: source reflects who decided", () => {
  test("classifier mode labels the source classifier", async () => {
    const policy = parsePolicy(CLASSIFIER_YAML);
    const evaluation = await evaluate(
      policy,
      { classifier: mockClassifier(execute_(0.95)) },
      input(),
    );
    expect(evaluation.source).toBe("classifier");
  });

  test("fallback-applied outcomes label the source deterministic", async () => {
    const policy = parsePolicy(CLASSIFIER_YAML);
    const evaluation = await evaluate(
      policy,
      { classifier: mockClassifier(execute_(0.1)) },
      input(),
    );
    expect(evaluation.source).toBe("deterministic");
    expect(evaluation.execution).toBe("skip");
  });
});

describe("YAML and TypeScript policies decide identically", () => {
  const yamlPolicy = parsePolicy(`
agent: parity
mode: hybrid
allow:
  github.issues.create: true
  stripe.*: true
deny:
  github.repositories.delete: true
classifier:
  provider: mock
  thresholds:
    execute: 0.9
  fallback: review
`);

  const tsPolicy: LatchPolicy = {
    ...definePolicy({
      agent: "parity",
      mode: "hybrid",
      allow: [{ action: "github.issues.create" }, { action: "stripe.*" }],
      deny: [{ action: "github.repositories.delete" }],
    }),
    classifier: { provider: "mock", thresholds: { execute: 0.9 }, fallback: "review" },
  };

  const cases: ClassificationInput[] = [
    input(),
    input({ action: { tool: "github.repositories.delete", arguments: {} } }),
    input({ action: { tool: "stripe.charges.list", arguments: {} } }),
    input({ action: { tool: "unknown.tool", arguments: {} } }),
  ];

  for (const [index, caseInput] of cases.entries()) {
    test(`case ${index}: identical evaluation`, async () => {
      // The mock's output must not depend on anything but the action, so both
      // policies see the same recommendations.
      const makeClassifier = () =>
        mockClassifier((i) => execute_(i.action.tool.includes("delete") ? 0.99 : 0.6));
      const yamlResult = await evaluate(
        yamlPolicy,
        { classifier: makeClassifier() },
        structuredClone(caseInput),
      );
      const tsResult = await evaluate(
        tsPolicy,
        { classifier: makeClassifier() },
        structuredClone(caseInput),
      );
      expect(tsResult).toEqual(yamlResult);
    });
  }
});

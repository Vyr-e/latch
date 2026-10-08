import { describe, expect, test } from "bun:test";
import { z } from "zod";
import {
  createClassifier,
  validateClassificationResult,
  type ClassificationInput,
  type ClassificationResult,
  type CreateClassifierOptions,
  type LatchClassifier,
} from "./classifier.js";

function input(overrides: Partial<ClassificationInput> = {}): ClassificationInput {
  return {
    agent: { id: "ashley" },
    task: { objective: "Help the user organize their projects" },
    action: { tool: "filesystem.read", arguments: { path: "/projects" } },
    context: { currentMessage: "Can you help me organize my unfinished projects?" },
    ...overrides,
  };
}

function result(overrides: Partial<ClassificationResult> = {}): ClassificationResult {
  return {
    decision: "execute",
    scores: { relevance: 0.94, necessity: 0.9, urgency: 0.7 },
    confidence: 0.95,
    ...overrides,
  };
}

/** A deterministic stand-in model: tests never depend on real inference. */
function mockModel(
  returns: ClassificationResult | ((input: ClassificationInput) => ClassificationResult),
) {
  const predict = typeof returns === "function" ? returns : () => returns;
  return { predict };
}

describe("createClassifier", () => {
  test("a high-confidence execute recommendation executes", async () => {
    const classifier = createClassifier({ model: mockModel(result()) });
    const outcome = await classifier.classify(input());
    expect(outcome.ok).toBe(true);
    if (outcome.ok) {
      expect(outcome.execution).toBe("execute");
      expect(outcome.via).toBe("model");
      expect(outcome.result.decision).toBe("execute");
    }
  });

  test("an explicit skip is never upgraded by confidence", async () => {
    const classifier = createClassifier({
      model: mockModel(result({ decision: "skip", confidence: 0.99 })),
    });
    const outcome = await classifier.classify(input());
    expect(outcome.ok).toBe(true);
    if (outcome.ok) expect(outcome.execution).toBe("skip");
  });

  test("confidence between review and execute routes to review", async () => {
    const classifier = createClassifier({
      model: mockModel(result({ confidence: 0.7 })),
      thresholds: { execute: 0.85, review: 0.55 },
    });
    const outcome = await classifier.classify(input());
    expect(outcome.ok).toBe(true);
    if (outcome.ok) expect(outcome.execution).toBe("review");
  });

  test("confidence below review applies the fallback", async () => {
    const classifier = createClassifier({
      model: mockModel(result({ confidence: 0.2 })),
      thresholds: { execute: 0.85, review: 0.55 },
    });
    const outcome = await classifier.classify(input());
    expect(outcome.ok).toBe(true);
    if (outcome.ok) {
      expect(outcome.execution).toBe("skip");
      expect(outcome.via).toBe("fallback");
    }
  });

  test("low confidence with fallback: review routes to review", async () => {
    const classifier = createClassifier({
      model: mockModel(result({ confidence: 0.2 })),
      thresholds: { execute: 0.85, review: 0.55 },
      fallback: "review",
    });
    const outcome = await classifier.classify(input());
    expect(outcome.ok).toBe(true);
    if (outcome.ok) expect(outcome.execution).toBe("review");
  });

  test("setting only execute caps review at it", async () => {
    const classifier = createClassifier({
      model: mockModel(result({ confidence: 0.5 })),
      thresholds: { execute: 0.5 },
    });
    const outcome = await classifier.classify(input());
    expect(outcome.ok).toBe(true);
    if (outcome.ok) expect(outcome.execution).toBe("execute");
  });

  test("a dimension floor below its score routes to review", async () => {
    const classifier = createClassifier({
      model: mockModel(result({ scores: { relevance: 0.9, necessity: 0.6, urgency: 0.9 } })),
      thresholds: { necessity: 0.75 },
    });
    const outcome = await classifier.classify(input());
    expect(outcome.ok).toBe(true);
    if (outcome.ok) expect(outcome.execution).toBe("review");
  });

  test("abstain without onUncertain applies the fallback", async () => {
    const classifier = createClassifier({
      model: mockModel(result({ decision: "abstain" })),
      fallback: "skip",
    });
    const outcome = await classifier.classify(input());
    expect(outcome.ok).toBe(true);
    if (outcome.ok) {
      expect(outcome.execution).toBe("skip");
      expect(outcome.via).toBe("fallback");
    }
  });

  test("abstain escalates to the onUncertain judge", async () => {
    const judge = createClassifier({
      id: "judge",
      model: mockModel(result({ decision: "execute", confidence: 0.97 })),
    });
    const classifier = createClassifier({
      model: mockModel(result({ decision: "abstain" })),
      onUncertain: judge,
    });
    const outcome = await classifier.classify(input());
    expect(outcome.ok).toBe(true);
    if (outcome.ok) {
      expect(outcome.execution).toBe("execute");
      expect(outcome.escalated).toBe(true);
      expect(outcome.evaluatorId).toBe("judge");
    }
  });

  test("invalid model output fails closed through the fallback", async () => {
    const classifier = createClassifier({
      model: mockModel({
        decision: "execute",
        scores: { relevance: 2, necessity: 0.9, urgency: 0.9 },
        confidence: 0.9,
      } as unknown as ClassificationResult),
    });
    const outcome = await classifier.classify(input());
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.execution).toBe("skip");
      expect(outcome.error).toContain("between 0 and 1");
    }
  });

  test("a throwing predict fails closed with the error", async () => {
    const classifier = createClassifier({
      model: {},
      predict: () => {
        throw new Error("model unavailable");
      },
    });
    const outcome = await classifier.classify(input());
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.error).toContain("model unavailable");
  });

  test("a slow model times out and applies the fallback", async () => {
    const classifier = createClassifier({
      model: {},
      predict: () => new Promise(() => {}) as never,
      timeoutMs: 20,
    });
    const outcome = await classifier.classify(input());
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.error).toContain("timed out");
  });

  test("a zod-style schema validates output and decide maps it to the contract", async () => {
    const schema = z.object({
      shouldRun: z.boolean(),
      relevance: z.number().min(0).max(1),
      confidence: z.number().min(0).max(1),
    });
    const classifier = createClassifier({
      model: { run: () => ({ shouldRun: true, relevance: 0.92, confidence: 0.94 }) },
      predict: (model: { run: () => unknown }) => model.run(),
      schema,
      decide: (output) => ({
        decision: output.shouldRun ? "execute" : "skip",
        scores: { relevance: output.relevance, necessity: output.relevance, urgency: 0.5 },
        confidence: output.confidence,
      }),
    });
    const outcome = await classifier.classify(input());
    expect(outcome.ok).toBe(true);
    if (outcome.ok) expect(outcome.execution).toBe("execute");
  });

  test("a function-form schema plus domain-specific decide signals", async () => {
    // The coding-agent case: signals latch itself knows nothing about.
    const parse = (data: unknown) => {
      const record = data as Record<string, unknown>;
      if (typeof record["risk"] !== "number") throw new Error("risk must be a number");
      return record as {
        risk: number;
        reversibility: number;
        requiresHuman: boolean;
        confidence: number;
      };
    };
    const classifier = createClassifier({
      model: {
        assess: () => ({ risk: 0.1, reversibility: 0.9, requiresHuman: false, confidence: 0.93 }),
      },
      predict: (model: { assess: () => unknown }) => model.assess(),
      schema: parse,
      decide: (output) => {
        if (output.requiresHuman) {
          return {
            decision: "abstain",
            scores: { relevance: 0.9, necessity: 0.5, urgency: 0.5 },
            confidence: output.confidence,
          };
        }
        const execute = output.risk < 0.2 && output.reversibility > 0.8;
        return {
          decision: execute ? "execute" : "skip",
          scores: { relevance: 0.9, necessity: 0.8, urgency: 0.4 },
          confidence: output.confidence,
        };
      },
    });
    const outcome = await classifier.classify(input());
    expect(outcome.ok).toBe(true);
    if (outcome.ok) expect(outcome.execution).toBe("execute");
  });

  test("output that fails the schema fails closed with the schema's reason", async () => {
    const classifier = createClassifier({
      model: { run: () => ({ confidence: "very high" }) },
      predict: (model: { run: () => unknown }) => model.run(),
      schema: z.object({ confidence: z.number() }),
      decide: (output) => ({
        decision: "execute",
        scores: { relevance: 0.9, necessity: 0.9, urgency: 0.9 },
        confidence: output.confidence,
      }),
    });
    const outcome = await classifier.classify(input());
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.error).toContain("did not match the schema");
  });

  test("a decide mapper's output still passes canonical validation", async () => {
    const classifier = createClassifier({
      model: { run: () => ({}) },
      predict: (model: { run: () => unknown }) => model.run(),
      schema: z.object({}).passthrough(),
      decide: () =>
        ({ decision: "maybe" }) as unknown as ReturnType<
          NonNullable<CreateClassifierOptions["decide"]>
        >,
    });
    const outcome = await classifier.classify(input());
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.error).toContain('"execute", "skip", or "abstain"');
  });

  test("a throwing decide mapper fails closed with context", async () => {
    const classifier = createClassifier({
      model: { run: () => ({ ok: true }) },
      predict: (model: { run: () => unknown }) => model.run(),
      schema: z.object({ ok: z.boolean() }),
      decide: () => {
        throw new Error("boom");
      },
    });
    const outcome = await classifier.classify(input());
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.error).toContain("the decide mapper threw: boom");
  });

  test("redact minimizes what the model sees", async () => {
    let seen: ClassificationInput | undefined;
    const classifier = createClassifier({
      model: mockModel((i) => {
        seen = i;
        return result();
      }),
      redact: (i) => ({
        ...i,
        context: { currentMessage: i.context.currentMessage },
        action: { ...i.action, arguments: { path: i.action.arguments["path"] } },
      }),
    });
    await classifier.classify({
      ...input(),
      context: { currentMessage: "hi", conversation: [{ secret: "do not send" }] },
    });
    expect(seen?.context.conversation).toBeUndefined();
    expect(seen?.context.currentMessage).toBe("hi");
  });

  test("a model without predict and without a predict option is rejected eagerly", () => {
    expect(() => createClassifier({ model: {} })).toThrow(/no predict method/);
    expect(() => createClassifier({ model: null as never })).toThrow();
  });

  test("out-of-range thresholds are rejected eagerly", () => {
    expect(() =>
      createClassifier({ model: mockModel(result()), thresholds: { execute: 1.4 } }),
    ).toThrow(/between 0 and 1/);
  });
});

describe("validateClassificationResult", () => {
  test("accepts a well-formed result and coerces nothing", () => {
    const validated = validateClassificationResult(result());
    expect(validated.ok).toBe(true);
  });

  test("rejects each kind of malformed output", () => {
    for (const bad of [
      null,
      42,
      "execute",
      {
        decision: "maybe",
        scores: { relevance: 0.5, necessity: 0.5, urgency: 0.5 },
        confidence: 0.5,
      },
      { decision: "execute", scores: { relevance: 0.5, necessity: 0.5 }, confidence: 0.5 },
      {
        decision: "execute",
        scores: { relevance: 0.5, necessity: 0.5, urgency: 0.5 },
        confidence: 1.5,
      },
      {
        decision: "execute",
        scores: { relevance: 0.5, necessity: 0.5, urgency: 0.5 },
        confidence: Number.NaN,
      },
      {
        decision: "execute",
        scores: { relevance: 0.5, necessity: 0.5, urgency: 0.5 },
        confidence: 0.5,
        reason: 7,
      },
    ]) {
      const validated = validateClassificationResult(bad);
      expect(validated.ok).toBe(false);
    }
  });
});

describe("classifier interchangeability", () => {
  test("two different adapters produce the same interface", async () => {
    const a: LatchClassifier = createClassifier({
      id: "mlp",
      model: mockModel(result({ confidence: 0.99 })),
    });
    const b: LatchClassifier = createClassifier({
      id: "rules",
      model: mockModel(result({ confidence: 0.99 })),
    });
    for (const classifier of [a, b]) {
      const outcome = await classifier.classify(input());
      expect(outcome.ok).toBe(true);
      if (outcome.ok) expect(outcome.execution).toBe("execute");
    }
  });
});

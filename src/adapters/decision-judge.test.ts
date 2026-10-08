import { afterEach, describe, expect, test } from "bun:test";
import { createDecisionClassifier } from "./decision-judge.js";
import type { ClassificationInput } from "../classifier.js";

const input: ClassificationInput = {
  agent: { id: "ashley" },
  task: { objective: "Organize the user's projects" },
  action: { tool: "filesystem.read", arguments: { path: "/projects" } },
  context: { currentMessage: "Can you help me organize my unfinished projects?" },
};

const originalFetch = globalThis.fetch;
const originalKey = process.env["AI_GATEWAY_API_KEY"];
afterEach(() => {
  globalThis.fetch = originalFetch;
  if (originalKey === undefined) delete process.env["AI_GATEWAY_API_KEY"];
  else process.env["AI_GATEWAY_API_KEY"] = originalKey;
});

function evaluationResponse(overrides: {
  decision?: string;
  relevance?: number;
  necessity?: number;
  urgency?: number;
  confidence?: number;
}) {
  return JSON.stringify({
    model: "typesafe-ai/jev",
    answers: {
      decision: { type: "choice", choice: overrides.decision ?? "execute", probabilities: {} },
      relevance: { type: "boolean", probability: overrides.relevance ?? 0.95 },
      necessity: { type: "boolean", probability: overrides.necessity ?? 0.9 },
      urgency: { type: "boolean", probability: overrides.urgency ?? 0.6 },
      confidence: { type: "boolean", probability: overrides.confidence ?? 0.97 },
    },
    usage: { inputTokens: 300, outputTokens: 12 },
    providerMetadata: { gateway: { cost: "0.0000126" } },
  });
}

function mockFetch(
  handler: (request: { url: string; body: Record<string, unknown> }) => {
    status: number;
    body: string;
  },
) {
  const calls: Array<{ url: string; body: Record<string, unknown> }> = [];
  globalThis.fetch = (async (
    url: Parameters<typeof fetch>[0],
    init?: Parameters<typeof fetch>[1],
  ) => {
    const request = {
      url: String(url),
      body: JSON.parse(String(init?.body)) as Record<string, unknown>,
    };
    calls.push(request);
    const response = handler(request);
    return new Response(response.body, { status: response.status });
  }) as typeof fetch;
  return calls;
}

describe("createDecisionClassifier", () => {
  test("posts state and typed questions to /v1/evaluate and maps the answers", async () => {
    const calls = mockFetch(() => ({ status: 200, body: evaluationResponse({}) }));
    const judge = createDecisionClassifier({ model: "typesafe-ai/jev", apiKey: "vck_test" });

    const outcome = await judge.classify(input);

    expect(calls.length).toBe(1);
    expect(calls[0]!.url).toBe("https://ai-gateway.vercel.sh/v1/evaluate");
    expect(calls[0]!.body["model"]).toBe("typesafe-ai/jev");
    expect(calls[0]!.body["state"]).toEqual(input);
    const questions = calls[0]!.body["questions"] as Record<string, { type: string }>;
    expect(questions["decision"]!.type).toBe("choice");
    expect(questions["relevance"]!.type).toBe("boolean");

    expect(outcome.ok).toBe(true);
    if (outcome.ok) {
      expect(outcome.execution).toBe("execute");
      expect(outcome.result.decision).toBe("execute");
      expect(outcome.result.scores.relevance).toBe(0.95);
      expect(outcome.result.confidence).toBe(0.97);
      expect(outcome.result.metadata?.["usage"]).toEqual({ inputTokens: 300, outputTokens: 12 });
      expect(outcome.evaluatorId).toBe("decision-judge");
    }
  });

  test("a skip choice with high probability skips", async () => {
    mockFetch(() => ({
      status: 200,
      body: evaluationResponse({
        decision: "skip",
        relevance: 0.05,
        necessity: 0.05,
        confidence: 0.93,
      }),
    }));
    const judge = createDecisionClassifier({ model: "typesafe-ai/jev", apiKey: "k" });
    const outcome = await judge.classify(input);
    expect(outcome.ok).toBe(true);
    if (outcome.ok) expect(outcome.execution).toBe("skip");
  });

  test("an off-contract choice fails closed through validation", async () => {
    mockFetch(() => ({ status: 200, body: evaluationResponse({ decision: "maybe" }) }));
    const judge = createDecisionClassifier({ model: "typesafe-ai/jev", apiKey: "k" });
    const outcome = await judge.classify(input);
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.error).toContain('"execute", "skip", or "abstain"');
  });

  test("missing answers fail closed", async () => {
    mockFetch(() => ({ status: 200, body: JSON.stringify({ model: "m", answers: {} }) }));
    const judge = createDecisionClassifier({ model: "typesafe-ai/jev", apiKey: "k" });
    const outcome = await judge.classify(input);
    expect(outcome.ok).toBe(false);
  });

  test("restricted-model errors surface with guidance", async () => {
    mockFetch(() => ({
      status: 403,
      body: JSON.stringify({
        error: {
          message: "Free tier users do not have access to this model.",
          type: "no_providers_available",
        },
      }),
    }));
    const judge = createDecisionClassifier({ model: "typesafe-ai/jev", apiKey: "k" });
    const outcome = await judge.classify(input);
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.error).toContain("HTTP 403");
  });

  test("instruction overrides change what is asked", async () => {
    const calls = mockFetch(() => ({ status: 200, body: evaluationResponse({}) }));
    const judge = createDecisionClassifier({
      model: "typesafe-ai/jev",
      apiKey: "k",
      instructions: { relevance: "Is this about billing?" },
    });
    await judge.classify(input);
    const questions = calls[0]!.body["questions"] as Record<string, { instructions: string }>;
    expect(questions["relevance"]!.instructions).toBe("Is this about billing?");
    expect(questions["necessity"]!.instructions).toContain("task fail");
  });

  test("requires a model id and an API key", async () => {
    expect(() => createDecisionClassifier({ model: "" })).toThrow(/decision model id/);
    delete process.env["AI_GATEWAY_API_KEY"];
    delete process.env["VERCEL_AI_GATEWAY_API_KEY"];
    const judge = createDecisionClassifier({ model: "typesafe-ai/jev" });
    const outcome = await judge.classify(input);
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.error).toContain("no API key");
  });
});

// Live smoke against the real gateway. Opt-in via env so the suite stays
// hermetic. Defaults to convaiinnovations/laya — the one decision model that
// serves free-tier traffic — for testing; point LATCH_LIVE_DECISION_MODEL at
// typesafe-ai/jev (the production default) once the account has paid credits.
// Skips itself when the account cannot serve the requested model.
describe("createDecisionClassifier (live, opt-in)", () => {
  test.skipIf(process.env["LATCH_LIVE_GATEWAY"] !== "1" || !process.env["AI_GATEWAY_API_KEY"])(
    "round-trips a classification through a decision model",
    async () => {
      const judge = createDecisionClassifier({
        model: process.env["LATCH_LIVE_DECISION_MODEL"] ?? "convaiinnovations/laya",
        timeoutMs: 45_000,
      });
      const outcome = await judge.classify({
        ...input,
        task: { objective: "Respond to the user's greeting" },
        context: { currentMessage: "Good morning, Ashley." },
      });
      if (!outcome.ok && /free tier|no_providers|HTTP 403/i.test(outcome.error)) {
        return; // restricted model on a free-tier account: nothing to assert against
      }
      // Smoke scope: request, mapping, and validation all work end to end. The
      // judgment quality itself is threshold-dependent and covered by mocks.
      expect(outcome.ok).toBe(true);
      if (outcome.ok) {
        expect(outcome.evaluatorId).toBe("decision-judge");
        expect(outcome.result.metadata?.["model"]).toBeDefined();
      }
    },
  );
});

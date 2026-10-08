import { afterEach, describe, expect, test } from "bun:test";
import { createLLMJudge } from "./llm-judge.js";
import type { ClassificationInput } from "../classifier.js";

const input: ClassificationInput = {
  agent: { id: "ashley" },
  task: { objective: "Organize the user's projects" },
  action: { tool: "filesystem.read", arguments: { path: "/projects" } },
  context: { currentMessage: "Can you help me organize my unfinished projects?" },
};

function completion(content: string, usage?: Record<string, unknown>) {
  return JSON.stringify({
    choices: [{ message: { role: "assistant", content } }],
    ...(usage !== undefined ? { usage } : {}),
  });
}

const JUDGMENT = JSON.stringify({
  decision: "execute",
  scores: { relevance: 0.95, necessity: 0.9, urgency: 0.6 },
  confidence: 0.97,
  reason: "Reading the project directory directly serves the task.",
});

const originalFetch = globalThis.fetch;
const originalKey = process.env["AI_GATEWAY_API_KEY"];
afterEach(() => {
  globalThis.fetch = originalFetch;
  if (originalKey === undefined) delete process.env["AI_GATEWAY_API_KEY"];
  else process.env["AI_GATEWAY_API_KEY"] = originalKey;
});

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

describe("createLLMJudge", () => {
  test("sends an OpenAI-compatible chat completion and returns the judgment", async () => {
    const calls = mockFetch(() => ({
      status: 200,
      body: completion(JUDGMENT, { prompt_tokens: 120, completion_tokens: 40 }),
    }));
    const judge = createLLMJudge({ model: "google/gemini-2.5-flash-lite", apiKey: "vck_test" });

    const outcome = await judge.classify(input);

    expect(calls.length).toBe(1);
    expect(calls[0]!.url).toBe("https://ai-gateway.vercel.sh/v1/chat/completions");
    expect(calls[0]!.body["model"]).toBe("google/gemini-2.5-flash-lite");
    expect((calls[0]!.body["messages"] as unknown[]).length).toBe(2);
    expect(calls[0]!.body["response_format"]).toEqual({ type: "json_object" });

    expect(outcome.ok).toBe(true);
    if (outcome.ok) {
      expect(outcome.execution).toBe("execute");
      expect(outcome.result.confidence).toBe(0.97);
      expect(outcome.result.metadata?.["usage"]).toBeDefined();
      expect(outcome.evaluatorId).toBe("llm-judge");
    }
  });

  test("honors baseURL overrides for any compatible endpoint", async () => {
    const calls = mockFetch(() => ({ status: 200, body: completion(JUDGMENT) }));
    const judge = createLLMJudge({
      model: "gpt-4o-mini",
      baseURL: "https://api.openai.com/v1/",
      apiKey: "sk-test",
    });
    await judge.classify(input);
    expect(calls[0]!.url).toBe("https://api.openai.com/v1/chat/completions");
  });

  test("reads the API key from AI_GATEWAY_API_KEY when not passed", async () => {
    process.env["AI_GATEWAY_API_KEY"] = "vck_env";
    const calls = mockFetch(() => ({ status: 200, body: completion(JUDGMENT) }));
    const judge = createLLMJudge({ model: "m" });
    const outcome = await judge.classify(input);
    expect(outcome.ok).toBe(true);
    expect(calls.length).toBe(1);
  });

  test("a missing API key fails closed with guidance", async () => {
    delete process.env["AI_GATEWAY_API_KEY"];
    delete process.env["VERCEL_AI_GATEWAY_API_KEY"];
    delete process.env["OPENAI_API_KEY"];
    const judge = createLLMJudge({ model: "m" });
    const outcome = await judge.classify(input);
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.error).toContain("no API key");
  });

  test("parses judgments wrapped in code fences", async () => {
    mockFetch(() => ({ status: 200, body: completion("```json\n" + JUDGMENT + "\n```") }));
    const judge = createLLMJudge({ model: "m", apiKey: "k" });
    const outcome = await judge.classify(input);
    expect(outcome.ok).toBe(true);
  });

  test("non-JSON model output fails closed", async () => {
    mockFetch(() => ({ status: 200, body: completion("I cannot answer that as JSON, sorry!") }));
    const judge = createLLMJudge({ model: "m", apiKey: "k" });
    const outcome = await judge.classify(input);
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.error).toContain("parseable JSON");
  });

  test("an HTTP error fails closed with status and body excerpt", async () => {
    mockFetch(() => ({
      status: 401,
      body: JSON.stringify({ error: { message: "invalid key" } }),
    }));
    const judge = createLLMJudge({ model: "m", apiKey: "bad" });
    const outcome = await judge.classify(input);
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.error).toContain("HTTP 401");
  });

  test("retries once without response_format when the endpoint rejects it", async () => {
    const calls = mockFetch(({ body }) => {
      if (body["response_format"] !== undefined) {
        return {
          status: 400,
          body: JSON.stringify({ error: { message: "response_format not supported" } }),
        };
      }
      return { status: 200, body: completion(JUDGMENT) };
    });
    const judge = createLLMJudge({ model: "m", apiKey: "k" });
    const outcome = await judge.classify(input);
    expect(calls.length).toBe(2);
    expect(outcome.ok).toBe(true);
  });

  test("a skip judgment with high confidence skips", async () => {
    mockFetch(() => ({
      status: 200,
      body: completion(
        JSON.stringify({
          decision: "skip",
          scores: { relevance: 0.2, necessity: 0.1, urgency: 0.1 },
          confidence: 0.93,
          reason: "Reading files is unrelated to answering a greeting.",
        }),
      ),
    }));
    const judge = createLLMJudge({ model: "m", apiKey: "k" });
    const outcome = await judge.classify(input);
    expect(outcome.ok).toBe(true);
    if (outcome.ok) expect(outcome.execution).toBe("skip");
  });

  test("requires a model id", () => {
    expect(() => createLLMJudge({ model: "" })).toThrow(/model id/);
  });
});

// Live smoke against the real Vercel AI Gateway. Opt-in via env so the suite
// stays hermetic: LATCH_LIVE_GATEWAY=1 with AI_GATEWAY_API_KEY set. The model
// is overridable (default: a chat model that works on free-tier credits).
describe("createLLMJudge (live, opt-in)", () => {
  test.skipIf(process.env["LATCH_LIVE_GATEWAY"] !== "1" || !process.env["AI_GATEWAY_API_KEY"])(
    "judges a greeting-when-files-read scenario through the gateway",
    async () => {
      const judge = createLLMJudge({
        model: process.env["LATCH_LIVE_MODEL"] ?? "google/gemini-2.5-flash-lite",
        timeoutMs: 30_000,
      });
      const outcome = await judge.classify({
        ...input,
        task: { objective: "Respond to the user's greeting" },
        context: { currentMessage: "Good morning, Ashley." },
      });
      expect(outcome.ok).toBe(true);
      if (outcome.ok) {
        // A judge may honestly abstain on thin context; what must never happen
        // is "execute" for a file read that has nothing to do with a greeting.
        expect(outcome.result.decision).not.toBe("execute");
      }
    },
  );
});

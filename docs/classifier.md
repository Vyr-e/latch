---
title: Contextual gating (classifiers)
---

Deterministic rules answer **"may this agent do this?"** A classifier answers the question rules
can't: **"should this happen now?"** An agent allowed to create GitHub issues shouldn't create one
when the user just says *good morning*. latch keeps the two questions separate: authorization is
always deterministic, and the classifier only ever restricts execution — never widens permission.

> **Deterministic policies establish authority. Probabilistic classifiers evaluate context. latch
> combines both to make controlled execution decisions.**

The classifier is interchangeable by design: a mock in tests, a small MLP, an ONNX model, or an
LLM judge — latch depends on no model provider.

## The contract

Every classifier sees a `ClassificationInput` and returns a `ClassificationResult`:

```ts
interface ClassificationInput {
  agent: { id: string; name?: string };
  task: {
    id?: string;
    objective: string;          // what the agent is working on
    description?: string;
    urgency?: "low" | "medium" | "high" | "critical";  // a claim, not a fact
  };
  action: { tool: string; arguments: Record<string, unknown> };  // the proposed call
  context: {
    currentMessage?: string;
    conversation?: unknown[];
    taskState?: Record<string, unknown>;
  };
  history?: ClassificationHistoryEntry[];  // opt-in via feedHistory
}

interface ClassificationResult {
  decision: "execute" | "skip" | "abstain";
  scores: {
    relevance: number;   // serves the objective at all?
    necessity: number;   // task fails or degrades without it?
    urgency: number;     // costly to delay?
  };
  confidence: number;    // certainty in the judgment — not execution probability
  reason?: string;
  metadata?: Record<string, unknown>;
}
```

Relevance, necessity, and urgency are separate because they vary independently: a call can be
relevant without being necessary, urgent without being permitted. Confidence is the classifier's
self-assessed certainty, not a calibrated probability.

## Custom model output: schema + decide

The canonical contract is the default, not a requirement. A classifier has three layers:

```text
                your model
                     │
              output schema          (what the model returns)
                     │
           validate / parse
                     │
              decide mapper         (how that output becomes a judgment)
                     │
        canonical ClassificationResult
                     │
          execute / skip / review
```

`schema` says what the model's output looks like; `decide` maps the validated output to the
canonical result. The schema is duck-typed — anything zod-like with `safeParse`, or a plain
function that parses or throws — so latch ships no validation dependency:

```ts
import { z } from "zod"; // yours, not latch's

const classifier = createClassifier({
  model,

  schema: z.object({
    risk: z.number().min(0).max(1),
    reversibility: z.number().min(0).max(1),
    requiresHuman: z.boolean(),
    confidence: z.number().min(0).max(1),
  }),

  decide: (output) => ({
    decision:
      output.requiresHuman ? "abstain"
      : output.risk < 0.2 && output.reversibility > 0.8 ? "execute"
      : "skip",
    scores: { relevance: 1 - output.risk, necessity: output.reversibility, urgency: 0.5 },
    confidence: output.confidence,
  }),
});
```

Domain-specific signals (`risk`, `reversibility`, …) never need to mean anything to latch — only
the mapped decision does. Output that fails the schema is a classifier failure and resolves
through the fallback; and whatever `decide` returns is still validated against the canonical
contract, so a buggy mapper fails closed instead of poisoning the policy engine. Adapters use the
same seam: `createDecisionClassifier`'s `decide` option lets you recombine its five validated
signals, and `createLLMJudge`'s output is the canonical JSON validated on return.

## Attaching a classifier

```ts
import { createGate, createClassifier } from "@vyr-e/latch";

const classifier = createClassifier({
  model: myModel,                        // anything with a predict method
  thresholds: { execute: 0.85, review: 0.55 },
  fallback: "skip",
});

const gate = createGate({
  policy: "latch.yaml",
  classifier,
  situation: (input) => ({               // what the call is for
    agent: { id: "ashley" },
    task: { objective: currentObjective },
    context: { currentMessage: lastUserMessage },
  }),
});

const evaluation = await gate.evaluate({
  agent: { id: "ashley" },
  task: { objective: "Respond to the user's greeting" },
  action: { tool: "filesystem.read", arguments: { path: "/projects" } },
  context: { currentMessage: "Good morning, Ashley." },
});
// { authorization: "allow", execution: "skip", source: "hybrid", … }
```

The tool is permitted — latch just recommends skipping it. With a classifier bound, `wrap` enforces
that recommendation: calls judged inappropriate throw `LatchSkippedError` (skip) or
`LatchReviewRequiredError` (uncertain) before the tool runs. Pass `enforce: false` to classify for
observability only, via `gate.evaluate`.

`gate.evaluate` never executes anything. Its result separates the two halves of every decision:

| Field           | Values                                       | Meaning                        |
| --------------- | -------------------------------------------- | ------------------------------ |
| `authorization` | `allow` \| `deny` \| `requires_approval`     | May this agent do this?        |
| `execution`     | `execute` \| `skip` \| `review`              | Should it happen now?          |
| `source`        | `deterministic` \| `classifier` \| `hybrid`  | Which layer decided            |
| `classification`| `ClassificationResult`                       | The model's validated output   |

## Modes

Set `mode` in the policy (a `classifier:` block implies `hybrid`):

- **`deterministic`** (default) — allowed means execute; no classifier is ever invoked. Exactly
  latch's behavior before this feature existed.
- **`hybrid`** — rules authorize, the classifier judges execution on top. Deny rules, constraints,
  and approvals all still apply first.
- **`classifier`** — the allow list is a coarse capability scope and the classifier decides
  execution within it. The parser rejects this mode without an explicit, non-empty allow list and
  `default: deny`: a classifier decides execution, never capability.

## Thresholds and fallbacks

```yaml
classifier:
  provider: judge
  thresholds:
    execute: 0.85   # confidence at or above this may execute (default 0.85)
    review: 0.55    # between review and execute: human review (default 0.55)
    necessity: 0.75 # optional per-dimension floors (also relevance, urgency)
  fallback: skip    # skip | review | deny — what failure resolves to
  timeout_ms: 5000
```

Resolution is an explicit conjunction, not a probability. A call executes only when **every**
condition holds:

```text
decision      == "execute"
AND authorization == allow
AND confidence >= execute threshold
AND relevance >= relevance floor   (when set)
AND necessity >= necessity floor   (when set)
AND urgency    >= urgency floor    (when set)
```

Any single failure routes to review; below the `review` band, the configured fallback applies.
Confidence measures certainty of judgment — it is never "the probability that this action should
execute", which is exactly why the conjunction exists: `{ decision: "execute", necessity: 0.4,
confidence: 0.98 }` must not run just because the model felt sure.

1. An explicit **`skip`** is never upgraded by confidence.
2. An **`abstain`** escalates to `onUncertain` (below), else falls back.
3. **`execute`** that fails a dimension floor routes to review.
4. **`execute`** with confidence ≥ `execute` executes; between `review` and `execute` routes to
   review; below `review` applies the fallback.
5. **Failure** — thrown errors, timeouts, schema violations, malformed output, out-of-range
   scores — applies the fallback. `fallback: deny` denies an otherwise-authorized call (safe
   direction only). A classifier failure is never permission to execute.

## Invoking conditionally

Classification costs latency and money; you don't need it on every call.

```yaml
classifier:
  provider: judge
  invoke: conditional
  conditions:
    on_unmatched: true   # classify when a wildcard or the default authorized the call,
                         # not an exact rule — the contextual gap
    on_urgency: true     # classify when the (untrusted) urgency tag is present
```

- `invoke: always` (default) — every authorized call.
- `invoke: conditional` — only when a condition matches. An exact allow rule speaking to the
  action counts as "matched"; `stripe.*`, `*`, and `default: allow` fallbacks are "unmatched".
- `invoke: manual` — only when the caller passes `{ classify: true }` to `evaluate`.

## LLM judges and decision models

Two built-in adapters cover the common hosted cases; both use `fetch` only.

**`createLLMJudge`** turns any OpenAI-compatible chat-completions endpoint into a classifier —
including the Vercel AI Gateway:

```ts
import { createLLMJudge } from "@vyr-e/latch";

const judge = createLLMJudge({
  model: "google/gemini-2.5-flash-lite",   // any chat model your endpoint serves
  apiKey: process.env.AI_GATEWAY_API_KEY,  // or OPENAI_API_KEY; env is read by default
  // baseURL: "https://api.openai.com/v1",  // any compatible endpoint
});
```

**`createDecisionClassifier`** uses a decision model (the Vercel AI Gateway's `/v1/evaluate`
modality): typed questions answered with calibrated probabilities, no prompt engineering, no
prose to parse. One round trip asks the decision plus the four scores latch's contract needs.
The production default is `typesafe-ai/jev`:

```ts
import { createDecisionClassifier } from "@vyr-e/latch";

const judge = createDecisionClassifier({
  model: "typesafe-ai/jev",
  apiKey: process.env.AI_GATEWAY_API_KEY,
  instructions: { relevance: "Is this call about the active incident?" },  // optional overrides
});
```

**Decision model landscape** (all speak the same `/v1/evaluate` contract; verified on the
gateway, October 2026):

| Model | Input $/1M tok | Context | Notes |
| --- | --- | --- | --- |
| `typesafe-ai/jev` | $0.042 | 32k | TypeSafe's System One; the default choice |
| `convaiinnovations/laya` / `laya-free` | free | 8k | Open weights (Apache-2.0, ModernBERT-large), ~33 ms/decision; ideal for testing and high-volume gating |
| `openai/gpt-6-luna-decisions` | $0.10 | 1M | Multimodal (text + image), up to 200 questions per request, configurable reasoning effort |
| `liquid/d1` | $0.04 | 64k | Liquid AI's decision model |

On gateway free-tier credits only the Laya variants serve traffic — jev, luna, and d1 require
paid credits — so `convaiinnovations/laya` is what latch's opt-in live tests default to
(`LATCH_LIVE_DECISION_MODEL=typesafe-ai/jev` once you've topped up).

Whatever the model, its probabilities are still untrusted input: they pass runtime validation
and your thresholds. In live testing Laya answered "execute" for an irrelevant call with 0.75
confidence — below a 0.85 execute threshold, latch routed it to review. The threshold layer is
the safety net, not the model.

A small model can handle easy calls and escalate hard ones:

```ts
const classifier = createClassifier({
  model: smallModel,
  onUncertain: createDecisionClassifier({ model: "typesafe-ai/jev" }),
});
```

Use `redact` to minimize what leaves the process:

```ts
const classifier = createClassifier({
  model: hostedModel,
  redact: (input) => ({
    ...input,
    action: { ...input.action, arguments: {} },  // send the tool name, not the arguments
    context: { currentMessage: input.context.currentMessage },
  }),
});
```

## History

```yaml
history:
  enabled: true
  max_entries: 1000
```

With history enabled, the gate records every classification: the model's recommendation, the
scores, the evaluator id/version, and the final policy outcome — with `executed` flipped once the
tool actually runs. The default store is in-memory and bounded; bring your own:

```ts
import { createMemoryHistory, type HistoryStore } from "@vyr-e/latch";

const store: HistoryStore = {
  async record(entry) { await db.insert(entry); },
  recent: (n) => cache.slice(-n),
  async markExecuted(id) { await db.update(id, { executed: true }); },
};

const gate = createGate({ policy: "latch.yaml", classifier, history: store });
```

History distinguishes **prediction** (what the model said), **execution outcome** (the policy
decision), and **what actually ran** — the raw material for evaluating classifiers later. Feeding
history back into future classifications is opt-in (`feedHistory: n`) because it can reinforce
earlier mistakes; recording never blocks or alters a decision.

## YAML + TypeScript parity

YAML references a registered implementation by name; the binding happens at runtime:

```yaml
agent: support-agent
mode: hybrid
allow:
  github.issues.create: true
classifier:
  provider: judge
  thresholds: { execute: 0.9 }
history:
  enabled: true
```

```ts
const gate = createGate({
  policy: "latch.yaml",
  classifiers: { judge: myJudge },   // resolves provider: judge
});
```

A policy that references an unregistered provider fails at gate creation with the fix in the
message. A YAML policy and an equivalent TypeScript policy produce identical decisions — the
policy is pure data either way.

## Security model

1. Explicitly denied capabilities cannot be enabled through classification.
2. Classifier-only configurations must have bounded capability scopes (enforced at parse time).
3. Mandatory approvals cannot be bypassed — and a classifier `skip` can save the human a prompt.
4. Classifier errors, timeouts, and invalid output fail closed through the fallback.
5. Unrecognized tools follow the authorization fallback: denial is the safe default.
6. Model output is validated at runtime; scores outside `[0, 1]` are failures.
7. Deterministic constraints (`max_amount`, `paths`) are checked before any model runs.
8. Agent-controlled urgency is context to weigh, never authority.
9. `redact` controls exactly what a model sees; conversation text is never policy.

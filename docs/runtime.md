---
title: Runtime
---

The runtime is dependency-light (`yaml` is the only runtime dependency) and framework-agnostic.

## Loading a policy

```ts
import { loadPolicy, parsePolicy } from "@vyr-e/latch";

const { policy, file } = loadPolicy();                 // walks up from cwd: latch.yaml, latch.yml, .latch.yaml
const explicit = loadPolicy("config/latch.yaml");      // explicit path
const inline = parsePolicy(source, { file: "latch.yaml" }); // from a string
```

`LatchParseError` carries every issue with `file`, `line`, `col`, `path`, and a message that says
what to do.

## Checking a call

```ts
import { check } from "@vyr-e/latch";

const decision = check(policy, "stripe.refunds.create", { amount: 80 });
// { effect: "deny", action, matched: { section: "deny" | "allow", pattern, constraints }, reason }
// effect: "allow" | "deny" | "approval"
```

`check` is pure — no I/O, no side effects. Everything else in latch calls it.

## The gate

```ts
import { createGate } from "@vyr-e/latch";

const gate = createGate({
  policy: "latch.yaml",            // or a parsed policy object
  onApproval: async ({ action, input, decision }) => {
    // Return true to proceed. Default: throw, so durable runtimes can pause.
    return slackApprove(action, input);
  },
});

gate.check(action, input)   // → decision, never throws
gate.assert(action, input)  // → decision, or throws LatchDeniedError / LatchApprovalRequiredError
gate.wrap(action, tool)     // → the same tool with a guarded execute
```

`wrap` keeps every tool property except `execute`, so the result drops into `defineTool`-style
registries unchanged:

```ts
gate.wrap("stripe.refunds.create", {
  description: "Refund a charge.",
  inputSchema: z.object({ chargeId: z.string(), amount: z.number() }),
  async execute(input) { return stripe.refunds.create(input); },
});
```

Behavior inside `wrap`:

- **deny** → `execute` is never called; throws `LatchDeniedError` (`action`, `reason`).
- **approval** → `onApproval` is consulted; a falsy answer throws
  `LatchApprovalRequiredError`. Without `onApproval`, it throws immediately — the
  pause-and-resume contract belongs to the runtime.
- **allow** → `execute` runs with its original arguments.

### Typed action names

`createGate` writes `latch-env.d.ts` beside `latch.yaml` and rewrites it when the policy changes.
With that file in your tsconfig's `include`, action names autocomplete and unknown names fail to
compile:

```ts
gate.wrap("stripe.refund.create", tool); // error: not in latch.yaml
```

A wildcard like `stripe.*` accepts any name under it. `latch init` creates the file too, and
`latch types --check` fails CI when it's stale. Pass `types: false` to stop the gate writing it
(it's already skipped when `NODE_ENV=production`).

## Policies written in TypeScript

```ts
import { definePolicy } from "@vyr-e/latch";

export const policy = definePolicy({
  agent: "support-agent",
  allow: [
    { action: "stripe.customers.read" },
    { action: "stripe.refunds.create", maxAmount: 50, approval: "required" },
  ],
  deny: [{ action: "github.repositories.delete" }],
});
```

Same engine, same semantics — useful when a policy wants to live next to typed constants.

## eve adapter

latch's decisions map one-to-one onto eve's request-time approval statuses:

```ts
import { defineTool } from "eve/tools";
import { createGate, toEveApprovalPolicy } from "@vyr-e/latch";

const gate = createGate({ policy: "latch.yaml" });

export default defineTool({
  description: "Refund a charge.",
  approval: toEveApprovalPolicy(gate),  // approved / denied / user-approval
  async execute(input) { /* … */ },
});
```

With this, the YAML file is the approval policy for any number of eve tools — in code, nothing
dupes.

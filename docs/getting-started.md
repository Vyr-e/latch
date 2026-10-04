---
title: Getting started
---

Declare what your agent may do in one `latch.yaml`, then let every runtime that reads it enforce the
same rules.

## 1. Declare a policy

```sh
bunx latch init
```

creates a starter `latch.yaml`:

```yaml
agent: my-agent

allow:
  # Unlisted actions are denied by default.
  web.search: true
  stripe.customers.read: true

  # Constraints tighten an action; every listed constraint must hold.
  stripe.refunds.create:
    max_amount: 50
    approval: required

deny:
  github.repositories.delete: true
  filesystem:
    paths:
      - ~/.ssh
      - ~/.aws
```

Actions are dotted names matching your tools: `provider.resource.verb`. Rules may also be nested as
maps — `stripe: { customers: { read: true } }` means the same thing as the flat form.

## 2. Validate

```sh
bunx latch validate
```

Every problem is reported with its line and column, all at once, so a file can be fixed in one pass:

```text
latch.yaml:4:5 — "max_amount" must be a non-negative number (got "fifty")
latch.yaml:5:5 — "approval" must be "required" or "never" (got "sometimes")
```

## 3. Enforce at runtime

Wrap the tools the agent can call:

```ts
import { createGate } from "@vyr-e/latch";

const gate = createGate({ policy: "latch.yaml" });

const refund = gate.wrap("stripe.refunds.create", {
  async execute(input) {
    return stripe.refunds.create(input);
  },
});

await refund.execute({ amount: 30 }); // throws LatchApprovalRequiredError
await refund.execute({ amount: 80 }); // throws LatchDeniedError — exceeds max_amount 50
```

Denied and approval-gated calls throw before `execute` runs. Runtimes with human-in-the-loop
support can catch `LatchApprovalRequiredError` and pause; or pass `onApproval` to
`createGate` to decide inline.

## 4. Let the model read the policy too

`latch prompt` renders the same file as a markdown section for the system prompt — allowed actions,
approval requirements, denied paths, and the rule that denials are not to be worked around. See
[Prompt](./prompt.md).

## 5. Check calls in CI

```sh
bunx latch check stripe.refunds.create --input '{"amount": 80}'
# DENIED  stripe.refunds.create — amount 80 exceeds max_amount 50   (exit 1)
```

Exit codes: `0` allowed, `1` denied, `2` approval required, `3` invalid policy.

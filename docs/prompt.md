---
title: Prompt
---

A runtime gate can stop a tool call, but a model that never attempts forbidden work is safer still.
`renderPrompt` (or `latch prompt`) renders the policy as a markdown section for the system prompt:

```md
## Permissions (latch)

You are support-agent. Your permissions are declared in `latch.yaml` and enforced by latch. Follow
them exactly.

### Allowed actions

- `stripe.customers.read` — allowed without approval.
- `stripe.refunds.create` — max amount 50; a human must approve each call before it runs.
- `github.issues.create` — allowed without approval.

### Never do these (denied)

- `github.repositories.delete`
- any action that touches these paths: ~/.ssh, ~/.aws

Anything not listed under allowed actions is denied by default.

If a call is denied, do not try to work around it — no shell equivalents, no rephrasing, no
alternate tools. Say what you cannot do and why. If a call requires approval, ask the human and wait
for their explicit yes before running it.
```

Notes:

- Constraints become plain instructions: `max_amount` turns into "max amount 50", `approval:
  required` into "a human must approve each call before it runs".
- A bare `filesystem.paths` deny renders as "any action that touches these paths", matching how the
  engine treats it.
- The closing lines are deliberate: deny reasons say what to do instead, and the model is told not
  to route around the policy.

Prompt-level rules are guidance, not enforcement — pair this with `createGate` whenever the runtime
lets you, and use the prompt for everything else (plain chat agents, MCP servers without hooks,
subagents that only see a system prompt).

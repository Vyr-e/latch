<div align="center">
  <h1>latch</h1>
  <p><strong>A permission system for AI agents, declared in one YAML file.</strong></p>
</div>

Agents get tool calls. latch decides which of them run. You declare what an agent may do in a
`latch.yaml` — allow, deny, amount limits, human-approval gates, protected paths — and every runtime
that reads the file enforces the same rules. Unlisted actions are denied by default.

```yaml
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
```

## How agents consume it

latch gives the same policy three surfaces, so any agent — framework-wired or plain LLM — can follow it:

1. **Runtime gate.** Wrap a tool; the policy decides whether `execute` runs at all.

   ```ts
   import { createGate } from "@vyr-e/latch";

   const gate = createGate({ policy: "latch.yaml" });

   export const refund = gate.wrap("stripe.refunds.create", {
     async execute(input) {
       return chargeApi.refund(input);
     },
   });
   // denied → throws LatchDeniedError with the reason
   // approval: required → throws LatchApprovalRequiredError (or asks your onApproval handler)
   ```

   Action names autocomplete from `latch.yaml`; unknown names fail to compile.

2. **A prompt section.** `renderPrompt(policy)` turns the YAML into markdown a model can read and
   follow: what is allowed, what needs a human, what never happens, and what to do when a call is
   denied. Paste it into `instructions.md` or a system prompt.

3. **A CLI.** Validate files, evaluate single calls in CI, print the prompt section, and generate
   action-name types.

   ```sh
   bunx @vyr-e/latch validate
   latch check stripe.refunds.create --input '{"amount": 80}'   # exit 1: exceeds max_amount 50
   latch prompt > instructions-appendix.md
   latch types                                                   # writes latch-env.d.ts
   ```

## Rules that hold everywhere

- **Deny beats allow.** A matching deny rule wins, even against a more specific allow.
- **Default deny.** Anything not allowed is denied; `default: allow` loosens only the fallback,
  never the deny rules.
- **Constraints are fail-closed.** A `max_amount` rule with no numeric `amount` in the input is a
  denial, not a pass.
- **Approval is a decision.** `approval: required` downgrades an allow to a pause-for-a-human
  decision — the same `approved / denied / user-approval` shape eve-style runtimes already use.

## Install

```sh
bun add @vyr-e/latch
```

The CLI ships with the package: `bunx @vyr-e/latch --help` (or `npx @vyr-e/latch`).

## Documentation

- [Getting started](./docs/getting-started.md)
- [Schema reference](./docs/schema.md)
- [Runtime](./docs/runtime.md)
- [CLI](./docs/cli.md)
- [Prompt](./docs/prompt.md)

## License

[MIT](./LICENSE)

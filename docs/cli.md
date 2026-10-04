---
title: CLI
---

The CLI is non-interactive by design — every command takes explicit arguments, and exit codes are
part of the contract, so agents and CI can script it. Run it with `bunx latch` or `npx latch`.

```
latch init [file]              Scaffold a starter policy (default: ./latch.yaml)
latch validate [file]          Parse and validate a policy file
latch check <action>           Evaluate one action against the policy
    [--input '<json>']         Input object, e.g. '{"amount": 80}'
    [--input-file <path>]      Read the input object from a file
    [--file <path>]            Policy file (default: nearest latch.yaml)
    [--json]                   Machine-readable decision
latch list [file]              List the effective allow/deny rules
latch prompt [file]            Print the policy as a system-prompt section
latch types [file]             Generate action-name types for createGate
    [--out <path>]             Output file (default: latch-env.d.ts beside the policy)
    [--check]                  Exit 1 if the output is missing or stale; write nothing
```

## validate

```sh
$ latch validate
latch.yaml is valid — 3 allow rule(s), 1 deny rule(s), default: deny
```

Invalid files print every issue with its position and exit `1`:

```text
invalid policy:
latch.yaml:4:5 — "max_amount" must be a non-negative number (got "fifty")
latch.yaml:5:5 — "approval" must be "required" or "never" (got "sometimes")
```

## check

```sh
$ latch check stripe.refunds.create --input '{"amount": 80}'
DENIED  stripe.refunds.create (matched: allow "stripe.refunds.create") — amount 80 exceeds max_amount 50

$ latch check stripe.refunds.create --input '{"amount": 10}' --json
{
  "effect": "approval",
  "action": "stripe.refunds.create",
  "matched": { "section": "allow", "pattern": "stripe.refunds.create", "constraints": { … } },
  "reason": "the matched rule requires human approval before this call runs"
}
```

Exit codes: **0** allowed · **1** denied · **2** approval required · **3** invalid policy or usage.

A useful CI gate: `latch check` a representative call per sensitive tool, so a policy edit that
accidentally revokes or loosens access fails the build.

## init

Scaffolds a starter `latch.yaml`. Refuses to overwrite an existing file (exit `1`) — latch never
loosens a policy by surprise.

## list

```sh
$ latch list
agent: support-agent  default: deny

ALLOW
  stripe.customers.read
  stripe.refunds.create  (max_amount: 50; approval: required)
  github.issues.create

DENY
  github.repositories.delete
  *  (paths: ~/.ssh, ~/.aws)
```

The `*` row is a bare `filesystem.paths` entry — a global path deny (see [Schema](./schema.md)).

---
title: Schema reference
---

A complete `latch.yaml`:

```yaml
agent: support-agent        # optional name, surfaced in prompts
version: 1                  # optional; must be 1
default: deny               # optional; "deny" (default) or "allow"

allow:
  stripe.customers.read: true
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

Unknown root keys are errors (with a did-you-mean suggestion), so typos like `allowd:` fail loudly.

## Rules

`allow` and `deny` are mappings of actions. A value is either:

- `true` — unconditional, or
- a constraints map (below).

Rules may be written flat (`stripe.refunds.create: true`) or nested as maps
(`stripe: { refunds: { create: true } }`); both normalize to the same rule. Mixing constraints and
sub-actions in one map is ambiguous and rejected — move constraints to the leaf action.

`false` is not a valid value. Under `allow`, remove the entry (unlisted actions are already not
allowed) or move it under `deny`. Under `deny`, remove it.

## Action names

Dotted, case-sensitive names that mirror your tool names. Patterns:

- `stripe.customers.read` — exact match
- `stripe.*` — one or more trailing segments (`stripe.customers`, `stripe.customers.read`, …)
- `*` — every action

`*` is only valid as the last segment; `stripe.*.read` is a parse error.

When several rules match an action, the **most specific** wins (exact, then longer prefixes, then
`*`), and authoring order breaks ties.

## Evaluation order

1. **Deny rules win.** If any deny rule matches — including one that fires only for certain inputs —
   the call is denied, whatever the allow list says.
2. **The most specific matching allow rule decides.** Its constraints must all pass; a failed
   constraint denies with the reason, and `approval: required` turns the allow into an
   approval decision.
3. **Nothing matches:** denied by default. `default: allow` flips the fallback; deny rules still
   fire first.

## Constraints

| Key | Value | Meaning |
| --- | ----- | ------- |
| `max_amount` | non-negative number | Every numeric `amount` field in the input must be ≤ this — a batch with one amount over the limit fails, and a missing amount is a violation. |
| `approval` | `"required"` or `"never"` | `required` pauses for a human before each call runs. |
| `paths` | list of strings | Restrict (allow) or target (deny) by path-like input fields. |
| `description` | string | Human-readable explanation, used in prompts and deny reasons. |

### How `paths` matching works

Path-like input fields — `path`, `paths`, `file`, `filepath`, `filename`, `directory`, `dir`,
`target`, `source`, `dest`, and friends, case-insensitive, up to three levels deep — are collected
(each field may be one string or a list of strings) and tested against the patterns:

- `~` expands to the home directory, on both sides.
- A literal pattern matches itself **and anything inside it**: `~/.ssh` covers `~/.ssh/id_rsa`.
- `*` matches within one segment, `**` across segments: `/tmp/**` covers everything strictly inside
  `/tmp`; `/a/**/b` also matches `/a/b`.

Matching is case-sensitive. Command strings (`{ command: "cat ~/.ssh/id_rsa" }`) are **not** parsed —
`paths` guards structured path arguments. A deny rule with `paths` fires when any collected path
falls under a pattern; an allow rule with `paths` passes only when every collected path is covered,
and fails when the input has no path-like fields at all.

### The bare `filesystem.paths` entry

```yaml
deny:
  filesystem:
    paths:
      - ~/.ssh
```

is a statement about the **paths themselves**, so latch normalizes it to a global rule: any action
whose path-like fields touch `~/.ssh` is denied — whether the tool is `fs.read`, `upload.backup`, or
anything else. Scope it to filesystem tools with `filesystem.*`, or to one tool with
`tool.name: { paths: [...] }`.

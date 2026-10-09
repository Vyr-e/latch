---
title: Schema reference
---

A complete `latch.yaml`:

```yaml
agent: support-agent        # optional name, surfaced in prompts
version: 1                  # optional; must be 1
default: deny               # optional; "deny" (default) or "allow"
mode: hybrid                # optional; deterministic (default) | hybrid | classifier

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

classifier:                 # optional; implies mode: hybrid — see docs/classifier.md
  provider: judge           #   name of a runtime-registered classifier
  thresholds: { execute: 0.85, review: 0.55 }
  invoke: conditional       #   always (default) | conditional | manual
  conditions: { on_unmatched: true, on_urgency: true }   # only with invoke: conditional
  fallback: skip            #   skip (default) | review | deny
  timeout_ms: 10000

history:                    # optional classification/decision history
  enabled: true
  max_entries: 1000
```

Unknown root keys are errors (with a did-you-mean suggestion), so typos like `allowd:` fail loudly.

## Contextual gating keys

A `classifier:` block implies `mode: hybrid` when `mode` is absent. The policy only carries
settings — the implementation is bound at runtime (`createGate({ classifiers: { judge } })`).
`mode: classifier` requires an explicit, non-empty allow list and `default: deny`: the classifier
decides execution within a scope, never the scope itself. Full semantics: [docs/classifier.md](./classifier.md).

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
| `max_amount` | non-negative number | Every numeric `amount` field in the input must be ≤ this — a batch with one amount over the limit fails, and a missing or non-numeric amount (`"80"`) is a violation. |
| `approval` | `"required"` or `"never"` | `required` pauses for a human before each call runs. |
| `paths` | list of strings | Restrict (allow) or target (deny) by path-like input fields. |
| `path_fields` | list of strings | Extra input field names to treat as paths for this rule's `paths`. |
| `description` | string | Human-readable explanation, used in prompts and deny reasons. |

### How `paths` matching works

Path-like input fields — `path`, `paths`, `file`, `filepath`, `filename`, `directory`, `dir`,
`target`, `source`, `dest`, `cwd`, and friends, case-insensitive, at any depth — are collected
(each field may be one string or a list of strings) and tested against the patterns:

- `~` expands to the home directory, on both sides.
- `.` and `..` resolve before matching: `~/tmp/../.ssh/id_rsa` is `~/.ssh/id_rsa`.
- A literal pattern matches itself **and anything inside it**: `~/.ssh` covers `~/.ssh/id_rsa`.
- `*` matches within one segment, `**` across segments: `/tmp/**` covers everything strictly inside
  `/tmp`; `/a/**/b` also matches `/a/b`.

Command strings (`{ command: "cat ~/.ssh/id_rsa" }`) are **not** parsed — `paths` guards structured
path arguments. latch never touches the filesystem, so it can't follow symlinks; it matches in the
safe direction instead:

- **Deny is loose.** It fires if any reading of a path matches: as written or with `..` resolved,
  ignoring case, as a `file://` URL, percent-decoded, or with `\` as a separator.
- **Allow is strict.** Every collected path must be covered, case-sensitively, in every reading. A
  path with a `..` segment is covered only by a pattern that has one too, so `workspace/**` never
  covers `workspace/link/../secret`. An allow rule with `paths` also fails when the input has no
  path-like fields at all.

Relative paths are matched as written; latch doesn't know the tool's working directory. A deny on
`~/.ssh` won't catch `.ssh/id_rsa`, so have tools pass absolute paths.

When a tool names its path argument something generic, list it in `path_fields` (added to the
built-in set, not replacing it):

```yaml
allow:
  render.export:
    paths: [exports]
    path_fields: [output]
```

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

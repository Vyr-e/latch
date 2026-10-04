# AGENTS.md

Guidance for coding agents (and humans) working on latch.

## About latch

latch is a permission system for AI agents, declared in one YAML file. The file is the declaration
surface; the engine, gate wrapper, prompt renderer, and CLI are enforcement surfaces. Always style
the name as `latch`, lowercase, in user-facing copy.

## Stack and commands

Bun is the runtime, test runner, and package manager. TypeScript compiles with `tsc` (NodeNext ESM).

```sh
bun install          # install dependencies
bun run typecheck    # tsc --noEmit
bun test             # all tests (colocated src/**/*.test.ts)
bun run lint         # oxlint
bun run fmt          # oxfmt
bun run build        # emit dist/ for publishing
```

Run a single file: `bun test src/evaluate.test.ts`.

## Layout

- `src/types.ts` — the normalized policy and decision types
- `src/parse.ts` — YAML → normalized policy; collects every issue with line info
- `src/match.ts` — action pattern matching and specificity
- `src/constraints.ts` — max_amount, path matching, input field discovery
- `src/evaluate.ts` — `check()`, the decision function every other surface calls
- `src/gate.ts` — `createGate()` / `wrap()`, the tool-enforcement surface
- `src/prompt.ts` — policy → markdown for system prompts
- `src/codegen.ts` — policy → `latch-env.d.ts`, so `createGate` type-checks action names
- `src/load.ts` — file discovery (walks up for latch.yaml)
- `src/adapters/eve.ts` — mapping to eve's approval-status union
- `src/cli.ts` — the `latch` CLI (init, validate, check, list, prompt, types)
- `docs/` — published docs, shipped in the npm package

## Semantics worth defending in review

1. **Deny wins over allow**, always, even when the allow is more specific.
2. **Default deny** when nothing matches. `default: allow` loosens only the fallback.
3. **Constraints fail closed**: missing amount/path values are violations, not passes, and every
   amount in a batch is checked (not just the first found). Path-like fields are collected whether
   they hold one string or a list of strings.
4. **A bare `filesystem.paths` entry is global** — it applies to every action's path-like fields,
   because the intent is protecting paths, not a namespace. `filesystem.*` scopes it to filesystem
   tools.
5. **Path matching never parses command strings.** `paths` guards structured path-like input fields
   (path, file, target, …). This is a documented limitation, not a bug to "fix" silently.
6. **`*` in action patterns is trailing-only** (`stripe.*`, or bare `*`). Mid-pattern wildcards are a
   parse error. More specific matches win; ties keep authoring order.

## Conventions

- Tests are colocated (`src/*.test.ts`) and run with `bun test`. Cover every externally observable
  behavior change in the same commit.
- Error messages are documentation: say what was wrong, show the value, and say what to do. The
  parser collects all issues in one pass so agents fix a file in one round trip.
- Keep the runtime surface dependency-light; `yaml` is the only runtime dependency.
- The CLI must stay non-interactive and communicate through documented exit codes
  (check: 0 allow / 1 deny / 2 approval / 3 invalid policy).
- Comment why, not what. Public API gets JSDoc; internals rarely need comments.

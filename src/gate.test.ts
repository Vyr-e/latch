import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LatchApprovalRequiredError, LatchDeniedError } from "./errors.js";
import { toEveApprovalPolicy } from "./adapters/eve.js";
import { createGate } from "./gate.js";
import { parsePolicy } from "./parse.js";

const POLICY = parsePolicy(`
allow:
  web.search: true
  stripe.refunds.create:
    max_amount: 50
    approval: required
deny:
  github.repositories.delete: true
`);

const tmp = mkdtempSync(join(tmpdir(), "latch-gate-"));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

describe("createGate", () => {
  test("check returns the raw decision", () => {
    const gate = createGate({ policy: POLICY });
    expect(gate.check("web.search").effect).toBe("allow");
    expect(gate.check("stripe.refunds.create", { amount: 99 }).effect).toBe("deny");
    expect(gate.check("stripe.refunds.create", { amount: 10 }).effect).toBe("approval");
  });

  test("assert throws typed errors with the reason", () => {
    const gate = createGate({ policy: POLICY });
    expect(() => gate.assert("github.repositories.delete")).toThrow(LatchDeniedError);
    expect(() => gate.assert("stripe.refunds.create", { amount: 10 })).toThrow(
      LatchApprovalRequiredError,
    );
    expect(gate.assert("web.search").effect).toBe("allow");
  });

  test("wrap runs an allowed tool unchanged and keeps its other properties", async () => {
    const gate = createGate({ policy: POLICY });
    const tool = gate.wrap("web.search", {
      description: "Search the web.",
      async execute({ query }: { query: string }) {
        return { results: [query] };
      },
    });
    expect(tool.description).toBe("Search the web.");
    expect(await tool.execute({ query: "eve" })).toEqual({ results: ["eve"] });
  });

  test("wrap blocks denied calls before execute runs", async () => {
    const gate = createGate({ policy: POLICY });
    let ran = false;
    const tool = gate.wrap("github.repositories.delete", {
      async execute() {
        ran = true;
        return "ok";
      },
    });
    await expect(tool.execute()).rejects.toThrow(LatchDeniedError);
    expect(ran).toBe(false);
  });

  test("wrap throws for approval calls by default, so durable runtimes can pause", async () => {
    const gate = createGate({ policy: POLICY });
    const tool = gate.wrap("stripe.refunds.create", {
      async execute(_input: { amount: number }) {
        return "refunded";
      },
    });
    await expect(tool.execute({ amount: 10 })).rejects.toThrow(LatchApprovalRequiredError);
  });

  test("wrap consults onApproval and proceeds only on yes", async () => {
    const seen: unknown[] = [];
    const gate = createGate({
      policy: POLICY,
      onApproval: (request) => {
        seen.push(request.input);
        return true;
      },
    });
    const tool = gate.wrap("stripe.refunds.create", {
      async execute(input: { amount: number }) {
        return `refunded ${input.amount}`;
      },
    });
    expect(await tool.execute({ amount: 10 })).toBe("refunded 10");
    expect(seen).toEqual([{ amount: 10 }]);

    const denying = createGate({ policy: POLICY, onApproval: () => false });
    const blocked = denying.wrap("stripe.refunds.create", {
      async execute(_input: { amount: number }) {
        return "refunded";
      },
    });
    await expect(blocked.execute({ amount: 10 })).rejects.toThrow(LatchApprovalRequiredError);
  });

  test("an Action type argument narrows check, assert, wrap, and onApproval", async () => {
    type Action = "web.search" | "stripe.refunds.create";
    const seen: Action[] = [];
    const gate = createGate<Action>({
      policy: POLICY,
      onApproval: ({ action }) => {
        seen.push(action);
        return true;
      },
    });
    const tool = gate.wrap("stripe.refunds.create", {
      async execute(_input: { amount: number }) {
        return "refunded";
      },
    });
    expect(await tool.execute({ amount: 10 })).toBe("refunded");
    expect(seen).toEqual(["stripe.refunds.create"]);

    // @ts-expect-error — not a declared action
    gate.check("stripe.refund.create");
    // @ts-expect-error — not a declared action
    expect(() => gate.assert("github.repositories.delete")).toThrow(LatchDeniedError);
    // @ts-expect-error — not a declared action
    gate.wrap("web.serach", { execute: () => "ok" });

    expect(toEveApprovalPolicy(gate)({ toolName: "web.search" })).toBe("approved");
  });

  test("accepts a path to a policy file", () => {
    const file = join(tmp, "gate.yaml");
    writeFileSync(file, "allow:\n  a.b: true\n");
    const gate = createGate({ policy: file });
    expect(gate.check("a.b").effect).toBe("allow");
    expect(gate.file).toBe(file);
  });

  test("loading a policy file keeps latch-env.d.ts beside it in sync", () => {
    const dir = mkdtempSync(join(tmp, "types-"));
    const file = join(dir, "latch.yaml");
    writeFileSync(file, "allow:\n  web.search: true\n");
    createGate({ policy: file });
    expect(readFileSync(join(dir, "latch-env.d.ts"), "utf8")).toContain('action: "web.search";');

    writeFileSync(file, "allow:\n  web.search: true\n  web.fetch: true\n");
    createGate({ policy: file });
    expect(readFileSync(join(dir, "latch-env.d.ts"), "utf8")).toContain('| "web.fetch"');
  });

  test("types: false leaves the filesystem alone", () => {
    const dir = mkdtempSync(join(tmp, "no-types-"));
    const file = join(dir, "latch.yaml");
    writeFileSync(file, "allow:\n  web.search: true\n");
    createGate({ policy: file, types: false });
    expect(existsSync(join(dir, "latch-env.d.ts"))).toBe(false);
  });
});

import { describe, expect, test } from "bun:test";
import { parsePolicy } from "./parse.js";
import { check } from "./evaluate.js";

const SUPPORT_AGENT = parsePolicy(`
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
`);

describe("check", () => {
  test("allows unconstrained actions and reports the matched rule", () => {
    const decision = check(SUPPORT_AGENT, "stripe.customers.read");
    expect(decision.effect).toBe("allow");
    if (decision.effect === "allow") {
      expect(decision.matched.pattern).toBe("stripe.customers.read");
      expect(decision.matched.section).toBe("allow");
    }
  });

  test("downgrades an allow with approval: required to an approval decision", () => {
    const decision = check(SUPPORT_AGENT, "stripe.refunds.create", { amount: 30 });
    expect(decision.effect).toBe("approval");
    if (decision.effect === "approval") {
      expect(decision.reason).toContain("human approval");
    }
  });

  test("denies when amount exceeds max_amount, with the reason", () => {
    const decision = check(SUPPORT_AGENT, "stripe.refunds.create", { amount: 80 });
    expect(decision.effect).toBe("deny");
    if (decision.effect === "deny") {
      expect(decision.reason).toContain("exceeds max_amount 50");
      expect(decision.matched?.pattern).toBe("stripe.refunds.create");
    }
  });

  test("denies when max_amount is set but the input carries no amount", () => {
    const decision = check(SUPPORT_AGENT, "stripe.refunds.create", { chargeId: "ch_1" });
    expect(decision.effect).toBe("deny");
    if (decision.effect === "deny") {
      expect(decision.reason).toContain('no numeric "amount"');
    }
  });

  test("default-deny blocks unlisted actions", () => {
    const decision = check(SUPPORT_AGENT, "stripe.payouts.create");
    expect(decision.effect).toBe("deny");
    if (decision.effect === "deny") {
      expect(decision.matched).toBeUndefined();
      expect(decision.reason).toContain("not in the policy's allow list");
    }
  });

  test("a matching deny rule wins over any allow rule", () => {
    const policy = parsePolicy(`
allow:
  stripe.*: true
deny:
  stripe.payouts.*: true
`);
    expect(check(policy, "stripe.customers.read").effect).toBe("allow");
    const denied = check(policy, "stripe.payouts.create");
    expect(denied.effect).toBe("deny");
    if (denied.effect === "deny") expect(denied.matched?.pattern).toBe("stripe.payouts.*");
  });

  test("the most specific matching allow rule decides", () => {
    const policy = parsePolicy(`
allow:
  github.*: true
  github.issues.create:
    approval: required
`);
    expect(check(policy, "github.issues.comment").effect).toBe("allow");
    expect(check(policy, "github.issues.create").effect).toBe("approval");
  });

  test("a global path deny fires for any action touching a protected path", () => {
    expect(check(SUPPORT_AGENT, "stripe.customers.read", { path: "~/.ssh/id_rsa" }).effect).toBe(
      "deny",
    );
    expect(
      check(SUPPORT_AGENT, "stripe.customers.read", { path: "/Users/me/notes.txt" }).effect,
    ).toBe("allow");
    expect(
      check(SUPPORT_AGENT, "github.issues.create", { file: "~/.aws/credentials" }).effect,
    ).toBe("deny");
  });

  test("the path deny does not parse command strings — only path-like fields", () => {
    // Documented limitation: a bash command embedding a path is not detected.
    expect(
      check(SUPPORT_AGENT, "github.issues.create", { command: "cat ~/.ssh/id_rsa" }).effect,
    ).toBe("allow");
  });

  test("a path deny fires on path lists, not just single path fields", () => {
    // The common tool-input shape: paths: [...]. Missing this fails open.
    expect(
      check(SUPPORT_AGENT, "stripe.customers.read", { paths: ["~/.ssh/id_rsa", "/tmp/ok"] }).effect,
    ).toBe("deny");
  });

  test("max_amount is enforced against every amount in a batch input", () => {
    const policy = parsePolicy(`
allow:
  payments.batch:
    max_amount: 100
`);
    const batch = check(policy, "payments.batch", { items: [{ amount: 40 }, { amount: 4000 }] });
    expect(batch.effect).toBe("deny");
    if (batch.effect === "deny") expect(batch.reason).toContain("4000");

    const denyPolicy = parsePolicy(`
default: allow
allow:
  payments.send: true
deny:
  payments.send:
    max_amount: 100
`);
    expect(
      check(denyPolicy, "payments.send", { transfers: [{ amount: 1 }, { amount: 500 }] }).effect,
    ).toBe("deny");
    expect(
      check(denyPolicy, "payments.send", { transfers: [{ amount: 1 }, { amount: 5 }] }).effect,
    ).toBe("allow");
  });

  test("an allow rule with paths restricts the action to those paths", () => {
    const policy = parsePolicy(`
allow:
  fs.read:
    paths:
      - /tmp/**
deny:
  github.repositories.delete: true
`);
    expect(check(policy, "fs.read", { path: "/tmp/notes/a.json" }).effect).toBe("allow");
    const outside = check(policy, "fs.read", { path: "/etc/hosts" });
    expect(outside.effect).toBe("deny");
    if (outside.effect === "deny") expect(outside.reason).toContain("outside the allowed paths");
    const noPath = check(policy, "fs.read", { query: "x" });
    expect(noPath.effect).toBe("deny");
    if (noPath.effect === "deny") expect(noPath.reason).toContain("no path-like fields");
  });

  test("default: allow flips the fallback while deny rules still fire", () => {
    const policy = parsePolicy(`
default: allow
deny:
  github.repositories.delete: true
`);
    expect(check(policy, "anything.at.all").effect).toBe("allow");
    expect(check(policy, "github.repositories.delete").effect).toBe("deny");
  });

  test("a deny rule with paths fires only when a path value is under the pattern", () => {
    const policy = parsePolicy(`
allow:
  fs.*: true
deny:
  fs.write:
    paths:
      - /etc
`);
    expect(check(policy, "fs.write", { path: "/etc/hosts" }).effect).toBe("deny");
    expect(check(policy, "fs.write", { path: "/tmp/x" }).effect).toBe("allow");
  });

  test("a rule description becomes the reason", () => {
    const policy = parsePolicy(`
deny:
  exec.deploy:
    description: deploys touch production
`);
    const decision = check(policy, "exec.deploy");
    expect(decision.effect).toBe("deny");
    if (decision.effect === "deny") expect(decision.reason).toBe("deploys touch production");
  });

  test("rejects empty actions", () => {
    expect(() => check(SUPPORT_AGENT, "")).toThrow();
  });
});

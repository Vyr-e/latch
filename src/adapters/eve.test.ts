import { describe, expect, test } from "bun:test";
import { createGate } from "../gate.js";
import { parsePolicy } from "../parse.js";
import { toEveApprovalPolicy } from "./eve.js";

const POLICY = parsePolicy(`
agent: support-agent
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
`);

describe("toEveApprovalPolicy", () => {
  const approval = toEveApprovalPolicy(createGate({ policy: POLICY }));

  test("allows map to approved", () => {
    expect(approval({ toolName: "stripe.customers.read" })).toBe("approved");
  });

  test("approval-required calls map to user-approval", () => {
    expect(approval({ toolName: "stripe.refunds.create", toolInput: { amount: 10 } })).toBe(
      "user-approval",
    );
  });

  test("constraint failures and denies map to denied with a reason", () => {
    const overBudget = approval({ toolName: "stripe.refunds.create", toolInput: { amount: 80 } });
    expect(overBudget).toEqual({
      type: "denied",
      reason: expect.stringContaining("max_amount 50"),
    });
    expect(approval({ toolName: "github.repositories.delete" })).toEqual({
      type: "denied",
      reason: expect.stringContaining("denied by rule"),
    });
    expect(approval({ toolName: "fs.read", toolInput: { path: "~/.ssh/id_rsa" } })).toEqual({
      type: "denied",
      reason: expect.stringContaining("denied path"),
    });
  });

  test("default-deny unlisted actions", () => {
    expect(approval({ toolName: "stripe.payouts.create" })).toEqual({
      type: "denied",
      reason: expect.stringContaining("not in the policy's allow list"),
    });
  });

  test("accepts a bare policy object too", () => {
    const fromPolicy = toEveApprovalPolicy(POLICY);
    expect(fromPolicy({ toolName: "stripe.customers.read" })).toBe("approved");
  });
});

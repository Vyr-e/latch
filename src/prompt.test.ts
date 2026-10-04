import { describe, expect, test } from "bun:test";
import { parsePolicy } from "./parse.js";
import { renderPrompt } from "./prompt.js";

const POLICY = parsePolicy(`
agent: support-agent

allow:
  stripe.customers.read: true
  stripe.refunds.create:
    max_amount: 50
    approval: required
  fs.read:
    paths:
      - /tmp/**

deny:
  github.repositories.delete: true
  filesystem:
    paths:
      - ~/.ssh
      - ~/.aws
`);

describe("renderPrompt", () => {
  const prompt = renderPrompt(POLICY);

  test("names the agent and the policy file", () => {
    expect(prompt).toContain("## Permissions (latch)");
    expect(prompt).toContain("You are support-agent");
    expect(prompt).toContain("`latch.yaml`");
  });

  test("describes allow rules with their constraints", () => {
    expect(prompt).toContain("- `stripe.customers.read` — allowed without approval.");
    expect(prompt).toContain("max amount 50; a human must approve each call before it runs");
    expect(prompt).toContain("only for these paths: /tmp/**");
  });

  test("describes denies, including the global path guard", () => {
    expect(prompt).toContain("- `github.repositories.delete`");
    expect(prompt).toContain("any action that touches these paths: ~/.ssh, ~/.aws");
  });

  test("states the default and the no-workaround rule", () => {
    expect(prompt).toContain("denied by default");
    expect(prompt).toContain("do not try to work around it");
    expect(prompt).toContain("wait for their explicit yes");
  });

  test("honors an explicit agent name override", () => {
    expect(renderPrompt(POLICY, { agent: "eve" })).toContain("You are eve");
  });

  test("renders an allow-less policy as fully gated", () => {
    const prompt = renderPrompt(parsePolicy("agent: x\ndeny:\n  exec.*: true\n"));
    expect(prompt).toContain("Nothing is pre-approved");
  });
});

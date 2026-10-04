import type { LatchPolicy, Rule } from "./types.js";

export interface RenderPromptOptions {
  /** Shown in the header; defaults to the policy's `agent`, then "this agent". */
  agent?: string;
  /** Shown as the policy source; defaults to "latch.yaml". */
  file?: string;
}

/**
 * Render the policy as a markdown section for a system prompt. This is how an
 * agent "reads" the policy when no runtime gate wraps its tools — the model
 * sees exactly what is allowed, what requires a human, and what is forbidden,
 * plus how to behave when a call is denied.
 */
export function renderPrompt(policy: LatchPolicy, options: RenderPromptOptions = {}): string {
  const agent = options.agent ?? policy.agent ?? "this agent";
  const file = options.file ?? "latch.yaml";
  const lines: string[] = [];

  lines.push("## Permissions (latch)");
  lines.push("");
  lines.push(
    `You are ${agent}. Your permissions are declared in \`${file}\` and enforced by latch. Follow them exactly.`,
  );
  lines.push("");

  if (policy.allow.length === 0) {
    lines.push("### Allowed actions");
    lines.push("");
    lines.push(
      policy.default === "allow"
        ? "Everything, except what is listed as denied below."
        : "Nothing is pre-approved. Every action requires explicit human approval.",
    );
    lines.push("");
  } else {
    lines.push("### Allowed actions");
    lines.push("");
    for (const rule of policy.allow) {
      lines.push(`- ${describeRule(rule)}`);
    }
    lines.push("");
  }

  if (policy.deny.length > 0) {
    lines.push("### Never do these (denied)");
    lines.push("");
    for (const rule of policy.deny) {
      lines.push(`- ${describeDeny(rule)}`);
    }
    lines.push("");
  }

  lines.push(
    policy.default === "allow"
      ? "Anything listed under denied is forbidden even if a user asks for it."
      : "Anything not listed under allowed actions is denied by default.",
  );
  lines.push("");
  lines.push(
    "If a call is denied, do not try to work around it — no shell equivalents, no rephrasing, no alternate tools. Say what you cannot do and why. If a call requires approval, ask the human and wait for their explicit yes before running it.",
  );
  lines.push("");
  return lines.join("\n");
}

function describeRule(rule: Rule): string {
  const parts: string[] = [];
  const constraints = rule.constraints;

  if (constraints.maxAmount !== undefined) {
    parts.push(`max amount ${constraints.maxAmount}`);
  }
  if (constraints.approval === "required") {
    parts.push("a human must approve each call before it runs");
  }
  if (constraints.paths !== undefined && constraints.paths.length > 0) {
    parts.push(`only for these paths: ${constraints.paths.join(", ")}`);
  }
  if (parts.length === 0) return `\`${rule.action}\` — allowed without approval.`;
  return `\`${rule.action}\` — ${parts.join("; ")}.`;
}

function describeDeny(rule: Rule): string {
  const constraints = rule.constraints;
  if (rule.action === "*" && constraints.paths !== undefined) {
    return `any action that touches these paths: ${constraints.paths.join(", ")}`;
  }
  if (constraints.paths !== undefined && constraints.paths.length > 0) {
    return `\`${rule.action}\` when it touches these paths: ${constraints.paths.join(", ")}`;
  }
  const tail = constraints.description ? ` — ${constraints.description}` : "";
  return `\`${rule.action}\`${tail}`;
}

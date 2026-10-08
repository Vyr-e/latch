export class LatchError extends Error {
  override name = "LatchError";
}

export interface LatchIssue {
  message: string;
  file?: string;
  /** 1-based, when the offending node's position is known. */
  line?: number;
  col?: number;
  /** Dotted path into the YAML document, e.g. `allow.stripe.refunds.create`. */
  path?: string;
}

/**
 * Thrown when a policy file fails to parse or validate. Issues are collected
 * (not fail-fast) so an agent can fix everything in one round trip.
 */
export class LatchParseError extends LatchError {
  override name = "LatchParseError";
  readonly issues: LatchIssue[];

  constructor(issues: LatchIssue[]) {
    super(formatIssues(issues));
    this.issues = issues;
  }
}

export class LatchDeniedError extends LatchError {
  override name = "LatchDeniedError";
  readonly action: string;
  readonly reason: string;

  constructor(action: string, reason: string) {
    super(`Denied: ${action} — ${reason}`);
    this.action = action;
    this.reason = reason;
  }
}

export class LatchApprovalRequiredError extends LatchError {
  override name = "LatchApprovalRequiredError";
  readonly action: string;
  readonly reason?: string;

  constructor(action: string, reason?: string) {
    super(
      `Approval required: ${action}${reason ? ` — ${reason}` : ""}. A human must approve this call before it runs.`,
    );
    this.action = action;
    this.reason = reason;
  }
}

export class LatchSkippedError extends LatchError {
  override name = "LatchSkippedError";
  readonly action: string;
  readonly reason?: string;

  constructor(action: string, reason?: string) {
    super(
      `Skipped: ${action}${reason ? ` — ${reason}` : ""}. The call is permitted, but the classifier judged it inappropriate in the current context.`,
    );
    this.action = action;
    this.reason = reason;
  }
}

export class LatchReviewRequiredError extends LatchError {
  override name = "LatchReviewRequiredError";
  readonly action: string;
  readonly reason?: string;

  constructor(action: string, reason?: string) {
    super(
      `Review required: ${action}${reason ? ` — ${reason}` : ""}. The classification was too uncertain to execute automatically.`,
    );
    this.action = action;
    this.reason = reason;
  }
}

export function formatIssues(issues: LatchIssue[]): string {
  return issues
    .map((issue) => {
      const at = issue.file ? `${issue.file}` : "";
      const pos =
        issue.line !== undefined
          ? `${at}:${issue.line}${issue.col !== undefined ? `:${issue.col}` : ""}`
          : at;
      return pos ? `${pos} — ${issue.message}` : issue.message;
    })
    .join("\n");
}

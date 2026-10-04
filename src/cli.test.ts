import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { main } from "./cli.js";

const VALID = `
agent: support-agent
allow:
  stripe.customers.read: true
  stripe.refunds.create:
    max_amount: 50
    approval: required
deny:
  filesystem:
    paths:
      - ~/.ssh
`;

const INVALID = `allow:
  stripe.refunds.create:
    max_amount: fifty
`;

const tmp = mkdtempSync(join(tmpdir(), "latch-cli-"));
writeFileSync(join(tmp, "latch.yaml"), VALID);
writeFileSync(join(tmp, "broken.yaml"), INVALID);

afterAll(() => rmSync(tmp, { recursive: true, force: true }));

function run(args: string[], cwd = tmp): { code: number; out: string; err: string } {
  // Capture process output by swapping the streams around a direct main() call.
  const chunks: { out: string; err: string } = { out: "", err: "" };
  const stdout = process.stdout.write;
  const stderr = process.stderr.write;
  const cwdBefore = process.cwd();
  process.stdout.write = (text: unknown): boolean => {
    chunks.out += String(text);
    return true;
  };
  process.stderr.write = (text: unknown): boolean => {
    chunks.err += String(text);
    return true;
  };
  process.chdir(cwd);
  let code: number;
  try {
    code = main(args);
  } finally {
    process.stdout.write = stdout;
    process.stderr.write = stderr;
    process.chdir(cwdBefore);
  }
  return { code, out: chunks.out, err: chunks.err };
}

describe("latch validate", () => {
  test("valid policy exits 0 with a summary", () => {
    const result = run(["validate", "latch.yaml"]);
    expect(result.code).toBe(0);
    expect(result.out).toContain("latch.yaml is valid");
    expect(result.out).toContain("2 allow rule(s), 1 deny rule(s), default: deny");
  });

  test("invalid policy exits 1 with line-precise issues", () => {
    const result = run(["validate", "broken.yaml"]);
    expect(result.code).toBe(1);
    expect(result.err).toContain("invalid policy");
    expect(result.err).toContain("3");
    expect(result.err).toContain('"max_amount" must be a non-negative number');
  });
});

describe("latch check", () => {
  test("allowed exits 0", () => {
    const result = run(["check", "stripe.customers.read"]);
    expect(result.code).toBe(0);
    expect(result.out).toContain("ALLOWED");
    expect(result.out).toContain('matched: allow "stripe.customers.read"');
  });

  test("denied exits 1 and approval exits 2", () => {
    expect(run(["check", "stripe.refunds.create", "--input", '{"amount": 80}']).code).toBe(1);
    expect(run(["check", "stripe.refunds.create", "--input", '{"amount": 10}']).code).toBe(2);
    expect(run(["check", "anything.else"]).code).toBe(1);
  });

  test("--json emits the structured decision", () => {
    const result = run(["check", "stripe.refunds.create", "--input", '{"amount": 10}', "--json"]);
    expect(result.code).toBe(2);
    expect(JSON.parse(result.out)).toMatchObject({
      effect: "approval",
      action: "stripe.refunds.create",
    });
  });

  test("usage errors exit 3", () => {
    expect(run(["check"]).code).toBe(3);
    expect(run(["check", "a.b", "--input", "{oops"]).code).toBe(3);
    expect(run(["check", "a.b", "--file", "broken.yaml"]).code).toBe(3);
  });
});

describe("latch list and prompt", () => {
  test("list prints both sections with constraints", () => {
    const result = run(["list"]);
    expect(result.code).toBe(0);
    expect(result.out).toContain("ALLOW");
    expect(result.out).toContain("stripe.refunds.create  (max_amount: 50; approval: required)");
    expect(result.out).toContain("DENY");
    expect(result.out).toContain("*  (paths: ~/.ssh)");
  });

  test("prompt prints the markdown section", () => {
    const result = run(["prompt"]);
    expect(result.code).toBe(0);
    expect(result.out).toContain("## Permissions (latch)");
    expect(result.out).toContain("You are support-agent");
  });
});

describe("latch init", () => {
  test("scaffolds once and refuses to overwrite", () => {
    const dir = join(tmp, "fresh");
    mkdirSync(dir);
    const result = run(["init"], dir);
    expect(result.code).toBe(0);
    expect(result.out).toContain("created");
    expect(result.out).toContain("latch.yaml");
    expect(readFileSync(join(dir, "latch-env.d.ts"), "utf8")).toContain('| "web.search"');
    expect(run(["types", "--check"], dir).code).toBe(0);
    expect(run(["validate"], dir).code).toBe(0);

    const second = run(["init"], dir);
    expect(second.code).toBe(1);
    expect(second.err).toContain("refusing to overwrite");
  });
});

describe("usage", () => {
  test("no arguments prints the usage and exits 0", () => {
    const result = run([]);
    expect(result.code).toBe(0);
    expect(result.out).toContain("Usage:");
  });

  test("unknown command exits 1", () => {
    const result = run(["purge"]);
    expect(result.code).toBe(1);
    expect(result.err).toContain('unknown command "purge"');
  });
});

describe("latch types", () => {
  test("writes latch-env.d.ts beside the policy, and --check tracks staleness", () => {
    const dir = join(tmp, "typed");
    mkdirSync(dir);
    writeFileSync(join(dir, "latch.yaml"), VALID);

    expect(run(["types", "--check"], dir).code).toBe(1);

    const result = run(["types"], dir);
    expect(result.code).toBe(0);
    expect(result.out).toContain("latch-env.d.ts");
    const generated = readFileSync(join(dir, "latch-env.d.ts"), "utf8");
    expect(generated).toContain('declare module "@vyr-e/latch"');
    expect(generated).toContain('| "stripe.refunds.create"');

    expect(run(["types", "--check"], dir).code).toBe(0);

    writeFileSync(join(dir, "latch.yaml"), `${VALID}  web.search: true\n`);
    const stale = run(["types", "--check"], dir);
    expect(stale.code).toBe(1);
    expect(stale.err).toContain("out of date");
  });
});

import { describe, expect, test } from "bun:test";
import { homedir } from "node:os";
import {
  findAmount,
  findAmounts,
  findMalformedAmount,
  findPathValues,
  pathMatches,
} from "./constraints.js";

describe("pathMatches", () => {
  test("a literal pattern covers itself and everything inside it", () => {
    expect(pathMatches("/tmp", "/tmp")).toBe(true);
    expect(pathMatches("/tmp", "/tmp/a/b")).toBe(true);
    expect(pathMatches("/tmp", "/tmpx")).toBe(false);
    expect(pathMatches("/tmp", "/var/tmp")).toBe(false);
  });

  test("trailing slashes are normalized away", () => {
    expect(pathMatches("/tmp/", "/tmp/x")).toBe(true);
  });

  test("tilde expands to the home directory on both sides", () => {
    expect(pathMatches("~/.ssh", `${homedir()}/.ssh/id_rsa`)).toBe(true);
    expect(pathMatches("~/x", "~/x")).toBe(true);
  });

  test("* stays within one path segment", () => {
    expect(pathMatches("/tmp/*.json", "/tmp/a.json")).toBe(true);
    expect(pathMatches("/tmp/*.json", "/tmp/sub/a.json")).toBe(false);
  });

  test("** crosses segments, strictly inside the prefix", () => {
    expect(pathMatches("/tmp/**", "/tmp/a/b/c")).toBe(true);
    expect(pathMatches("/tmp/**", "/tmp")).toBe(false);
    expect(pathMatches("/tmp/**", "/tmpx")).toBe(false);
  });

  test("a mid-pattern ** covers zero or more segments", () => {
    expect(pathMatches("/a/**/b", "/a/b")).toBe(true);
    expect(pathMatches("/a/**/b", "/a/x/y/b")).toBe(true);
    expect(pathMatches("/a/**/b", "/a/b/c")).toBe(false);
  });
});

describe("findPathValues", () => {
  test("collects path-like fields case-insensitively, at any depth", () => {
    const values = findPathValues({
      path: "/a",
      nested: { FilePath: "/b", deeper: { target: "/c" } },
      fourth: { too: { deep: { deeper: { path: "/d" } } } },
    });
    expect(values).toEqual(["/a", "/b", "/c", "/d"]);
  });

  test("terminates on cyclic input", () => {
    const input: Record<string, unknown> = { path: "/a" };
    input["self"] = input;
    const list: unknown[] = ["/b"];
    list.push(list);
    input["paths"] = list;
    expect(findPathValues(input)).toEqual(["/a", "/b"]);
    expect(findAmounts(input)).toEqual([]);
  });

  test("extra fields join the built-in set, case-insensitively", () => {
    expect(findPathValues({ output: "/a", uri: "/b" })).toEqual([]);
    expect(findPathValues({ Output: "/a", nested: { URI: ["/b"] } }, ["output", "Uri"])).toEqual([
      "/a",
      "/b",
    ]);
  });

  test("does not treat command strings as paths", () => {
    expect(findPathValues({ command: "cat /etc/passwd" })).toEqual([]);
    expect(findPathValues({ command: ["cat", "/etc/passwd"] })).toEqual([]);
  });

  test("collects every string under a path-like key, including lists", () => {
    expect(findPathValues({ paths: ["/a", "/b"] })).toEqual(["/a", "/b"]);
    expect(findPathValues({ target: ["/a", { path: "/b" }] })).toEqual(["/a", "/b"]);
    expect(findPathValues({ dest: "/a" })).toEqual(["/a"]);
  });

  test("collapses repeated slashes and a leading ./ before matching", () => {
    expect(pathMatches("/tmp", "//tmp//x///")).toBe(true);
    expect(pathMatches("src", "./src/a.ts")).toBe(true);
  });
});

describe("pathMatches with . and ..", () => {
  test("resolves .. before matching", () => {
    expect(pathMatches("~/.ssh", "~/tmp/../.ssh/id_rsa")).toBe(true);
    expect(pathMatches("/etc", "/var/../etc/hosts")).toBe(true);
    expect(pathMatches("workspace", "workspace/../../etc/passwd")).toBe(false);
    expect(pathMatches("/tmp/**", "/tmp/../etc/passwd")).toBe(false);
  });

  test("resolves .. against the home directory, not past the tilde", () => {
    expect(pathMatches(`${homedir()}/..`, "~/..")).toBe(true);
    expect(pathMatches("~", "~/../other")).toBe(false);
  });

  test("the root pattern covers every absolute path", () => {
    expect(pathMatches("/", "/etc/hosts")).toBe(true);
  });
});

describe("findAmount", () => {
  test("finds the numeric amount, nested and case-insensitive", () => {
    expect(findAmount({ amount: 5 })).toBe(5);
    expect(findAmount({ meta: { amount: 3 } })).toBe(3);
    expect(findAmount({ Amount: 2 })).toBe(2);
  });

  test("returns undefined for absent or non-numeric amounts", () => {
    expect(findAmount({ price: 2 })).toBeUndefined();
    expect(findAmount({ amount: "5" })).toBeUndefined();
    expect(findAmount(undefined)).toBeUndefined();
  });
});

describe("findAmounts", () => {
  test("collects every amount in a batch, nested and under amount-shaped lists", () => {
    expect(findAmounts({ items: [{ amount: 1 }, { amount: 9000 }] })).toEqual([1, 9000]);
    expect(findAmounts({ amount: [5, 50] })).toEqual([5, 50]);
    expect(findAmounts({ Amount: 2, meta: { amount: 3 } })).toEqual([2, 3]);
  });

  test("findAmount returns only the first", () => {
    expect(findAmount({ items: [{ amount: 1 }, { amount: 9000 }] })).toBe(1);
  });

  test("finds amounts at any depth", () => {
    expect(findAmounts({ a: { b: { c: { d: { amount: 7 } } } } })).toEqual([7]);
  });
});

describe("findMalformedAmount", () => {
  test("reports the first amount that is not a finite number", () => {
    expect(findMalformedAmount({ amount: 5, items: [{ amount: "9999" }] })).toBe("9999");
    expect(findMalformedAmount({ amount: Number.NaN })).toBeNaN();
    expect(findMalformedAmount({ amount: true })).toBe(true);
    expect(findMalformedAmount({ amount: { value: 10 } })).toEqual({ value: 10 });
  });

  test("treats null as absent and nested amounts as amounts", () => {
    expect(findMalformedAmount({ amount: null })).toBeUndefined();
    expect(findMalformedAmount({ amount: { items: [{ amount: 3 }] } })).toBeUndefined();
    expect(findMalformedAmount({ amount: [1, 2] })).toBeUndefined();
  });
});

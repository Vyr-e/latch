import { describe, expect, test } from "bun:test";
import { homedir } from "node:os";
import { findAmount, findAmounts, findPathValues, pathMatches } from "./constraints.js";

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
  test("collects path-like fields case-insensitively, three levels deep", () => {
    const values = findPathValues({
      path: "/a",
      nested: { FilePath: "/b", deeper: { target: "/c" } },
      fourth: { too: { deep: { deeper: { path: "/d" } } } },
    });
    expect(values).toEqual(["/a", "/b", "/c"]);
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
});

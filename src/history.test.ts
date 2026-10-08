import { describe, expect, test } from "bun:test";
import { createMemoryHistory, MemoryHistoryStore } from "./history.js";
import type { ClassificationHistoryEntry } from "./history.js";

function entry(
  id: string,
  overrides: Partial<ClassificationHistoryEntry> = {},
): ClassificationHistoryEntry {
  return {
    id,
    timestamp: Date.now(),
    agentId: "agent-1",
    tool: "github.issues.create",
    decision: "execute",
    confidence: 0.9,
    scores: { relevance: 0.9, necessity: 0.8, urgency: 0.7 },
    executed: false,
    outcome: { authorization: "allow", execution: "execute", source: "hybrid" },
    ...overrides,
  };
}

describe("MemoryHistoryStore", () => {
  test("records and lists entries oldest first", () => {
    const store = createMemoryHistory();
    store.record(entry("a"));
    store.record(entry("b"));
    expect(store.list().map((e) => e.id)).toEqual(["a", "b"]);
  });

  test("is bounded — oldest entries are dropped first", () => {
    const store = new MemoryHistoryStore({ maxEntries: 3 });
    for (const id of ["a", "b", "c", "d", "e"]) store.record(entry(id));
    expect(store.list().map((e) => e.id)).toEqual(["c", "d", "e"]);
    expect(store.size).toBe(3);
  });

  test("markExecuted flips the executed flag by id", () => {
    const store = createMemoryHistory();
    store.record(entry("a"));
    store.markExecuted("a");
    expect(store.list()[0]!.executed).toBe(true);
    store.markExecuted("missing"); // unknown id: a no-op, not an error
    expect(store.size).toBe(1);
  });

  test("recent returns the trailing slice, oldest first", () => {
    const store = createMemoryHistory();
    for (const id of ["a", "b", "c", "d"]) store.record(entry(id));
    expect(store.recent(2).map((e) => e.id)).toEqual(["c", "d"]);
    expect(store.recent(10).map((e) => e.id)).toEqual(["a", "b", "c", "d"]);
  });

  test("rejects non-positive maxEntries", () => {
    expect(() => new MemoryHistoryStore({ maxEntries: 0 })).toThrow(/positive integer/);
  });
});

import { randomUUID } from "node:crypto";
import type { ClassifierDecision, ClassificationScores } from "./classifier.js";

/** The final policy outcome for a classified call — the model's recommendation is not the outcome. */
export interface DecisionOutcome {
  authorization: "allow" | "deny" | "requires_approval";
  execution: "execute" | "skip" | "review";
  source: "deterministic" | "classifier" | "hybrid";
}

/**
 * One recorded classification and the decision it fed. Prediction, execution,
 * and (via `executed`) what actually ran are kept distinct so history can
 * support evaluation and training-data work later without conflating them.
 */
export interface ClassificationHistoryEntry {
  id: string;
  timestamp: number;
  agentId: string;
  taskId?: string;
  tool: string;
  /** The classifier's own decision, before thresholds and policy. "none" when classification failed outright. */
  decision: ClassifierDecision | "none";
  confidence: number;
  scores: ClassificationScores;
  /** Set to true by the enforcement surface once the tool actually ran. */
  executed: boolean;
  evaluatorId?: string;
  evaluatorVersion?: string;
  reason?: string;
  metadata?: Record<string, unknown>;
  outcome: DecisionOutcome;
}

/**
 * Storage adapter for classification history. Recording must never alter
 * authorization decisions — the engine treats store errors as invisible.
 */
export interface HistoryStore {
  record(entry: ClassificationHistoryEntry): void | Promise<void>;
  /**
   * The `n` most recent entries, oldest first — for feeding sparingly into
   * future classifications. Feeding all history back creates feedback loops
   * that reinforce earlier mistakes, so this is opt-in at the runtime level.
   */
  recent?(n: number): ClassificationHistoryEntry[];
  markExecuted?(id: string): void | Promise<void>;
}

export interface MemoryHistoryOptions {
  /** Maximum retained entries; oldest are dropped first. Default 1000. */
  maxEntries?: number;
}

const DEFAULT_MAX_ENTRIES = 1000;

/** A bounded in-memory HistoryStore — the default for observability without a database. */
export class MemoryHistoryStore implements HistoryStore {
  private readonly entries: ClassificationHistoryEntry[] = [];
  private readonly maxEntries: number;

  constructor(options: MemoryHistoryOptions = {}) {
    this.maxEntries = options.maxEntries ?? DEFAULT_MAX_ENTRIES;
    if (!Number.isInteger(this.maxEntries) || this.maxEntries <= 0) {
      throw new TypeError(
        `latch: history maxEntries must be a positive integer (got ${JSON.stringify(options.maxEntries)})`,
      );
    }
  }

  record(entry: ClassificationHistoryEntry): void {
    this.entries.push(entry);
    if (this.entries.length > this.maxEntries) {
      this.entries.splice(0, this.entries.length - this.maxEntries);
    }
  }

  recent(n: number): ClassificationHistoryEntry[] {
    return this.entries.slice(-n);
  }

  markExecuted(id: string): void {
    const entry = this.entries.find((candidate) => candidate.id === id);
    if (entry !== undefined) entry.executed = true;
  }

  /** All retained entries, oldest first. */
  list(): readonly ClassificationHistoryEntry[] {
    return this.entries;
  }

  get size(): number {
    return this.entries.length;
  }
}

export function createMemoryHistory(options: MemoryHistoryOptions = {}): MemoryHistoryStore {
  return new MemoryHistoryStore(options);
}

export function newHistoryId(): string {
  return randomUUID();
}

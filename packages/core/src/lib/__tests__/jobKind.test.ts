import { describe, expect, it } from "vitest";
import {
  backoffMs,
  CHUNK_BUDGETS,
  DEFAULT_CHUNK_ROW_LIMIT,
  DEFAULT_MAX_CHUNKS_PER_JOB,
  MAX_JOBS_PER_ALARM,
  PRUNE_ROW_LIMIT,
} from "../jobBudgets";
import { JOB_KINDS, JOB_OWNER, JOB_REARM, REARMING_KINDS } from "../jobKind";

// `spec/database/index.md`「`kind` の全数」is the source of truth; these
// assertions are the mechanical oracle that keeps the table and the code from
// drifting apart silently.
describe("job kinds", () => {
  it("enumerates 12 kinds without duplicates", () => {
    expect(JOB_KINDS).toHaveLength(12);
    expect(new Set(JOB_KINDS).size).toBe(12);
  });

  it("declares an owner and a re-arm class for every kind", () => {
    expect(Object.keys(JOB_OWNER).sort()).toEqual([...JOB_KINDS].sort());
    expect(Object.keys(JOB_REARM).sort()).toEqual([...JOB_KINDS].sort());
  });

  it("splits ownership 6 / 6 between the two DO classes", () => {
    const owners = Object.values(JOB_OWNER);
    expect(owners.filter((o) => o === "userData")).toHaveLength(6);
    expect(owners.filter((o) => o === "identityDirectory")).toHaveLength(6);
  });

  it("lists exactly the five re-arming kinds (classes A and B)", () => {
    expect([...REARMING_KINDS].sort()).toEqual([
      "purge-trash",
      "rotate-encryption",
      "sweep-orphan-mapping",
      "sweep-reservations",
      "sweep-reset-tokens",
    ]);
    const rearmingByClass = JOB_KINDS.filter((k) => JOB_REARM[k] !== "C");
    expect([...rearmingByClass].sort()).toEqual([...REARMING_KINDS].sort());
  });

  it("classifies three kinds as A and two as B", () => {
    const classes = Object.values(JOB_REARM);
    expect(classes.filter((c) => c === "A")).toHaveLength(3);
    expect(classes.filter((c) => c === "B")).toHaveLength(2);
    expect(classes.filter((c) => c === "C")).toHaveLength(7);
  });
});

describe("job budgets", () => {
  it("bounds every kind by row count and chunk count", () => {
    expect(Object.keys(CHUNK_BUDGETS).sort()).toEqual([...JOB_KINDS].sort());
    for (const kind of JOB_KINDS) {
      expect(CHUNK_BUDGETS[kind].chunkRowLimit).toBe(DEFAULT_CHUNK_ROW_LIMIT);
      expect(CHUNK_BUDGETS[kind].maxChunks).toBe(DEFAULT_MAX_CHUNKS_PER_JOB);
    }
    expect(MAX_JOBS_PER_ALARM).toBe(25);
    expect(PRUNE_ROW_LIMIT).toBe(1000);
  });

  it("backs off exponentially and saturates at the cap", () => {
    expect(backoffMs(0)).toBe(1_000);
    expect(backoffMs(1)).toBe(2_000);
    expect(backoffMs(5)).toBe(32_000);
    expect(backoffMs(100)).toBe(60 * 60 * 1000);
    expect(backoffMs(-1)).toBe(1_000);
  });
});

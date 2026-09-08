import { describe, expect, it } from "vitest";
import {
  compactSearch,
  timelineModeOf,
  timelineSearchSchema,
} from "@/components/timeline/search";

function parse(input: Record<string, unknown>) {
  return timelineSearchSchema.parse(input);
}

describe("timelineSearchSchema", () => {
  it("trims the keyword and drops a blank one", () => {
    expect(parse({ q: "  買い物 " })).toEqual({ q: "買い物" });
    expect(parse({ q: "   " })).toEqual({});
    expect(parse({ q: "" })).toEqual({});
  });

  it("keeps only a real calendar date", () => {
    expect(parse({ date: "2026-07-22" })).toEqual({ date: "2026-07-22" });
    expect(parse({ date: "2026-02-30" })).toEqual({});
    expect(parse({ date: "yesterday" })).toEqual({});
  });

  it("never fails: a wrong type falls back to absent", () => {
    expect(parse({ q: 1, date: ["x"], memo: {} })).toEqual({});
    expect(parse({ q: "x".repeat(501) })).toEqual({});
  });

  it("keeps q and date together, and memo alongside them", () => {
    expect(parse({ q: "a", date: "2026-07-22", memo: "m1" })).toEqual({
      q: "a",
      date: "2026-07-22",
      memo: "m1",
    });
  });
});

describe("timelineModeOf", () => {
  it("lets memo win and ignores the keyword for it", () => {
    expect(timelineModeOf({ memo: "m1", q: "a", date: "2026-07-22" })).toEqual({
      kind: "memo",
      memoId: "m1",
    });
  });

  it("carries the keyword into a date jump", () => {
    expect(timelineModeOf({ date: "2026-07-22", q: "a" })).toEqual({
      kind: "date",
      date: "2026-07-22",
      keyword: "a",
    });
    expect(timelineModeOf({ date: "2026-07-22" })).toEqual({
      kind: "date",
      date: "2026-07-22",
      keyword: null,
    });
  });

  it("is the plain list otherwise", () => {
    expect(timelineModeOf({})).toEqual({ kind: "list", keyword: null });
    expect(timelineModeOf({ q: "a" })).toEqual({ kind: "list", keyword: "a" });
  });
});

describe("compactSearch", () => {
  it("omits absent keys", () => {
    expect(
      Object.keys(compactSearch({ q: undefined, date: "2026-07-22" })),
    ).toEqual(["date"]);
  });
});

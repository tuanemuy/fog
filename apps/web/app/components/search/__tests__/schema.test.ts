import { describe, expect, it } from "vitest";
import { isSearchOutput, searchMoreSchema } from "../schema";
import { compactSearch, searchPageSchema } from "../search";

describe("searchPageSchema", () => {
  it("keeps q and topic trimmed and drops what is absent or malformed", () => {
    expect(searchPageSchema.parse({ q: "  fog ", topic: "t1" })).toEqual({
      q: "fog",
      topic: "t1",
    });
    expect(searchPageSchema.parse({})).toEqual({});
    expect(searchPageSchema.parse({ q: "   " })).toEqual({});
    expect(searchPageSchema.parse({ q: "あ".repeat(501) })).toEqual({});
    expect(searchPageSchema.parse({ q: 3, topic: ["x"] })).toEqual({});
    expect(compactSearch({ q: undefined, topic: "t" })).toEqual({ topic: "t" });
  });
});

describe("searchMoreSchema", () => {
  it("requires a keyword and a cursor; the scope is optional", () => {
    expect(searchMoreSchema.safeParse({ q: "fog", cursor: "c" }).success).toBe(
      true,
    );
    expect(
      searchMoreSchema.safeParse({ q: "fog", topic: "t", cursor: "c" }).success,
    ).toBe(true);
    expect(searchMoreSchema.safeParse({ q: " ", cursor: "c" }).success).toBe(
      false,
    );
    expect(searchMoreSchema.safeParse({ q: "fog", cursor: "" }).success).toBe(
      false,
    );
    expect(searchMoreSchema.safeParse({ q: "fog" }).success).toBe(false);
  });
});

describe("isSearchOutput", () => {
  const at = new Date("2026-09-08T00:00:00Z");
  it("accepts both item kinds and refuses a wrong shape", () => {
    expect(
      isSearchOutput({
        items: [
          {
            type: "memo",
            id: "m",
            snippet: "s",
            timestamp: at,
            sourceOfDocumentIds: [],
          },
          {
            type: "document",
            id: "d",
            snippet: "s",
            timestamp: at,
            topicId: "t",
            topicName: "T",
            sourceMemoIds: ["m"],
          },
        ],
        count: 2,
        nextCursor: null,
      }),
    ).toBe(true);
    expect(isSearchOutput({ items: [], count: 0, nextCursor: "c" })).toBe(true);
    expect(
      isSearchOutput({
        items: [{ type: "memo", id: "m" }],
        count: 1,
        nextCursor: null,
      }),
    ).toBe(false);
    expect(isSearchOutput({ items: [], count: "0", nextCursor: null })).toBe(
      false,
    );
    expect(isSearchOutput(null)).toBe(false);
  });
});

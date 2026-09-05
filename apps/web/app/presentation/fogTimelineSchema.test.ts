import { describe, expect, it } from "vitest";
import { timelineQuerySchema, timelineSearchSchema } from "./fogTimelineSchema";

describe("timeline query boundary", () => {
  it("retains only valid filters and bounds pagination input", () => {
    expect(
      timelineSearchSchema.parse({
        keyword: "日本語",
        date: "2026-09-05",
        ownerId: "someone-else",
      }),
    ).toEqual({ keyword: "日本語", date: "2026-09-05" });
    expect(timelineQuerySchema.safeParse({ limit: 1000 }).success).toBe(false);
    expect(timelineQuerySchema.parse({ cursor: "page", limit: 30 })).toEqual({
      cursor: "page",
      limit: 30,
    });
  });
  it.each([
    "2026-02-30",
    "2026-13-01",
    "invalid",
  ])("rejects an invalid calendar date %s", (date) => {
    expect(timelineSearchSchema.safeParse({ date }).success).toBe(false);
  });
});

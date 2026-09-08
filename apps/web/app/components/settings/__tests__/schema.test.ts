import { describe, expect, it } from "vitest";
import { changeTrashRetentionDaysSchema } from "../schema";

describe("changeTrashRetentionDaysSchema", () => {
  it("takes a positive integer up to the DoS bound and refuses the rest", () => {
    expect(
      changeTrashRetentionDaysSchema.safeParse({ retentionDays: 1 }).success,
    ).toBe(true);
    expect(
      changeTrashRetentionDaysSchema.safeParse({ retentionDays: 36_500 })
        .success,
    ).toBe(true);
    for (const bad of [0, -1, 1.5, 36_501, "7", Number.NaN]) {
      expect(
        changeTrashRetentionDaysSchema.safeParse({ retentionDays: bad })
          .success,
      ).toBe(false);
    }
  });
});

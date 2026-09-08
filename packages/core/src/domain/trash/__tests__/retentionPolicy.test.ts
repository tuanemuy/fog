import { TrashRetentionDays } from "@repo/core/domain/identity/valueObject";
import { describe, expect, it } from "vitest";
import { RetentionPolicy } from "../retentionPolicy";

const TRASHED_AT = new Date("2026-03-01T12:34:56.789Z");

describe("RetentionPolicy.expiresAt", () => {
  it("adds the retention in whole days", () => {
    expect(
      RetentionPolicy.expiresAt(TRASHED_AT, TrashRetentionDays.create(30)),
    ).toEqual(new Date("2026-03-31T12:34:56.789Z"));
  });

  it("does not move the input", () => {
    const before = TRASHED_AT.getTime();
    RetentionPolicy.expiresAt(TRASHED_AT, TrashRetentionDays.create(1));
    expect(TRASHED_AT.getTime()).toBe(before);
  });
});

describe("RetentionPolicy.isExpired", () => {
  const purgeAfter = new Date("2026-03-31T00:00:00.000Z");

  it("is false before and at the deadline, true past it", () => {
    expect(
      RetentionPolicy.isExpired(purgeAfter, new Date(purgeAfter.getTime() - 1)),
    ).toBe(false);
    expect(RetentionPolicy.isExpired(purgeAfter, purgeAfter)).toBe(false);
    expect(
      RetentionPolicy.isExpired(purgeAfter, new Date(purgeAfter.getTime() + 1)),
    ).toBe(true);
  });
});

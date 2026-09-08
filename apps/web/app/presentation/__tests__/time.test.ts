import { describe, expect, it } from "vitest";
import {
  calendarDateOf,
  dayRange,
  formatCalendarDate,
  isCalendarDate,
} from "@/presentation/time";

describe("isCalendarDate", () => {
  it("accepts a real day and rejects a malformed or impossible one", () => {
    expect(isCalendarDate("2026-07-22")).toBe(true);
    expect(isCalendarDate("2024-02-29")).toBe(true);
    expect(isCalendarDate("2026-02-30")).toBe(false);
    expect(isCalendarDate("2026-13-01")).toBe(false);
    expect(isCalendarDate("2026-7-2")).toBe(false);
    expect(isCalendarDate("20260722")).toBe(false);
    expect(isCalendarDate("")).toBe(false);
  });
});

describe("dayRange", () => {
  it("bounds the day in Asia/Tokyo, the end exclusive at the next midnight", () => {
    const { date, dayEnd } = dayRange("2026-07-22");
    expect(date.toISOString()).toBe("2026-07-21T15:00:00.000Z");
    expect(dayEnd.toISOString()).toBe("2026-07-22T15:00:00.000Z");
  });

  it("crosses a month and a year boundary", () => {
    expect(dayRange("2026-01-31").dayEnd.toISOString()).toBe(
      "2026-01-31T15:00:00.000Z",
    );
    expect(dayRange("2026-12-31").dayEnd.toISOString()).toBe(
      "2026-12-31T15:00:00.000Z",
    );
  });

  it("refuses what is not a calendar date", () => {
    expect(() => dayRange("2026-02-30")).toThrow(RangeError);
  });
});

describe("calendarDateOf", () => {
  it("names the Asia/Tokyo day of an instant", () => {
    expect(calendarDateOf(new Date("2026-07-21T15:00:00.000Z"))).toBe(
      "2026-07-22",
    );
    expect(calendarDateOf(new Date("2026-07-21T14:59:59.999Z"))).toBe(
      "2026-07-21",
    );
  });
});

describe("formatCalendarDate", () => {
  it("renders the day with its weekday", () => {
    expect(formatCalendarDate("2026-07-22")).toBe("2026年7月22日(水)");
  });
});

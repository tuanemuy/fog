/**
 * Display time zone for the timeline's date headings. Fixed so that the
 * server-rendered grouping and the hydrated one agree; the browser's own zone
 * is not known during SSR.
 */
export const DISPLAY_TIME_ZONE = "Asia/Tokyo";

const dayFormatter = new Intl.DateTimeFormat("ja-JP", {
  year: "numeric",
  month: "long",
  day: "numeric",
  weekday: "short",
  timeZone: DISPLAY_TIME_ZONE,
});

const timeFormatter = new Intl.DateTimeFormat("ja-JP", {
  hour: "2-digit",
  minute: "2-digit",
  timeZone: DISPLAY_TIME_ZONE,
});

// The mocks write every date in the Japanese form — 「2025年12月15日」,
// 「2026年9月10日 14:30」 (`spec/design/pages/settings.html`) — so that is
// the shape of both of these. The weekday belongs to the timeline's day
// headings alone, and the year is kept everywhere: a screen that drops it
// (the mocks' 「7月20日 12:30」) would have to read the clock to know which
// year it is showing, which SSR and hydration cannot agree on.
const dateFormatter = new Intl.DateTimeFormat("ja-JP", {
  year: "numeric",
  month: "long",
  day: "numeric",
  timeZone: DISPLAY_TIME_ZONE,
});

const dateTimeFormatter = new Intl.DateTimeFormat("ja-JP", {
  year: "numeric",
  month: "long",
  day: "numeric",
  hour: "2-digit",
  minute: "2-digit",
  timeZone: DISPLAY_TIME_ZONE,
});

/** 「2026年7月22日(水)」 — the timeline's day headings. */
export function formatDay(date: Date): string {
  return dayFormatter.format(date);
}

/** 「2026年7月22日」 — a day with no weekday on it. */
export function formatDate(date: Date): string {
  return dateFormatter.format(date);
}

export function formatTime(date: Date): string {
  return timeFormatter.format(date);
}

/** 「2026年7月22日 12:42」. */
export function formatDateTime(date: Date): string {
  return dateTimeFormatter.format(date);
}

/**
 * The fixed offset of `DISPLAY_TIME_ZONE`. Asia/Tokyo observes no daylight
 * saving, so a calendar day there is always `[00:00+09:00, next 00:00+09:00)`;
 * the two are held together so a change to one is a change to both.
 */
export const DISPLAY_UTC_OFFSET = "+09:00";

const CALENDAR_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

/** `YYYY-MM-DD` naming a real day (`2026-02-30` is not one). */
export function isCalendarDate(value: string): boolean {
  const match = CALENDAR_DATE.exec(value);
  if (!match) return false;
  const [, y, m, d] = match.map(Number) as [number, number, number, number];
  const probe = new Date(Date.UTC(y, m - 1, d));
  return (
    probe.getUTCFullYear() === y &&
    probe.getUTCMonth() === m - 1 &&
    probe.getUTCDate() === d
  );
}

function ymdOf(utc: Date): string {
  return utc.toISOString().slice(0, 10);
}

/**
 * The instants bounding a calendar date in the display time zone: the
 * inputs `jumpToDate` takes (`spec/usecases/memo.md`). The interpretation
 * of a date is the presentation's, which is why it happens here and not in
 * the Durable Object.
 */
export function dayRange(ymd: string): { date: Date; dayEnd: Date } {
  if (!isCalendarDate(ymd)) throw new RangeError(`not a calendar date: ${ymd}`);
  const start = new Date(`${ymd}T00:00:00${DISPLAY_UTC_OFFSET}`);
  const next = new Date(
    Date.UTC(
      Number(ymd.slice(0, 4)),
      Number(ymd.slice(5, 7)) - 1,
      Number(ymd.slice(8, 10)) + 1,
    ),
  );
  return {
    date: start,
    dayEnd: new Date(`${ymdOf(next)}T00:00:00${DISPLAY_UTC_OFFSET}`),
  };
}

/** The calendar date of an instant as the display time zone sees it. */
export function calendarDateOf(instant: Date): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    timeZone: DISPLAY_TIME_ZONE,
  }).format(instant);
  return parts;
}

/** `formatDay` for a `YYYY-MM-DD` of the display time zone. */
export function formatCalendarDate(ymd: string): string {
  return formatDay(dayRange(ymd).date);
}

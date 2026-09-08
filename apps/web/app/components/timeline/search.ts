import { z } from "zod";
import { isCalendarDate } from "@/presentation/time";

/**
 * The URL of P-04 (`spec/pages/index.md`; decisions J-C / J-I of the
 * timeline slice). Every entry falls back to "absent" rather than failing
 * the route, so a hand-typed URL degrades to the plain timeline.
 *
 * - `q`: the keyword filter; removing it is the "clear" action
 * - `date`: a calendar day of the display time zone to jump to; `q` is
 *   kept across the jump
 * - `memo`: show this memo's position; it takes precedence and `q` is
 *   ignored for it (the usecase passes `keyword: null`)
 */
export const timelineSearchSchema = z.object({
  q: z.string().trim().min(1).max(500).optional().catch(undefined),
  date: z.string().refine(isCalendarDate).optional().catch(undefined),
  memo: z.string().trim().min(1).max(200).optional().catch(undefined),
});

export type TimelineSearch = z.infer<typeof timelineSearchSchema>;

export type TimelineMode =
  | Readonly<{ kind: "memo"; memoId: string }>
  | Readonly<{ kind: "date"; date: string; keyword: string | null }>
  | Readonly<{ kind: "list"; keyword: string | null }>;

/** Which read the screen performs for a search, in precedence order. */
export function timelineModeOf(search: TimelineSearch): TimelineMode {
  if (search.memo !== undefined) return { kind: "memo", memoId: search.memo };
  const keyword = search.q ?? null;
  if (search.date !== undefined) {
    return { kind: "date", date: search.date, keyword };
  }
  return { kind: "list", keyword };
}

/** Drops the keys whose value is absent so the URL carries only what is set. */
export function compactSearch(search: TimelineSearch): TimelineSearch {
  const out: { q?: string; date?: string; memo?: string } = {};
  if (search.q !== undefined) out.q = search.q;
  if (search.date !== undefined) out.date = search.date;
  if (search.memo !== undefined) out.memo = search.memo;
  return out;
}

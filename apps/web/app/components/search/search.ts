import { z } from "zod";

/**
 * The URL of P-11 (`spec/pages/index.md`): `q` is the keyword, `topic` the
 * optional scope. Both fall back to "absent" rather than failing the
 * route, so a hand-typed URL degrades to the waiting state. The cursor of
 * 「もっと読む」 is never in the URL (decision §3.2 of PH-04).
 */
export const searchPageSchema = z.object({
  q: z.string().trim().min(1).max(500).optional().catch(undefined),
  topic: z.string().trim().min(1).max(200).optional().catch(undefined),
});

export type SearchPageSearch = z.infer<typeof searchPageSchema>;

/** Drops the keys whose value is absent so the URL carries only what is set. */
export function compactSearch(search: SearchPageSearch): SearchPageSearch {
  const out: { q?: string; topic?: string } = {};
  if (search.q !== undefined) out.q = search.q;
  if (search.topic !== undefined) out.topic = search.topic;
  return out;
}

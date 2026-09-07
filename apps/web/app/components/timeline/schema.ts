import { z } from "zod";

// Transport bounds only; the value objects hold the business rules.
export const postMemoSchema = z.object({
  body: z.string().max(100_000),
});

export const TIMELINE_PAGE_LIMIT = 30;

export const timelinePageSchema = z.object({
  cursor: z.string().min(1).max(512).nullable(),
  direction: z.enum(["older", "newer"]),
  limit: z.number().int().min(1).max(100),
});

export type TimelinePageInput = z.infer<typeof timelinePageSchema>;

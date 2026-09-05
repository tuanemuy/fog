import { z } from "zod";

const optionalText = (max: number) => z.string().max(max).optional();
const date = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .refine((value) => {
    const parsed = new Date(`${value}T00:00:00.000Z`);
    return (
      Number.isFinite(parsed.getTime()) &&
      parsed.toISOString().slice(0, 10) === value
    );
  }, "日付を確認してください")
  .optional();

export const timelineSearchSchema = z
  .object({ keyword: optionalText(200), date, memoId: optionalText(100) })
  .transform((input) => ({
    ...(input.keyword ? { keyword: input.keyword } : {}),
    ...(input.date ? { date: input.date } : {}),
    ...(input.memoId ? { memoId: input.memoId } : {}),
  }));
export type TimelineSearch = z.output<typeof timelineSearchSchema>;
export const timelineQuerySchema = timelineSearchSchema
  .and(
    z.object({
      cursor: optionalText(2048),
      limit: z.number().int().min(1).max(100).optional(),
    }),
  )
  .transform((input) => ({
    ...(input.keyword ? { keyword: input.keyword } : {}),
    ...(input.date ? { date: input.date } : {}),
    ...(input.memoId ? { memoId: input.memoId } : {}),
    ...(input.cursor ? { cursor: input.cursor } : {}),
    ...(input.limit ? { limit: input.limit } : {}),
  }));

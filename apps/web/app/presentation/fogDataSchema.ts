import { z } from "zod";

export const contentTargetSchema = z.object({
  kind: z.enum(["memo", "document", "topic"]),
  id: z.string().min(1).max(128),
});
export const searchSchema = z.object({
  query: z.string().trim().max(500).default(""),
  topicId: z.string().min(1).max(128).optional(),
});
export type FogSearch = z.infer<typeof searchSchema>;
export type ContentTarget = z.infer<typeof contentTargetSchema>;

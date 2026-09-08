import { z } from "zod";
import { isRecord } from "@/presentation/serverFnResult";

/** Transport bound only (DoS); the domain has no upper bound (decision △-4). */
export const changeTrashRetentionDaysSchema = z.object({
  retentionDays: z.number().int().min(1).max(36_500),
});

export type RetentionSavedResult = Readonly<{ retentionDays: number }>;
export function isRetentionSavedResult(
  value: unknown,
): value is RetentionSavedResult {
  return isRecord(value) && typeof value.retentionDays === "number";
}

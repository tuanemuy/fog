import type { TrashRetentionDays } from "@repo/core/domain/identity/valueObject";

const DAY_MS = 86_400_000;

/**
 * The retention deadline and its expiry test (`spec/domains/trash.md`,
 * RetentionPolicy). The deadline is computed once — at soft delete and when
 * the retention changes — and stored as `purgeAfter`; `isExpired` judges the
 * stored value, never a recomputation, so a retention change that has not
 * been recalculated yet cannot disagree with what the index holds. The
 * bulk recalculation in each repository carries the same rule; changing it
 * means changing both.
 */
export const RetentionPolicy = {
  expiresAt: (trashedAt: Date, retentionDays: TrashRetentionDays): Date =>
    new Date(trashedAt.getTime() + retentionDays * DAY_MS),

  isExpired: (purgeAfter: Date, now: Date): boolean =>
    purgeAfter.getTime() < now.getTime(),
};

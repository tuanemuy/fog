import type {
  Pagination,
  PaginationResult,
} from "@repo/core/domain/common/pagination";
import type { TrashItem, TrashItemRef } from "../valueObject";

/**
 * The read side of the trash: a cross-domain projection over the trashed
 * rows of memo / knowledge inside one User Data DO. Read-only by design —
 * restoring and purging go through each domain's own repository
 * (`spec/domains/trash.md`, 書き込みポートについて). Every `expiresAt` is
 * the stored `purge_after`; a topic item carries the documents trashed
 * with it so `HardDeletePolicy.expandTargets` needs no second read.
 */
export interface TrashQueryPort {
  /** Newest deletion first. */
  listTrashItems(pagination: Pagination): PaginationResult<TrashItem>;
  /** `null` when the item is not in the trash (absent, live, or never existed). */
  findTrashItem(ref: TrashItemRef): TrashItem | null;
  countTrashItems(): number;
  /** Stored `purgeAfter` strictly before `now`, earliest first; the purge job's driver. */
  listItemsToPurge(now: Date, limit: number): readonly TrashItem[];
  /** The earliest stored `purgeAfter` across the trash; `null` when it is empty. */
  findEarliestPurgeAfter(): Date | null;
}

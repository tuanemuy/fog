/**
 * The read side of the trash: a cross-domain projection over the trashed
 * rows of memo / knowledge inside one User Data DO. Read-only by design —
 * restoring and purging go through each domain's own repository
 * (`spec/domains/trash.md`, 書き込みポートについて).
 *
 * Only the member the timeline slice needs is declared: the wake-up
 * material for `purge-trash`, read inside the soft-delete transaction. The
 * listing and counting members join with the trash screen.
 */
export interface TrashQueryPort {
  /** The earliest stored `purgeAfter` across the trash; `null` when it is empty. */
  findEarliestPurgeAfter(): Date | null;
}

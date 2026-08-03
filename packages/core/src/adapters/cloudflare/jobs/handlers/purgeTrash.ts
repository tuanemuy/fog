import {
  CHUNK_BUDGETS,
  MIN_RESUME_INTERVAL_MS,
} from "@repo/core/lib/jobBudgets";
import { removeSearchEntry, upsertSearchEntry } from "../../search/projection";
import type { Sql } from "../../sql/exec";
import {
  deleteDocumentRow,
  deleteMemoRow,
  deleteSourceLinksByMemo,
  deleteTopicRow,
  findEarliestPurgeAfter,
  listDocumentsCitingMemo,
  listDocumentsTrashedWithTopic,
  listItemsToPurge,
  readDocumentProjectionSource,
  readTrashRetentionDays,
  recalcPurgeAfterChunk,
  type TrashItem,
} from "../../userData/trashQuery";
import type { JobHandler, UserDataJobContext } from "../registry";

/**
 * Trash retention, as one User Data DO's own alarm rather than a cross-tenant
 * sweep.
 *
 * ## Two phases, in a fixed order
 *
 * 1. recompute `purge_after` for every trashed item;
 * 2. hard-delete the items whose retention has elapsed.
 *
 * **The order is not a preference.** After the retention window is *lengthened*
 * the not-yet-recomputed rows still carry their old, shorter `purge_after`, so
 * running the delete predicate against them destroys items the user just asked
 * to keep. Deferring the deletes to a later wake-up is safe in the other
 * direction: retention promises a *minimum*, so purging late breaks nothing.
 *
 * ## Why the job never falls silent, and never spins
 *
 * The re-arm drive signal is `min(purge_after)` over exactly the same predicate
 * the work uses (`status = 'trashed'`). Reading it **narrower** would let the
 * job settle to `done` after one pass, and a dormant DO would then extend its
 * trash retention indefinitely without a sound; reading it **wider** — for
 * instance forgetting that restore sets `purge_after` back to `NULL` — pins the
 * minimum in the past and buys one alarm write per wake-up, forever, per user.
 *
 * The clamp below is the second half of that guard: a drive signal that is
 * already due while the wake-up found nothing to do can only be a bug, and
 * without the clamp it is a bug that bills.
 */

function purgeMemo(sql: Sql, memoId: string): void {
  // Collected *before* the delete: the FK cascade takes the link rows with it,
  // and after that there is no way to learn which documents cited this memo.
  const citing = listDocumentsCitingMemo(sql, memoId);
  removeSearchEntry(sql, memoId);
  deleteMemoRow(sql, memoId);
  // Redundant against the cascade, and kept anyway: the link table is the one
  // place where a missed row resurfaces as a dangling id inside a document's
  // `source_ids`, which no constraint would catch.
  deleteSourceLinksByMemo(sql, memoId);
  for (const documentId of citing) {
    refreshDocumentProjection(sql, documentId);
  }
}

function purgeDocument(sql: Sql, documentId: string): void {
  removeSearchEntry(sql, documentId);
  deleteDocumentRow(sql, documentId);
}

function purgeTopic(sql: Sql, topicId: string): void {
  for (const documentId of listDocumentsTrashedWithTopic(sql, topicId)) {
    purgeDocument(sql, documentId);
  }
  deleteTopicRow(sql, topicId);
}

/** A topic itself is not projected; only memos and documents are. */
function purgeItem(sql: Sql, item: TrashItem): void {
  if (item.type === "memo") {
    purgeMemo(sql, item.id);
    return;
  }
  if (item.type === "document") {
    purgeDocument(sql, item.id);
    return;
  }
  purgeTopic(sql, item.id);
}

function refreshDocumentProjection(sql: Sql, documentId: string): void {
  const source = readDocumentProjectionSource(sql, documentId);
  if (source === null) {
    removeSearchEntry(sql, documentId);
    return;
  }
  upsertSearchEntry(sql, {
    id: source.id,
    type: "document",
    topicId: source.topicId,
    title: source.title,
    body: source.body,
    timestamp: source.timestamp,
    sourceIds: source.sourceIds,
  });
}

/**
 * @param budget Chunking bounds. Defaulted rather than read inline so that a
 *   test can shrink them: the interesting branch — recomputation running out of
 *   chunks and yielding *without* entering the deletion phase — needs more
 *   trashed rows than a fixture can carry at the shipped budget
 *   (20 × 1000). Production takes the default and passes nothing.
 */
export function createPurgeTrash(
  budget: (typeof CHUNK_BUDGETS)["purge-trash"] = CHUNK_BUDGETS["purge-trash"],
): JobHandler<UserDataJobContext> {
  return async (context) => {
    const { ctx, sql, now, logger } = context;
    let chunks = 0;
    let worked = 0;

    const retentionDays = readTrashRetentionDays(sql);

    // --- phase 1: recomputation ---------------------------------------------
    // The predicate is self-consuming, so no cursor is persisted: an
    // interrupted pass resumes simply by running the same statement again.
    let recalculated = retentionDays === null;
    while (
      !recalculated &&
      retentionDays !== null &&
      chunks < budget.maxChunks
    ) {
      const updated = ctx.storage.transactionSync(() =>
        recalcPurgeAfterChunk(sql, retentionDays, budget.chunkRowLimit, now),
      );
      chunks += 1;
      worked += updated;
      if (updated === 0) recalculated = true;
    }
    if (!recalculated) return { kind: "yield" };

    // --- phase 2: deletion --------------------------------------------------
    while (chunks < budget.maxChunks) {
      const items = listItemsToPurge(sql, now, budget.chunkRowLimit);
      if (items.length === 0) break;
      ctx.storage.transactionSync(() => {
        for (const item of items) {
          purgeItem(sql, item);
        }
      });
      chunks += 1;
      worked += items.length;
    }
    if (listItemsToPurge(sql, now, 1).length > 0) return { kind: "yield" };

    // --- re-arm (class (A)) -------------------------------------------------
    const earliest = findEarliestPurgeAfter(sql);
    if (earliest === null) return { kind: "done" };
    // Unreachable while the two queries agree, and that is the point: `worked
    // === 0` says nothing was recomputed or deleted, while `earliest <= now`
    // says a trashed item is due — and `listItemsToPurge` uses exactly that
    // predicate, so it would have been deleted above. No fixture can reach this
    // branch (checked at every chunk budget, including one row per chunk); what
    // pins the invariant instead is that the suite's recording logger stays
    // empty. If this ever fires, the drive signal and the work predicate have
    // drifted apart and the DO would otherwise wake forever.
    if (earliest <= now && worked === 0) {
      logger.warn(
        "purge-trash found a due drive signal with no work to do; clamping the re-arm",
        { earliest },
      );
      return { kind: "rearm", nextRunAt: now + MIN_RESUME_INTERVAL_MS };
    }
    return { kind: "rearm", nextRunAt: earliest };
  };
}

export const purgeTrash: JobHandler<UserDataJobContext> = createPurgeTrash();

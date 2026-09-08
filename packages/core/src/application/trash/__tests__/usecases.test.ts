import { isValidationError } from "@repo/core/application/errors";
import type { UserDataUnitOfWorkContext } from "@repo/core/application/execution/unitOfWork";
import type {
  DocumentId,
  TopicId,
} from "@repo/core/domain/knowledge/valueObject";
import type { MemoId } from "@repo/core/domain/memo/valueObject";
import type { TrashItem } from "@repo/core/domain/trash/valueObject";
import { describe, expect, it, vi } from "vitest";
import { collectTargets } from "../emptyTrash";
import { checkTrashPagination } from "../listTrash";
import {
  checkPruneBudget,
  pruneExpiredTrashItems,
} from "../pruneExpiredTrashItems";
import type { RunUnitOfWork } from "../shared";

const AT = new Date("2026-09-08T00:00:00Z");

describe("checkTrashPagination / checkPruneBudget", () => {
  it("accepts the bounds and refuses what is outside them", () => {
    expect(checkTrashPagination({ page: 1, limit: 100 })).toEqual({
      page: 1,
      limit: 100,
    });
    for (const bad of [
      { page: 0, limit: 1 },
      { page: 1.5, limit: 1 },
      { page: 1, limit: 0 },
      { page: 1, limit: 101 },
    ]) {
      expect(() => checkTrashPagination(bad)).toThrow(
        expect.toSatisfy(isValidationError),
      );
    }
    expect(checkPruneBudget({ chunkLimit: 1, maxChunks: 1 })).toEqual({
      chunkLimit: 1,
      maxChunks: 1,
    });
    for (const bad of [
      { chunkLimit: 0, maxChunks: 1 },
      { chunkLimit: 1, maxChunks: 0 },
      { chunkLimit: 2.5, maxChunks: 1 },
    ]) {
      expect(() => checkPruneBudget(bad)).toThrow(
        expect.toSatisfy(isValidationError),
      );
    }
  });
});

describe("collectTargets", () => {
  it("expands a set once even when its documents are also listed on their own, documents before memos before topics", () => {
    const items: TrashItem[] = [
      {
        kind: "memo",
        id: "m1" as MemoId,
        excerpt: "",
        trashedAt: AT,
        expiresAt: AT,
      },
      {
        kind: "topic",
        id: "t1" as TopicId,
        name: "n",
        setDocumentIds: ["d1", "d2"] as DocumentId[],
        trashedAt: AT,
        expiresAt: AT,
      },
      {
        kind: "document",
        id: "d1" as DocumentId,
        title: "",
        topicId: "t1" as TopicId,
        deletedWithTopic: true,
        trashedAt: AT,
        expiresAt: AT,
      },
      {
        kind: "document",
        id: "d9" as DocumentId,
        title: "",
        topicId: "t1" as TopicId,
        deletedWithTopic: false,
        trashedAt: AT,
        expiresAt: AT,
      },
    ];
    expect(collectTargets(items)).toEqual([
      { kind: "document", id: "d1" },
      { kind: "document", id: "d2" },
      { kind: "document", id: "d9" },
      { kind: "memo", id: "m1" },
      { kind: "topic", id: "t1" },
    ]);
  });
});

/** A scripted context: recalculation answers from a queue, the purge list from a queue, erasing may throw. */
function fakeRun(script: {
  retentionDays: number | null;
  recalc: boolean[];
  purgeLists: TrashItem[][];
  failOn?: string[];
  earliest?: Date | null;
}) {
  const recalc = [...script.recalc];
  const lists = [...script.purgeLists];
  const erased: string[] = [];
  const ctx = {
    userSettingsRepository: {
      find: () =>
        script.retentionDays === null
          ? null
          : { entity: { trashRetentionDays: script.retentionDays } },
    },
    memoRepository: {
      recalculatePurgeAfter: () => ({
        updatedCount: 0,
        hasMore: recalc.shift() ?? false,
      }),
      findByIdIncludingTrashed: (id: string) => {
        if (script.failOn?.includes(id)) throw new Error(`conflict on ${id}`);
        return { entity: { status: "trashed" }, expectedVersion: 0 };
      },
      hardDelete: (id: string) => {
        erased.push(id);
      },
    },
    topicRepository: {
      recalculatePurgeAfter: () => ({ updatedCount: 0, hasMore: false }),
      findByIdIncludingTrashed: () => null,
    },
    documentRepository: {
      recalculatePurgeAfter: () => ({ updatedCount: 0, hasMore: false }),
      findByIdIncludingTrashed: () => null,
      deleteSourceLinksByMemo: () => undefined,
    },
    trashQueryPort: {
      listItemsToPurge: () => lists.shift() ?? [],
      findEarliestPurgeAfter: () => script.earliest ?? null,
    },
  } as unknown as UserDataUnitOfWorkContext;
  const run: RunUnitOfWork<UserDataUnitOfWorkContext> = (fn) => fn(ctx);
  return { run, erased };
}

const memo = (id: string): TrashItem => ({
  kind: "memo",
  id: id as MemoId,
  excerpt: "",
  trashedAt: AT,
  expiresAt: AT,
});
const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };

describe("pruneExpiredTrashItems", () => {
  it("finishes a pending recalculation first and yields without deleting when the budget runs out on it", () => {
    const { run, erased } = fakeRun({
      retentionDays: 60,
      recalc: [true, true, false],
      purgeLists: [[memo("m1")]],
      earliest: AT,
    });
    const out = pruneExpiredTrashItems(run, {
      now: AT,
      budget: { chunkLimit: 10, maxChunks: 2 },
      logger,
    });
    expect(out).toEqual({
      processedCount: 0,
      failedCount: 0,
      hasMore: true,
      nextPurgeAfter: AT,
    });
    expect(erased).toEqual([]);
  });

  it("deletes after the recalculation is done, within the remaining chunks, and reports what is left", () => {
    const { run, erased } = fakeRun({
      retentionDays: 30,
      recalc: [true, false],
      purgeLists: [
        [memo("m1"), memo("m2")],
        [memo("m3"), memo("m4")],
        [memo("m5")],
      ],
      earliest: AT,
    });
    const out = pruneExpiredTrashItems(run, {
      now: AT,
      budget: { chunkLimit: 2, maxChunks: 4 },
      logger,
    });
    // One chunk of recalculation (the probe that found nothing left is free),
    // then three chunks of deletion; the last was short, so nothing remains.
    expect(erased).toEqual(["m1", "m2", "m3", "m4", "m5"]);
    expect(out).toMatchObject({
      processedCount: 5,
      failedCount: 0,
      hasMore: false,
    });
  });

  it("stops on a short chunk, defers a failing item and counts it", () => {
    const { run, erased } = fakeRun({
      retentionDays: null,
      recalc: [],
      purgeLists: [[memo("m1"), memo("bad")]],
      failOn: ["bad"],
      earliest: null,
    });
    const out = pruneExpiredTrashItems(run, {
      now: AT,
      budget: { chunkLimit: 10, maxChunks: 5 },
      logger,
    });
    expect(erased).toEqual(["m1"]);
    expect(out).toEqual({
      processedCount: 1,
      failedCount: 1,
      hasMore: false,
      nextPurgeAfter: null,
    });
    expect(logger.warn).toHaveBeenCalled();
  });
});

import { inUserDataStorage } from "@repo/core/adapters/cloudflare/__tests__/helpers";
import { createMemoRepository } from "@repo/core/adapters/cloudflare/stores/memoRepository";
import type { RequestContainer } from "@repo/core/application/di/types";
import { postMemo } from "@repo/core/application/memo/postMemo";
import type { MemoView } from "@repo/core/application/memo/view";
import {
  Actor,
  AiClientConnectionId,
  ClientName,
  UserId,
} from "@repo/core/domain/identity/valueObject";
import { Memo } from "@repo/core/domain/memo/entity";
import { MemoId } from "@repo/core/domain/memo/valueObject";
import { expect } from "vitest";

/** The human actor of the account, as the request Worker builds it. */
export function userActor(userId: string) {
  return Actor.user(UserId.create(userId));
}

export function post(
  container: RequestContainer,
  userId: string,
  body: string,
): Promise<MemoView> {
  return postMemo({
    container,
    input: { userId, body, actor: userActor(userId) },
  }).then((output) => output.memo);
}

/**
 * Moves a memo to another instant. The screens cannot post into the past,
 * so the suites that need several days seed them this way.
 */
export function setPostedAt(
  userId: string,
  memoId: string,
  postedAt: Date,
): Promise<void> {
  return inUserDataStorage(userId, (sql) => {
    sql.exec(
      "UPDATE memos SET posted_at = ? WHERE id = ?",
      postedAt.getTime(),
      memoId,
    );
    sql.exec(
      "UPDATE search_entries SET timestamp = ? WHERE id = ?",
      postedAt.getTime(),
      memoId,
    );
  });
}

export async function postAt(
  container: RequestContainer,
  userId: string,
  body: string,
  postedAt: Date,
): Promise<MemoView> {
  const memo = await post(container, userId, body);
  await setPostedAt(userId, memo.id, postedAt);
  return { ...memo, postedAt };
}

/**
 * An edit by an AI client, written the way the AI usecase will write it
 * (that usecase joins with the AI slice). It is what makes the conflict
 * answer carry a client name today.
 */
export function editAsAiClient(
  userId: string,
  memoId: string,
  body: string,
  clientName: string,
): Promise<void> {
  return inUserDataStorage(userId, (sql, _instance, state) => {
    const repository = createMemoRepository(sql, userId);
    const found = repository.findById(MemoId.create(memoId));
    if (found === null) throw new Error("the memo to edit is missing");
    const actor = Actor.aiClient(
      UserId.create(userId),
      AiClientConnectionId.create("connection-1"),
      ClientName.create(clientName),
    );
    const { memo, newRevision } = Memo.edit(
      found.entity,
      { body, actor },
      new Date(),
    );
    state.storage.transactionSync(() => {
      repository.save(memo, found.expectedVersion);
      if (newRevision !== null) repository.insertRevision(newRevision);
    });
  });
}

export type MemoRowSnapshot = Readonly<{
  status: string;
  version: number;
  body: string;
  latest_revision_number: number;
  posted_at: number;
  updated_at: number;
  trashed_at: number | null;
  purge_after: number | null;
}>;

export function readMemoRow(
  userId: string,
  memoId: string,
): Promise<MemoRowSnapshot | undefined> {
  return inUserDataStorage(
    userId,
    (sql) =>
      sql
        .exec<MemoRowSnapshot>(
          "SELECT status, version, body, latest_revision_number, posted_at, updated_at, trashed_at, purge_after FROM memos WHERE id = ?",
          memoId,
        )
        .toArray()[0],
  );
}

export function countRevisions(
  userId: string,
  memoId: string,
): Promise<number> {
  return inUserDataStorage(
    userId,
    (sql) =>
      sql
        .exec<{ n: number }>(
          "SELECT count(*) AS n FROM memo_revisions WHERE memo_id = ?",
          memoId,
        )
        .one().n,
  );
}

/** The FTS hits for `term`, as memo ids. */
export function searchHits(userId: string, term: string): Promise<string[]> {
  return inUserDataStorage(userId, (sql) =>
    sql
      .exec<{ id: string }>(
        "SELECT e.id FROM search_fts f JOIN search_entries e ON e.rowid = f.rowid WHERE search_fts MATCH ?",
        term,
      )
      .toArray()
      .map((row) => row.id),
  );
}

export async function expectCode(
  promise: Promise<unknown>,
  guard: (error: unknown) => boolean,
  code?: string,
): Promise<void> {
  let caught: unknown = null;
  try {
    await promise;
  } catch (error) {
    caught = error;
  }
  expect(caught).not.toBeNull();
  expect(guard(caught)).toBe(true);
  if (code !== undefined) {
    expect((caught as { code: string }).code).toBe(code);
  }
}

/** Newest first, ties broken by id descending — the repository's order. */
export function expectNewestFirst(
  items: readonly { id: string; postedAt: Date }[],
): void {
  for (let i = 1; i < items.length; i += 1) {
    const previous = items[i - 1];
    const current = items[i];
    if (!previous || !current) throw new Error("unreachable");
    const delta = previous.postedAt.getTime() - current.postedAt.getTime();
    expect(delta > 0 || (delta === 0 && previous.id > current.id)).toBe(true);
  }
}

/** A JST wall-clock instant, the display time zone of the timeline. */
export function jst(iso: string): Date {
  return new Date(`${iso}+09:00`);
}

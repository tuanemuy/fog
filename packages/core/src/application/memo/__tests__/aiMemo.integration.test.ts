import { inUserDataStorage } from "@repo/core/adapters/cloudflare/__tests__/helpers";
import {
  createTestContainer,
  registerTestUser,
} from "@repo/core/adapters/cloudflare/__tests__/testContainer";
import {
  isNotFoundError,
  isValidationError,
} from "@repo/core/application/errors";
import type { AiClientActorDto } from "@repo/core/application/identity/actorDto";
import { approveAiClientAuthorization } from "@repo/core/application/identity/approveAiClientAuthorization";
import { deleteMemoByAi } from "@repo/core/application/memo/deleteMemoByAi";
import { getMemo } from "@repo/core/application/memo/getMemo";
import { listMemoRevisions } from "@repo/core/application/memo/listMemoRevisions";
import { postMemoByAi } from "@repo/core/application/memo/postMemoByAi";
import { recentMemos } from "@repo/core/application/memo/recentMemos";
import { updateMemoByAi } from "@repo/core/application/memo/updateMemoByAi";
import { listTrash } from "@repo/core/application/trash/listTrash";
import { describe, expect, it } from "vitest";
import {
  countRevisions,
  expectCode,
  post,
  readMemoRow,
  searchHits,
} from "./memoFixtures";

type RevisionRow = Readonly<{
  revision_number: number;
  actor_type: string;
  actor_connection_id: string | null;
  actor_client_name: string | null;
  body: string;
}>;

function revisionRows(userId: string, memoId: string): Promise<RevisionRow[]> {
  return inUserDataStorage(userId, (sql) =>
    sql
      .exec<RevisionRow>(
        "SELECT revision_number, actor_type, actor_connection_id, actor_client_name, body FROM memo_revisions WHERE memo_id = ? ORDER BY revision_number",
        memoId,
      )
      .toArray(),
  );
}

async function aiActor(
  container: ReturnType<typeof createTestContainer>,
  userId: string,
  clientName = "Claude",
): Promise<AiClientActorDto> {
  const { connectionId } = await approveAiClientAuthorization({
    container,
    input: { userId, clientName },
  });
  return { kind: "aiClient", userId, connectionId, clientName };
}

// R-AI-01 on the memo side, through the real User Data object: the AI
// face writes what the human face writes, the revision names the client,
// and nothing trashed is reachable from it.
describe("the AI memo usecases", () => {
  it("post_memo writes the memo, its first revision under the client's name, and the search projection", async () => {
    const container = createTestContainer();
    const { userId } = await registerTestUser(container);
    const actor = await aiActor(container, userId);

    const { memo } = await postMemoByAi({
      container,
      input: { userId, body: "AI が投稿した pangolin", actor },
    });
    expect(memo.body).toBe("AI が投稿した pangolin");

    expect(await readMemoRow(userId, memo.id)).toMatchObject({
      status: "active",
      version: 0,
      latest_revision_number: 1,
    });
    expect(await revisionRows(userId, memo.id)).toEqual([
      {
        revision_number: 1,
        actor_type: "ai_client",
        actor_connection_id: actor.connectionId,
        actor_client_name: "Claude",
        body: "AI が投稿した pangolin",
      },
    ]);
    expect(await searchHits(userId, "pangolin")).toEqual([memo.id]);

    // P-05 reads the same fact back.
    const history = await listMemoRevisions({
      container,
      input: { userId, memoId: memo.id },
    });
    expect(history.revisions.map((r) => r.actor)).toEqual([
      { kind: "aiClient", clientName: "Claude" },
    ]);
  });

  it("update_memo replaces the whole body as a new revision, and the same body again is `unchanged`", async () => {
    const container = createTestContainer();
    const { userId } = await registerTestUser(container);
    const actor = await aiActor(container, userId, "Cursor");
    const memo = await post(container, userId, "human wrote this");

    const saved = await updateMemoByAi({
      container,
      input: { userId, memoId: memo.id, body: "AI rewrote this", actor },
    });
    expect(saved).toMatchObject({
      result: "saved",
      memo: {
        id: memo.id,
        body: "AI rewrote this",
        postedAt: memo.postedAt,
        latestRevisionNumber: 2,
      },
    });
    const again = await updateMemoByAi({
      container,
      input: { userId, memoId: memo.id, body: "AI rewrote this", actor },
    });
    expect(again.result).toBe("unchanged");
    expect(again.memo.latestRevisionNumber).toBe(2);
    expect(await countRevisions(userId, memo.id)).toBe(2);
    expect(await revisionRows(userId, memo.id)).toMatchObject([
      { revision_number: 1, actor_type: "user", actor_client_name: null },
      {
        revision_number: 2,
        actor_type: "ai_client",
        actor_client_name: "Cursor",
      },
    ]);
    expect(await searchHits(userId, "rewrote")).toEqual([memo.id]);
    expect(await searchHits(userId, "human")).toEqual([]);
  });

  it("recent_memos is the timeline's head, newest first, active only, within its limit", async () => {
    const container = createTestContainer();
    const { userId } = await registerTestUser(container);
    const first = await post(container, userId, "first");
    const second = await post(container, userId, "second");
    const trashed = await post(container, userId, "trashed");
    await deleteMemoByAi({ container, input: { userId, memoId: trashed.id } });

    const page = await recentMemos({ container, input: { userId } });
    expect(page.items.map((m) => m.id)).toEqual([second.id, first.id]);
    expect(page.items[0]).toEqual({
      id: second.id,
      body: "second",
      postedAt: second.postedAt,
    });
    const one = await recentMemos({ container, input: { userId, limit: 1 } });
    expect(one.items.map((m) => m.id)).toEqual([second.id]);
    await expectCode(
      recentMemos({ container, input: { userId, limit: 0 } }),
      isValidationError,
      "INVALID_LIMIT",
    );
  });

  it("delete is the human's soft delete: the memo is in P-12 with its deadline, and gone from every AI read", async () => {
    const container = createTestContainer();
    const { userId } = await registerTestUser(container);
    const actor = await aiActor(container, userId);
    const { memo } = await postMemoByAi({
      container,
      input: { userId, body: "to be trashed wombat", actor },
    });

    await deleteMemoByAi({ container, input: { userId, memoId: memo.id } });

    const row = await readMemoRow(userId, memo.id);
    expect(row?.status).toBe("trashed");
    expect(row?.purge_after).not.toBeNull();
    expect(await searchHits(userId, "wombat")).toEqual([]);
    const trash = await listTrash({
      container,
      input: { userId, page: 1, limit: 20 },
    });
    expect(trash.items.map((item) => [item.kind, item.id])).toEqual([
      ["memo", memo.id],
    ]);

    let caught: unknown = null;
    for (const read of [
      () => getMemo({ container, input: { userId, memoId: memo.id } }),
      () =>
        updateMemoByAi({
          container,
          input: { userId, memoId: memo.id, body: "x", actor },
        }),
      () => deleteMemoByAi({ container, input: { userId, memoId: memo.id } }),
    ]) {
      caught = null;
      try {
        await read();
      } catch (error) {
        caught = error;
      }
      expect(isNotFoundError(caught)).toBe(true);
    }
    expect((await recentMemos({ container, input: { userId } })).items).toEqual(
      [],
    );
    // The revisions stay with the trashed memo; the AI has no way to read them.
    expect(await countRevisions(userId, memo.id)).toBe(1);
  });
});

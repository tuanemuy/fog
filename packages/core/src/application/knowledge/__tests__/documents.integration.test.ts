import { inUserDataStorage } from "@repo/core/adapters/cloudflare/__tests__/helpers";
import {
  createTestContainer,
  registerTestUser,
} from "@repo/core/adapters/cloudflare/__tests__/testContainer";
import type { RequestContainer } from "@repo/core/application/di/types";
import {
  isConflictError,
  isNotFoundError,
  isValidationError,
} from "@repo/core/application/errors";
import { diffDocumentRevisions } from "@repo/core/application/knowledge/diffDocumentRevisions";
import { editDocument } from "@repo/core/application/knowledge/editDocument";
import { getDocument } from "@repo/core/application/knowledge/getDocument";
import { listDocumentRevisions } from "@repo/core/application/knowledge/listDocumentRevisions";
import { rollbackDocument } from "@repo/core/application/knowledge/rollbackDocument";
import { trashDocument } from "@repo/core/application/knowledge/trashDocument";
import { trashTopic } from "@repo/core/application/knowledge/trashTopic";
import { softDeleteMemo } from "@repo/core/application/memo/softDeleteMemo";
import { isBusinessRuleError } from "@repo/core/domain/error";
import { DOCUMENT_BODY_MAX_CODE_POINTS } from "@repo/core/domain/knowledge/valueObject";
import { describe, expect, it } from "vitest";
import {
  document,
  editDocumentAsAiClient,
  expectCode,
  ftsHits,
  post,
  readDocumentRow,
  readTopicRow,
  revisionRows,
  searchEntry,
  topic,
  userActor,
} from "./knowledgeFixtures";

function edit(
  container: RequestContainer,
  userId: string,
  documentId: string,
  fields: {
    title: string;
    body: string;
    expectedVersion: number;
    changeReason?: string | null;
  },
) {
  return editDocument({
    container,
    input: { userId, actor: userActor(userId), documentId, ...fields },
  });
}

describe("createDocument", () => {
  it("(a) writes the row, revision #1, the links and both sides of the projection, touching the topic", async () => {
    const container = createTestContainer();
    const { userId } = await registerTestUser(container);
    const t = await topic(container, userId);
    const m1 = await post(container, userId, "source one zebra");
    const m2 = await post(container, userId, "source two");
    const created = await document(container, userId, t.id, {
      title: "設計メモ",
      body: "本文 quokka",
      sourceMemoIds: [m1.id, m2.id, m1.id],
      changeReason: "初稿",
    });
    expect(created).toMatchObject({
      topicId: t.id,
      title: "設計メモ",
      latestRevision: 1,
      version: 0,
      sourceMemoIds: [m1.id, m2.id],
    });
    expect(await revisionRows(userId, created.id)).toEqual([
      {
        revision_number: 1,
        actor_type: "user",
        change_reason: "初稿",
        body: "本文 quokka",
      },
    ]);
    await inUserDataStorage(userId, (sql) => {
      expect(
        sql
          .exec<{ memo_id: string }>(
            "SELECT memo_id FROM source_links WHERE document_id = ? ORDER BY memo_id",
            created.id,
          )
          .toArray()
          .map((r) => r.memo_id),
      ).toEqual([m1.id, m2.id].sort());
    });
    expect(await searchEntry(userId, created.id)).toEqual({
      type: "document",
      topicId: t.id,
      title: "設計メモ",
      sourceIds: [m1.id, m2.id].sort(),
    });
    expect((await searchEntry(userId, m1.id))?.sourceIds).toEqual([created.id]);
    expect(await ftsHits(userId, "quokka")).toEqual([created.id]);
    expect(await ftsHits(userId, "設計メモ")).toEqual([created.id]);
    expect(await ftsHits(userId, "zebra")).toEqual([m1.id]);
    // The topic was touched: version up, content unchanged.
    expect(await readTopicRow(userId, t.id)).toMatchObject({
      version: 1,
      name: "読書メモ",
    });
  });

  it("(b) defaults the change reason, accepts an empty body and an archived topic, and holds the body bound in code points", async () => {
    const container = createTestContainer();
    const { userId } = await registerTestUser(container);
    const t = await topic(container, userId);
    const plain = await document(container, userId, t.id, {
      body: "",
      changeReason: "  ",
    });
    expect(plain.body).toBe("");
    expect((await revisionRows(userId, plain.id))[0]?.change_reason).toBe(
      "作成",
    );

    const exactly = "𠮷".repeat(DOCUMENT_BODY_MAX_CODE_POINTS);
    expect(exactly.length).toBe(DOCUMENT_BODY_MAX_CODE_POINTS * 2);
    expect(
      (await document(container, userId, t.id, { body: exactly })).body,
    ).toHaveLength(exactly.length);
    await expectCode(
      document(container, userId, t.id, {
        body: "あ".repeat(DOCUMENT_BODY_MAX_CODE_POINTS + 1),
      }),
      isBusinessRuleError,
      "DOCUMENT_BODY_TOO_LONG",
    );
    await expectCode(
      document(container, userId, t.id, { title: " " }),
      isBusinessRuleError,
      "EMPTY_DOCUMENT_TITLE",
    );
    await expectCode(
      document(container, userId, t.id, { title: "あ".repeat(201) }),
      isBusinessRuleError,
      "DOCUMENT_TITLE_TOO_LONG",
    );
    await expectCode(
      document(container, userId, t.id, { changeReason: "a\nb" }),
      isBusinessRuleError,
      "CHANGE_REASON_MULTILINE",
    );

    const { updateTopic } = await import(
      "@repo/core/application/knowledge/updateTopic"
    );
    await updateTopic({
      container,
      input: { userId, topicId: t.id, archived: true },
    });
    expect((await document(container, userId, t.id)).topicId).toBe(t.id);
  });

  it("(c) fails whole when the topic or any source memo is missing or trashed, writing nothing", async () => {
    const container = createTestContainer();
    const { userId } = await registerTestUser(container);
    const t = await topic(container, userId);
    const ok = await post(container, userId, "fine");
    const trashed = await post(container, userId, "gone");
    await softDeleteMemo({ container, input: { userId, memoId: trashed.id } });

    await expectCode(
      document(container, userId, "no-topic"),
      isNotFoundError,
      "TOPIC_NOT_FOUND",
    );
    await expectCode(
      document(container, userId, t.id, { sourceMemoIds: [ok.id, "no-memo"] }),
      isNotFoundError,
      "MEMO_NOT_FOUND",
    );
    await expectCode(
      document(container, userId, t.id, { sourceMemoIds: [ok.id, trashed.id] }),
      isNotFoundError,
      "MEMO_NOT_FOUND",
    );
    await expectCode(
      document(container, userId, t.id, { sourceMemoIds: [""] }),
      isBusinessRuleError,
      "INVALID_MEMO_ID",
    );
    const gone = await topic(container, userId, "to trash");
    await trashTopic({ container, input: { userId, topicId: gone.id } });
    await expectCode(
      document(container, userId, gone.id),
      isNotFoundError,
      "TOPIC_NOT_FOUND",
    );
    await inUserDataStorage(userId, (sql) => {
      expect(
        sql.exec<{ n: number }>("SELECT count(*) AS n FROM documents").one().n,
      ).toBe(0);
      expect(
        sql.exec<{ n: number }>("SELECT count(*) AS n FROM source_links").one()
          .n,
      ).toBe(0);
    });
    expect(await readTopicRow(userId, t.id)).toMatchObject({ version: 0 });
  });
});

describe("getDocument / editDocument", () => {
  it("(d) saves a new revision, re-projects, leaves the same content alone and treats a title-only change as a change", async () => {
    const container = createTestContainer();
    const { userId } = await registerTestUser(container);
    const t = await topic(container, userId);
    const created = await document(container, userId, t.id, {
      body: "alpha body",
    });
    expect(
      await getDocument({
        container,
        input: { userId, documentId: created.id },
      }),
    ).toMatchObject({
      id: created.id,
      body: "alpha body",
      version: 0,
    });

    const saved = await edit(container, userId, created.id, {
      title: "タイトル",
      body: "bravo body",
      expectedVersion: 0,
      changeReason: "構成を見直し",
    });
    expect(saved).toMatchObject({
      result: "saved",
      latestRevision: 2,
      version: 1,
      conflict: null,
    });
    expect(await readDocumentRow(userId, created.id)).toMatchObject({
      version: 1,
      body: "bravo body",
      latest_revision_number: 2,
    });
    expect(
      (await revisionRows(userId, created.id)).map((r) => [
        r.revision_number,
        r.change_reason,
      ]),
    ).toEqual([
      [1, "作成"],
      [2, "構成を見直し"],
    ]);
    expect(await ftsHits(userId, "bravo")).toEqual([created.id]);
    expect(await ftsHits(userId, "alpha")).toEqual([]);

    const unchanged = await edit(container, userId, created.id, {
      title: "タイトル",
      body: "bravo body",
      expectedVersion: 1,
    });
    expect(unchanged).toMatchObject({
      result: "unchanged",
      latestRevision: 2,
      version: 1,
    });
    expect(await revisionRows(userId, created.id)).toHaveLength(2);

    const titled = await edit(container, userId, created.id, {
      title: "改題",
      body: "bravo body",
      expectedVersion: 1,
    });
    expect(titled).toMatchObject({
      result: "saved",
      latestRevision: 3,
      version: 2,
    });
    expect((await revisionRows(userId, created.id))[2]?.change_reason).toBe(
      "手動編集",
    );
    expect((await searchEntry(userId, created.id))?.title).toBe("改題");
  });

  it("(e) answers a conflict without writing, then applies on top with the current version", async () => {
    const container = createTestContainer();
    const { userId } = await registerTestUser(container);
    const t = await topic(container, userId);
    const created = await document(container, userId, t.id, {
      body: "original",
    });
    await editDocumentAsAiClient(
      userId,
      created.id,
      "AI rewrote this",
      "Claude",
      "要約を追加",
    );

    const conflict = await edit(container, userId, created.id, {
      title: "タイトル",
      body: "mine",
      expectedVersion: 0,
    });
    expect(conflict).toMatchObject({
      result: "conflict",
      latestRevision: 2,
      version: 1,
      conflict: {
        currentTitle: "タイトル",
        currentBody: "AI rewrote this",
        currentVersion: 1,
        latestRevision: {
          revisionNumber: 2,
          actor: { kind: "aiClient", clientName: "Claude" },
          changeReason: "要約を追加",
        },
      },
    });
    expect(await revisionRows(userId, created.id)).toHaveLength(2);

    const saved = await edit(container, userId, created.id, {
      title: "タイトル",
      body: "mine",
      expectedVersion: 1,
    });
    expect(saved).toMatchObject({
      result: "saved",
      latestRevision: 3,
      version: 2,
    });
    expect(
      (await revisionRows(userId, created.id)).map((r) => r.actor_type),
    ).toEqual(["user", "ai_client", "user"]);
  });

  it("(f) holds the invariants and NotFound, and surfaces OCC past the conflict check", async () => {
    const container = createTestContainer();
    const { userId } = await registerTestUser(container);
    const t = await topic(container, userId);
    const created = await document(container, userId, t.id);
    await expectCode(
      edit(container, userId, created.id, {
        title: "",
        body: "x",
        expectedVersion: 0,
      }),
      isBusinessRuleError,
      "EMPTY_DOCUMENT_TITLE",
    );
    await expectCode(
      edit(container, userId, created.id, {
        title: "t",
        body: "あ".repeat(DOCUMENT_BODY_MAX_CODE_POINTS + 1),
        expectedVersion: 0,
      }),
      isBusinessRuleError,
      "DOCUMENT_BODY_TOO_LONG",
    );
    await expectCode(
      edit(container, userId, "nope", {
        title: "t",
        body: "x",
        expectedVersion: 0,
      }),
      isNotFoundError,
      "DOCUMENT_NOT_FOUND",
    );
    await expectCode(
      edit(container, userId, " ", {
        title: "t",
        body: "x",
        expectedVersion: 0,
      }),
      isBusinessRuleError,
      "INVALID_DOCUMENT_ID",
    );

    await inUserDataStorage(userId, (sql) => {
      sql.exec(
        "CREATE TRIGGER occ_probe BEFORE UPDATE ON documents BEGIN SELECT RAISE(IGNORE); END",
      );
    });
    await expectCode(
      edit(container, userId, created.id, {
        title: "t",
        body: "x",
        expectedVersion: 0,
      }),
      isConflictError,
      "OPTIMISTIC_LOCK_FAILURE",
    );
    await inUserDataStorage(userId, (sql) => {
      sql.exec("DROP TRIGGER occ_probe");
    });
    expect(await revisionRows(userId, created.id)).toHaveLength(1);

    await trashDocument({
      container,
      input: { userId, documentId: created.id },
    });
    await expectCode(
      edit(container, userId, created.id, {
        title: "t",
        body: "x",
        expectedVersion: 1,
      }),
      isNotFoundError,
      "DOCUMENT_NOT_FOUND",
    );
    await expectCode(
      getDocument({ container, input: { userId, documentId: created.id } }),
      isNotFoundError,
      "DOCUMENT_NOT_FOUND",
    );
  });

  it("(g) turns a duplicate revision number into the OCC conflict", async () => {
    const container = createTestContainer();
    const { userId } = await registerTestUser(container);
    const t = await topic(container, userId);
    const created = await document(container, userId, t.id);
    await inUserDataStorage(userId, (sql) => {
      sql.exec(
        "INSERT INTO document_revisions (id, document_id, revision_number, title, body, actor_type, actor_connection_id, actor_client_name, change_reason, created_at) VALUES ('stray', ?, 2, 't', 'b', 'user', NULL, NULL, 'x', 0)",
        created.id,
      );
    });
    await expectCode(
      edit(container, userId, created.id, {
        title: "t",
        body: "changed",
        expectedVersion: 0,
      }),
      isConflictError,
      "OPTIMISTIC_LOCK_FAILURE",
    );
    expect(await readDocumentRow(userId, created.id)).toMatchObject({
      version: 0,
      body: "本文",
    });
  });
});

describe("listDocumentRevisions / diffDocumentRevisions / rollbackDocument", () => {
  async function threeRevisions(container: RequestContainer, userId: string) {
    const t = await topic(container, userId);
    const created = await document(container, userId, t.id, {
      title: "one",
      body: "first",
    });
    await editDocumentAsAiClient(
      userId,
      created.id,
      "second",
      "Claude",
      "AI が追記",
    );
    const third = await edit(container, userId, created.id, {
      title: "three",
      body: "third",
      expectedVersion: 1,
    });
    expect(third.result).toBe("saved");
    return created;
  }

  it("(h) lists who / when / why ascending without bodies, also for a trashed document", async () => {
    const container = createTestContainer();
    const { userId } = await registerTestUser(container);
    const created = await threeRevisions(container, userId);
    const view = await listDocumentRevisions({
      container,
      input: { userId, documentId: created.id },
    });
    expect(view.latestRevision).toBe(3);
    expect(
      view.revisions.map((r) => [r.revisionNumber, r.actor, r.changeReason]),
    ).toEqual([
      [1, { kind: "user" }, "作成"],
      [2, { kind: "aiClient", clientName: "Claude" }, "AI が追記"],
      [3, { kind: "user" }, "手動編集"],
    ]);
    for (const r of view.revisions) {
      expect(Object.keys(r).sort()).toEqual([
        "actor",
        "changeReason",
        "createdAt",
        "revisionNumber",
      ]);
    }
    await trashDocument({
      container,
      input: { userId, documentId: created.id },
    });
    expect(
      (
        await listDocumentRevisions({
          container,
          input: { userId, documentId: created.id },
        })
      ).revisions,
    ).toHaveLength(3);
    await expectCode(
      listDocumentRevisions({
        container,
        input: { userId, documentId: "nope" },
      }),
      isNotFoundError,
      "DOCUMENT_NOT_FOUND",
    );
  });

  it("(i) returns the two snapshots as asked and refuses the same or a missing revision", async () => {
    const container = createTestContainer();
    const { userId } = await registerTestUser(container);
    const created = await threeRevisions(container, userId);
    const diff = (base: number, target: number) =>
      diffDocumentRevisions({
        container,
        input: {
          userId,
          documentId: created.id,
          baseRevisionNumber: base,
          targetRevisionNumber: target,
        },
      });
    const forward = await diff(1, 3);
    expect(forward.base).toMatchObject({
      revisionNumber: 1,
      title: "one",
      body: "first",
      actor: { kind: "user" },
    });
    expect(forward.target).toMatchObject({
      revisionNumber: 3,
      title: "three",
      body: "third",
    });
    expect((await diff(3, 1)).base.revisionNumber).toBe(3);
    expect((await diff(1, 2)).target.actor).toEqual({
      kind: "aiClient",
      clientName: "Claude",
    });
    await expectCode(diff(2, 2), isValidationError, "SAME_REVISION");
    await expectCode(diff(1, 4), isNotFoundError, "REVISION_NOT_FOUND");
    await expectCode(
      diff(0, 1),
      isBusinessRuleError,
      "INVALID_REVISION_NUMBER",
    );
    await expectCode(
      diff(1, 1.5),
      isBusinessRuleError,
      "INVALID_REVISION_NUMBER",
    );
  });

  it("(j) rolls back as a new revision, keeps the history, and is a no-op on the same content", async () => {
    const container = createTestContainer();
    const { userId } = await registerTestUser(container);
    const created = await threeRevisions(container, userId);
    const rollback = (revisionNumber: number, changeReason?: string) =>
      rollbackDocument({
        container,
        input: {
          userId,
          actor: userActor(userId),
          documentId: created.id,
          revisionNumber,
          changeReason: changeReason ?? null,
        },
      });
    const rolled = await rollback(1);
    expect(rolled).toMatchObject({
      changed: true,
      latestRevision: 4,
      version: 3,
    });
    expect(await readDocumentRow(userId, created.id)).toMatchObject({
      title: "one",
      body: "first",
      latest_revision_number: 4,
    });
    const rows = await revisionRows(userId, created.id);
    expect(
      rows.map((r) => [r.revision_number, r.change_reason, r.actor_type]),
    ).toEqual([
      [1, "作成", "user"],
      [2, "AI が追記", "ai_client"],
      [3, "手動編集", "user"],
      [4, "リビジョン1の内容に戻す", "user"],
    ]);
    expect(await ftsHits(userId, "first")).toEqual([created.id]);
    expect(await rollback(1)).toMatchObject({
      changed: false,
      latestRevision: 4,
    });
    expect(await rollback(4)).toMatchObject({ changed: false });
    expect((await rollback(2, "戻す")).changed).toBe(true);
    expect((await revisionRows(userId, created.id))[4]?.change_reason).toBe(
      "戻す",
    );
    await expectCode(rollback(99), isNotFoundError, "REVISION_NOT_FOUND");
    await expectCode(
      rollback(0),
      isBusinessRuleError,
      "INVALID_REVISION_NUMBER",
    );
    await trashDocument({
      container,
      input: { userId, documentId: created.id },
    });
    await expectCode(rollback(1), isNotFoundError, "DOCUMENT_NOT_FOUND");
  });
});

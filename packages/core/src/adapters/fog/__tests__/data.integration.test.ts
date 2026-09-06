import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { type Client, createClient } from "@libsql/client";
import { createFogServices } from "@repo/core/application/fog/services";
import { purgeExpiredTrash } from "@repo/core/application/fog/trashServices";
import type {
  Actor,
  FogServices,
  HumanActor,
} from "@repo/core/application/fog/types";
import { UuidV7Generator } from "@repo/core/application/ports/idGenerator";
import { afterEach, beforeEach, expect, test } from "vitest";
import { nodeSecretCrypto } from "../crypto";
import { fogSchema, migrateFog } from "../schema";
import { LibsqlFogUnitOfWork } from "../unitOfWork";

let dir: string;
let client: Client;
let services: FogServices;
let now: Date;
let a: HumanActor;
let b: HumanActor;
const clock = { now: () => now };
beforeEach(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), "fog-data-"));
  client = createClient({ url: `file:${dir}/app.db` });
  await client.execute("PRAGMA foreign_keys=ON");
  await migrateFog(client);
  now = new Date("2026-09-05T09:00:00.000Z");
  services = await createFogServices({
    unitOfWork: new LibsqlFogUnitOfWork(client),
    crypto: nodeSecretCrypto,
    clock,
    ids: UuidV7Generator,
  });
  a = (
    await services.register({
      email: "a@example.com",
      password: "long-enough-password",
    })
  ).user;
  b = (
    await services.register({
      email: "b@example.com",
      password: "long-enough-password",
    })
  ).user;
});
afterEach(async () => {
  client.close();
  await rm(dir, { recursive: true, force: true });
});
const ai = (): Actor => ({
  kind: "ai",
  userId: a.userId,
  clientId: "ai-1",
  clientName: "AI",
});
const topic = (actor = a) =>
  services.createTopic(actor, { title: "日本語 調査", description: "説明" });
const memo = (body = "日本語 原文のメモ", actor = a) =>
  services.createMemo(actor, { body });
const doc = (topicId: string, sourceMemoIds: string[] = [], actor = a) =>
  services.createDocument(actor, {
    topicId,
    title: "日本語 文書",
    body: "これは日本語の原文です。",
    sourceMemoIds,
  });
const remove = (
  kind: "memo" | "document" | "topic",
  item: { id: string; version: number },
  actor = a,
) =>
  services.softDelete(actor, {
    kind,
    id: item.id,
    expectedVersion: item.version,
  });
const count = async (table: string, where = "1=1") =>
  Number(
    (await client.execute(`SELECT count(*) n FROM ${table} WHERE ${where}`))
      .rows[0]?.n,
  );

test("topic deletion records an exact set, keeps source tombstones, and restores only that set", async () => {
  const t = await topic();
  const m = await memo();
  const first = await doc(t.id, [m.id]);
  const second = await doc(t.id, [m.id]);
  await remove("document", first);
  await remove("topic", t);
  const trash = await services.trash(a);
  expect(trash.retentionDays).toBe(30);
  expect(trash.items).toHaveLength(3);
  const parent = trash.items.find((x) => x.id === t.id);
  expect(parent?.setDocumentIds).toEqual([second.id]);
  expect(trash.items.every((x) => x.remainingDays === 30)).toBe(true);
  expect((await services.getMemo(a, m.id)).sourceDocuments).toEqual(
    expect.arrayContaining([
      { id: first.id, title: first.title, deleted: true },
      { id: second.id, title: second.title, deleted: true },
    ]),
  );
  await services.restore(a, { kind: "topic", id: t.id });
  expect((await services.getTopic(a, t.id)).documents.map((x) => x.id)).toEqual(
    [second.id],
  );
  expect((await services.trash(a)).items.map((x) => x.id)).toEqual([first.id]);
  expect(
    (await services.getMemo(a, m.id)).sourceDocuments.find(
      (x) => x.id === second.id,
    )?.deleted,
  ).toBe(false);
});

test("document restore requires explicit parent-set confirmation and also restores the explicitly selected prior deletion", async () => {
  const t = await topic();
  const first = await doc(t.id);
  const second = await doc(t.id);
  await remove("document", first);
  await remove("topic", t);
  await expect(
    services.restore(a, { kind: "document", id: first.id }),
  ).rejects.toMatchObject({ code: "TOPIC_RESTORE_CONFIRMATION_REQUIRED" });
  expect((await services.trash(a)).items).toHaveLength(3);
  await services.restore(a, {
    kind: "document",
    id: first.id,
    restoreTopicSet: true,
  });
  expect(
    (await services.getTopic(a, t.id)).documents.map((x) => x.id).sort(),
  ).toEqual([first.id, second.id].sort());
  expect((await services.trash(a)).items).toEqual([]);
});

test("hard-deleted topic erases set history, preserves prior orphan history and links, and allows a chosen existing or new parent", async () => {
  const t = await topic();
  const m = await memo();
  const orphan = await doc(t.id, [m.id]);
  const otherOrphan = await doc(t.id);
  const set = await doc(t.id, [m.id]);
  await remove("document", orphan);
  await remove("document", otherOrphan);
  await remove("topic", t);
  await services.hardDelete(a, { kind: "topic", id: t.id });
  expect(await count("fog_topics")).toBe(0);
  expect(await count("fog_document_revisions", `document_id='${set.id}'`)).toBe(
    0,
  );
  expect(
    await count("fog_document_revisions", `document_id='${orphan.id}'`),
  ).toBe(1);
  expect(
    (await services.trash(a)).items.find((x) => x.id === orphan.id)?.topic,
  ).toEqual({ kind: "missing" });
  await expect(
    services.restore(a, { kind: "document", id: orphan.id }),
  ).rejects.toMatchObject({ code: "RESTORE_TOPIC_REQUIRED" });
  const foreign = await topic(b);
  await expect(
    services.restore(a, {
      kind: "document",
      id: orphan.id,
      targetTopic: { kind: "existing", id: foreign.id },
    }),
  ).rejects.toMatchObject({ code: "TOPIC_NOT_FOUND" });
  await expect(
    services.restore(a, {
      kind: "document",
      id: orphan.id,
      targetTopic: { kind: "new", title: " ", description: "" },
    }),
  ).rejects.toMatchObject({ code: "INVALID_TITLE" });
  expect(await count("fog_topics")).toBe(1);
  const destination = await topic();
  await services.restore(a, {
    kind: "document",
    id: orphan.id,
    targetTopic: { kind: "existing", id: destination.id },
  });
  expect((await services.getDocument(a, orphan.id)).topicId).toBe(
    destination.id,
  );
  expect((await services.getDocument(a, orphan.id)).sourceMemos[0]?.id).toBe(
    m.id,
  );
  await services.restore(a, {
    kind: "document",
    id: otherOrphan.id,
    targetTopic: { kind: "new", title: "新しい復元先", description: "移動" },
  });
  expect(
    (
      await services.getTopic(
        a,
        (
          await services.getDocument(a, otherOrphan.id)
        ).topicId,
      )
    ).topic.title,
  ).toBe("新しい復元先");
  expect((await client.execute("PRAGMA foreign_key_check")).rows).toEqual([]);
});

test("memo restoration preserves timestamp/history and reconnects source; hard deletion erases revisions and references", async () => {
  const t = await topic();
  const m = await memo();
  const d = await doc(t.id, [m.id]);
  now = new Date(now.getTime() + 1000);
  const edited = await services.editMemo(a, {
    id: m.id,
    body: "更新した原文",
    expectedVersion: 1,
  });
  await remove("memo", edited);
  expect((await services.getDocument(a, d.id)).sourceMemos[0]?.deleted).toBe(
    true,
  );
  await services.restore(a, { kind: "memo", id: m.id });
  expect((await services.getMemo(a, m.id)).createdAt).toBe(m.createdAt);
  expect(await services.memoHistory(a, m.id)).toHaveLength(2);
  expect((await services.getDocument(a, d.id)).sourceMemos[0]?.deleted).toBe(
    false,
  );
  await expect(
    services.hardDelete(a, { kind: "memo", id: m.id }),
  ).rejects.toMatchObject({ code: "TRASH_NOT_FOUND" });
  await remove("memo", edited);
  await services.hardDelete(a, { kind: "memo", id: m.id });
  expect(await count("fog_memo_revisions")).toBe(0);
  expect((await services.getDocument(a, d.id)).sourceMemos).toEqual([]);
});

test("owner boundaries apply to all trash mutations, search, settings and export", async () => {
  const m = await memo();
  const t = await topic();
  await remove("memo", m);
  expect((await services.trash(b)).items).toEqual([]);
  for (const operation of [
    () => services.restore(b, { kind: "memo", id: m.id }),
    () => services.hardDelete(b, { kind: "memo", id: m.id }),
    () => remove("topic", t, b),
  ])
    await expect(operation()).rejects.toMatchObject({ name: "NotFoundError" });
  await services.emptyTrash(b);
  expect((await services.trash(a)).items).toHaveLength(1);
  await services.setRetentionDays(b, { retentionDays: 3 });
  expect((await services.getSettings(a)).retentionDays).toBe(30);
  expect((await services.search(b, { query: "日本語" })).items).toEqual([]);
  expect((await services.exportData(b)).topics).toEqual([]);
});

test("empty trash affects only trash and preserves completed active topics", async () => {
  const t = await topic();
  const d = await doc(t.id);
  const deleted = await memo();
  const active = await memo("生存");
  await services.updateTopic(a, {
    id: t.id,
    title: t.title,
    description: t.description,
    completed: true,
    expectedVersion: t.version,
  });
  await remove("document", d);
  await remove("memo", deleted);
  await services.emptyTrash(a);
  expect((await services.trash(a)).items).toEqual([]);
  expect((await services.getTopic(a, t.id)).topic.completed).toBe(true);
  expect((await services.getMemo(a, active.id)).id).toBe(active.id);
  expect(await count("fog_document_revisions")).toBe(0);
});

test("retention worker uses injected clock and every owner current retention at the exact boundary", async () => {
  const old = await memo();
  const other = await memo("別ユーザー", b);
  const t = await topic();
  const d = await doc(t.id);
  await remove("memo", old);
  await remove("memo", other, b);
  await remove("topic", t);
  const completed = await topic();
  await services.updateTopic(a, {
    ...completed,
    completed: true,
    expectedVersion: completed.version,
  });
  await services.setRetentionDays(a, { retentionDays: 2 });
  now = new Date(now.getTime() + 2 * 86_400_000 - 1);
  const deps = { unitOfWork: new LibsqlFogUnitOfWork(client), clock };
  expect(await purgeExpiredTrash(deps)).toEqual({ deletedCount: 0 });
  expect(
    (await services.trash(a)).items.every((x) => x.remainingDays === 1),
  ).toBe(true);
  now = new Date(now.getTime() + 1);
  expect(await purgeExpiredTrash(deps)).toEqual({ deletedCount: 3 });
  expect((await services.trash(a)).items).toEqual([]);
  expect((await services.trash(b)).items).toHaveLength(1);
  expect((await services.getTopic(a, completed.id)).topic.completed).toBe(true);
  expect(await count("fog_document_revisions", `document_id='${d.id}'`)).toBe(
    0,
  );
  await services.setRetentionDays(b, { retentionDays: 1 });
  expect(await purgeExpiredTrash(deps)).toEqual({ deletedCount: 1 });
});

test("retention values reject zero, fractions, infinities and out-of-range numbers without changing settings", async () => {
  for (const retentionDays of [
    0,
    -1,
    1.1,
    3651,
    Number.NaN,
    Number.POSITIVE_INFINITY,
  ])
    await expect(
      services.setRetentionDays(a, { retentionDays }),
    ).rejects.toMatchObject({ code: "INVALID_RETENTION_DAYS" });
  expect(await services.getSettings(a)).toEqual({ retentionDays: 30 });
});

test("Japanese cross-content search includes completed topics and latest edits, excludes trash, scopes documents and source memos, returns original snippets and active source IDs", async () => {
  const t = await topic();
  const source = await memo();
  const unrelated = await memo();
  const d = await doc(t.id, [source.id]);
  await services.updateTopic(a, {
    ...t,
    completed: true,
    expectedVersion: t.version,
  });
  expect((await services.search(a, { query: "日本語" })).items).toHaveLength(3);
  const scoped = await services.search(ai(), {
    query: "日本語",
    topicId: t.id,
  });
  expect(scoped.items.map((x) => x.id).sort()).toEqual(
    [source.id, d.id].sort(),
  );
  expect(scoped.items.find((x) => x.id === d.id)).toMatchObject({
    topicTitle: t.title,
    sourceIds: [source.id],
    snippet: d.body,
  });
  const edited = await services.editMemo(a, {
    id: source.id,
    body: "新規キーワード 特許",
    expectedVersion: 1,
  });
  expect((await services.search(a, { query: "特許" })).items[0]?.id).toBe(
    source.id,
  );
  expect(
    (await services.search(a, { query: "日本語", topicId: t.id })).items.map(
      (x) => x.id,
    ),
  ).toEqual([d.id]);
  await remove("memo", edited);
  await remove("memo", unrelated);
  expect(
    (await services.search(ai(), { query: "日本語" })).items[0]?.sourceIds,
  ).toEqual([]);
  await remove("document", d);
  expect((await services.search(a, { query: "日本語" })).items).toEqual([]);
  expect(
    await services.search(a, {
      query: "  ",
      topicId: "not-found",
      cursor: "bad",
    }),
  ).toEqual({ items: [], nextCursor: null });
  expect((await services.search(a, { query: "%_" })).items).toEqual([]);
});

test("search keysets stay stable across ties, edits, insertion, and reject cursors from different query or scope", async () => {
  const t = await topic();
  const expected: string[] = [];
  for (let i = 0; i < 8; i++)
    expected.push((i % 2 === 0 ? await memo() : await doc(t.id)).id);
  const first = await services.search(a, { query: "日本語", limit: 3 });
  expect(first.nextCursor).not.toBeNull();
  await memo();
  const editedId = expected[0];
  if (!editedId) throw new Error("fixture");
  await services.editMemo(a, {
    id: editedId,
    body: "日本語 編集後",
    expectedVersion: 1,
  });
  const all = [...first.items];
  let cursor = first.nextCursor;
  while (cursor) {
    const page = await services.search(a, {
      query: "日本語",
      limit: 3,
      cursor,
    });
    all.push(...page.items);
    cursor = page.nextCursor;
  }
  expect(all.map((x) => x.id)).toEqual(expected.reverse());
  expect(new Set(all.map((x) => x.id)).size).toBe(8);
  await expect(
    services.search(a, { query: "違う", cursor: first.nextCursor ?? "" }),
  ).rejects.toMatchObject({ code: "INVALID_CURSOR" });
  await expect(
    services.search(a, {
      query: "日本語",
      topicId: t.id,
      cursor: first.nextCursor ?? "",
    }),
  ).rejects.toMatchObject({ code: "INVALID_CURSOR" });
});

test("export is portable latest data, keeps completed state and active source IDs, excludes trash/history/owner fields", async () => {
  const t = await topic();
  const m = await memo();
  const d = await doc(t.id, [m.id]);
  const deleted = await memo("捨てる秘密");
  await services.editMemo(a, {
    id: m.id,
    body: "最新内容",
    expectedVersion: 1,
  });
  await remove("memo", deleted);
  await services.updateTopic(a, { ...t, completed: true, expectedVersion: 1 });
  await memo("別ユーザー秘密", b);
  const exported = JSON.parse(JSON.stringify(await services.exportData(a)));
  expect(exported).toMatchObject({
    format: "fog-export",
    version: 1,
    memos: [{ id: m.id, body: "最新内容" }],
    topics: [{ id: t.id, completed: true }],
    documents: [{ id: d.id, sourceMemoIds: [m.id] }],
  });
  const text = JSON.stringify(exported);
  expect(text).not.toContain("捨てる秘密");
  expect(text).not.toContain("別ユーザー秘密");
  expect(text).not.toContain("原文のメモ");
  expect(text).not.toContain("ownerId");
  expect(text).not.toContain("revisions");
});

test("AI cannot invoke human-only trash, restore, permanent deletion, settings, export or history even when types are bypassed", async () => {
  const actor = ai() as HumanActor;
  const m = await memo();
  const t = await topic();
  const d = await doc(t.id);
  const operations = [
    () => services.trash(actor),
    () => services.restore(actor, { kind: "memo", id: m.id }),
    () => services.hardDelete(actor, { kind: "memo", id: m.id }),
    () => services.emptyTrash(actor),
    () => services.getSettings(actor),
    () => services.setRetentionDays(actor, { retentionDays: 1 }),
    () => services.exportData(actor),
    () => services.memoHistory(actor, m.id),
    () => services.documentHistory(actor, d.id),
    () =>
      services.rollbackMemo(actor, {
        id: m.id,
        version: 1,
        expectedVersion: 1,
      }),
    () =>
      services.rollbackDocument(actor, {
        id: d.id,
        version: 1,
        expectedVersion: 1,
      }),
  ];
  for (const operation of operations)
    await expect(operation()).rejects.toMatchObject({ code: "HUMAN_ONLY" });
  await services.softDelete(ai(), {
    kind: "memo",
    id: m.id,
    expectedVersion: 1,
  });
  expect((await services.trash(a)).items).toHaveLength(1);
});

test("group soft-delete and restore failures roll back parent and every child atomically", async () => {
  const t = await topic();
  const d = await doc(t.id);
  await client.execute(
    "CREATE TRIGGER fail_document_delete BEFORE UPDATE OF deleted_at ON fog_documents WHEN NEW.deleted_at IS NOT NULL BEGIN SELECT RAISE(ABORT,'fail'); END",
  );
  await expect(remove("topic", t)).rejects.toMatchObject({
    code: "STORAGE_CONFLICT",
  });
  expect((await services.getTopic(a, t.id)).documents).toHaveLength(1);
  expect((await services.trash(a)).items).toEqual([]);
  await client.execute("DROP TRIGGER fail_document_delete");
  await remove("topic", t);
  await client.execute(
    "CREATE TRIGGER fail_topic_restore BEFORE UPDATE OF deleted_at ON fog_topics WHEN NEW.deleted_at IS NULL BEGIN SELECT RAISE(ABORT,'fail'); END",
  );
  await expect(
    services.restore(a, { kind: "document", id: d.id, restoreTopicSet: true }),
  ).rejects.toMatchObject({ code: "STORAGE_CONFLICT" });
  expect((await services.trash(a)).items).toHaveLength(2);
});

test("legacy nonnullable topic migration retains documents, revisions and sources and is repeatable", async () => {
  const legacy = createClient({ url: `file:${dir}/legacy.db` });
  try {
    await legacy.execute("PRAGMA foreign_keys=ON");
    await legacy.batch(
      fogSchema.map((sql) =>
        sql
          .replace("topic_id TEXT,", "topic_id TEXT NOT NULL,")
          .replace(
            "CHECK(topic_id IS NOT NULL OR deleted_at IS NOT NULL),",
            "",
          ),
      ),
      "write",
    );
    const old = await createFogServices({
      unitOfWork: new LibsqlFogUnitOfWork(legacy),
      crypto: nodeSecretCrypto,
      clock,
      ids: UuidV7Generator,
    });
    const user = (
      await old.register({
        email: "legacy@example.com",
        password: "long-enough-password",
      })
    ).user;
    const t = await old.createTopic(user, {
      title: "旧トピック",
      description: "",
    });
    const m = await old.createMemo(user, { body: "旧メモ" });
    const d = await old.createDocument(user, {
      topicId: t.id,
      title: "旧文書",
      body: "履歴",
      sourceMemoIds: [m.id],
    });
    await migrateFog(legacy);
    await migrateFog(legacy);
    expect((await old.getDocument(user, d.id)).sourceMemos[0]?.id).toBe(m.id);
    expect(await old.documentHistory(user, d.id)).toHaveLength(1);
    await old.softDelete(user, {
      kind: "document",
      id: d.id,
      expectedVersion: 1,
    });
    await old.softDelete(user, { kind: "topic", id: t.id, expectedVersion: 1 });
    await old.hardDelete(user, { kind: "topic", id: t.id });
    expect((await old.trash(user)).items[0]?.topic).toEqual({
      kind: "missing",
    });
    expect((await legacy.execute("PRAGMA foreign_key_check")).rows).toEqual([]);
  } finally {
    legacy.close();
  }
});

test("human source tombstones never leak deleted content through AI document, memo, topic, or timeline projections", async () => {
  const t = await topic();
  const m = await memo();
  const d = await doc(t.id, [m.id]);
  await remove("memo", m);
  expect((await services.getDocument(a, d.id)).sourceMemos).toHaveLength(1);
  expect((await services.getDocument(ai(), d.id)).sourceMemos).toEqual([]);
  expect(
    (await services.getTopic(ai(), t.id)).documents[0]?.sourceMemos,
  ).toEqual([]);
  await services.restore(a, { kind: "memo", id: m.id });
  await remove("document", d);
  expect((await services.getMemo(a, m.id)).sourceDocuments).toHaveLength(1);
  expect((await services.getMemo(ai(), m.id)).sourceDocuments).toEqual([]);
  expect(
    (await services.listTimeline(ai(), {})).memos[0]?.sourceDocuments,
  ).toEqual([]);
});

test("hard deletion failure rolls back set history and preserved orphan assignment", async () => {
  const t = await topic();
  const orphan = await doc(t.id);
  const set = await doc(t.id);
  await remove("document", orphan);
  await remove("topic", t);
  await client.execute(
    "CREATE TRIGGER fail_topic_hard_delete BEFORE DELETE ON fog_topics BEGIN SELECT RAISE(ABORT,'fail'); END",
  );
  await expect(
    services.hardDelete(a, { kind: "topic", id: t.id }),
  ).rejects.toMatchObject({ code: "STORAGE_CONFLICT" });
  expect((await services.trash(a)).items).toHaveLength(3);
  expect(
    (await services.trash(a)).items.find((x) => x.id === orphan.id)?.topic,
  ).toMatchObject({ kind: "deleted", id: t.id });
  expect(await count("fog_document_revisions", `document_id='${set.id}'`)).toBe(
    1,
  );
});

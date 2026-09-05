import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { type Client, createClient } from "@libsql/client";
import { createFogServices } from "@repo/core/application/fog/services";
import type {
  Actor,
  FogServices,
  HumanActor,
} from "@repo/core/application/fog/types";
import { UuidV7Generator } from "@repo/core/application/ports/idGenerator";
import { afterEach, beforeEach, expect, test } from "vitest";
import { nodeSecretCrypto } from "../crypto";
import { migrateFog } from "../schema";
import { LibsqlFogUnitOfWork } from "../unitOfWork";

let dir: string;
let client: Client;
let services: FogServices;
let now: Date;
let a: HumanActor;
let b: HumanActor;
beforeEach(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), "fog-content-"));
  client = createClient({ url: `file:${dir}/app.db` });
  await client.execute("PRAGMA journal_mode=WAL");
  await client.execute("PRAGMA foreign_keys=ON");
  await client.execute("PRAGMA busy_timeout=5000");
  await migrateFog(client);
  now = new Date("2026-09-05T09:00:00.000Z");
  services = await createFogServices({
    unitOfWork: new LibsqlFogUnitOfWork(client),
    crypto: nodeSecretCrypto,
    clock: { now: () => now },
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
  clientId: "client-1",
  clientName: "Research assistant",
});
const topic = () =>
  services.createTopic(a, { title: "調査", description: "資料をまとめる" });

test("timeline keysets have no duplicates or gaps across equal timestamps and concurrent insertions", async () => {
  const created = [];
  for (let i = 0; i < 8; i++)
    created.push(await services.createMemo(a, { body: `日本語 memo ${i}` }));
  await services.createMemo(b, { body: "日本語 other" });
  const first = await services.listTimeline(a, { limit: 3 });
  await services.createMemo(a, { body: "new memo" });
  const seen = [...first.memos];
  let cursor = first.nextCursor;
  while (cursor) {
    const page = await services.listTimeline(a, { limit: 3, cursor });
    seen.push(...page.memos);
    cursor = page.nextCursor;
  }
  expect(seen.map((m) => m.id)).toEqual(created.reverse().map((m) => m.id));
  expect(
    (await services.listTimeline(a, { keyword: "MEMO 2" })).memos,
  ).toHaveLength(1);
  expect(
    (await services.listTimeline(a, { keyword: "日本語" })).memos,
  ).toHaveLength(8);
  expect((await services.listTimeline(a, { keyword: "%_" })).memos).toEqual([]);
  const oldest = created.at(-1);
  if (!oldest) throw new Error("fixture missing");
  expect(
    await services.listTimeline(a, {
      memoId: oldest.id,
      keyword: "no-match",
      limit: 2,
    }),
  ).toMatchObject({ focusId: oldest.id, memos: [{ id: oldest.id }] });
  await expect(
    services.listTimeline(b, { memoId: oldest.id }),
  ).rejects.toMatchObject({ code: "MEMO_NOT_FOUND" });
  await expect(
    services.listTimeline(a, { cursor: "broken" }),
  ).rejects.toMatchObject({ code: "INVALID_CURSOR" });
});

test("date jumps use Japanese dates, include the requested day and select nearest empty-day position", async () => {
  now = new Date("2026-09-01T14:59:00Z");
  const before = await services.createMemo(a, { body: "前日" });
  now = new Date("2026-09-01T15:01:00Z");
  const target = await services.createMemo(a, { body: "日本の日付" });
  now = new Date("2026-09-05T00:00:00Z");
  const after = await services.createMemo(a, { body: "後日" });
  expect((await services.listTimeline(a, { date: "2026-09-02" })).focusId).toBe(
    target.id,
  );
  expect((await services.listTimeline(a, { date: "2026-09-04" })).focusId).toBe(
    after.id,
  );
  expect((await services.listTimeline(a, { date: "2026-08-01" })).focusId).toBe(
    before.id,
  );
  expect((await services.listTimeline(a, { date: "2026-10-01" })).focusId).toBe(
    after.id,
  );
  await expect(
    services.listTimeline(a, { date: "2026-02-30" }),
  ).rejects.toMatchObject({ code: "INVALID_DATE" });
});

test("memo editing preserves placement, checks OCC before no-change and appends immutable rollback revisions", async () => {
  const memo = await services.createMemo(a, { body: "最初" });
  expect(
    await services.editMemo(a, {
      id: memo.id,
      body: memo.body,
      expectedVersion: 1,
    }),
  ).toEqual(memo);
  now = new Date(now.getTime() + 60_000);
  const changed = await services.editMemo(ai(), {
    id: memo.id,
    body: "AI 編集",
    expectedVersion: 1,
  });
  expect(changed).toMatchObject({ createdAt: memo.createdAt, version: 2 });
  await expect(
    services.editMemo(a, { id: memo.id, body: "AI 編集", expectedVersion: 1 }),
  ).rejects.toMatchObject({ code: "OPTIMISTIC_LOCK_FAILURE" });
  await expect(
    services.editMemo(a, { id: memo.id, body: " \n", expectedVersion: 2 }),
  ).rejects.toMatchObject({ code: "INVALID_MEMO_BODY" });
  await expect(
    services.editMemo(b, { id: memo.id, body: "steal", expectedVersion: 2 }),
  ).rejects.toMatchObject({ code: "MEMO_NOT_FOUND" });
  const confirmed = await services.editMemo(a, {
    id: memo.id,
    body: "自分の編集",
    expectedVersion: changed.version,
  });
  expect(confirmed.version).toBe(3);
  const restored = await services.rollbackMemo(a, {
    id: memo.id,
    version: 1,
    expectedVersion: 3,
  });
  expect(restored).toMatchObject({
    body: "最初",
    version: 4,
    createdAt: memo.createdAt,
  });
  expect(
    (
      await services.rollbackMemo(a, {
        id: memo.id,
        version: 1,
        expectedVersion: 4,
      })
    ).version,
  ).toBe(5);
  const history = await services.memoHistory(a, memo.id);
  expect(history.map((rev) => rev.version)).toEqual([5, 4, 3, 2, 1]);
  expect(history[3]?.actor).toEqual({
    kind: "ai",
    id: "client-1",
    name: "Research assistant",
  });
  await expect(services.memoHistory(b, memo.id)).rejects.toMatchObject({
    code: "MEMO_NOT_FOUND",
  });
});

test("topic lifecycle and document/source creation remain tenant scoped and survive migration replay", async () => {
  const t = await topic();
  const memo = await services.createMemo(a, { body: "出典" });
  const d = await services.createDocument(a, {
    topicId: t.id,
    title: "資料",
    body: "# Markdown\n本文",
    sourceMemoIds: [memo.id, memo.id],
  });
  expect(d.sourceMemos).toEqual([
    { id: memo.id, body: memo.body, createdAt: memo.createdAt, deleted: false },
  ]);
  expect((await services.getMemo(a, memo.id)).sourceDocuments).toEqual([
    { id: d.id, title: d.title, deleted: false },
  ]);
  expect(await services.getTopic(a, t.id)).toMatchObject({
    topic: t,
    documents: [d],
    relatedMemos: [{ id: memo.id }],
  });
  await services.editMemo(a, {
    id: memo.id,
    body: "最新の出典",
    expectedVersion: 1,
  });
  expect((await services.getDocument(a, d.id)).sourceMemos[0]?.body).toBe(
    "最新の出典",
  );
  const completed = await services.updateTopic(a, {
    id: t.id,
    title: "調査完了",
    description: "完了した資料",
    completed: true,
    expectedVersion: 1,
  });
  expect(completed).toMatchObject({ completed: true, version: 2 });
  expect((await services.listTopics(a))[0]).toEqual(completed);
  expect(
    (
      await services.updateTopic(a, {
        ...completed,
        completed: false,
        expectedVersion: 2,
      })
    ).completed,
  ).toBe(false);
  await expect(
    services.updateTopic(a, {
      ...completed,
      completed: false,
      expectedVersion: 1,
    }),
  ).rejects.toMatchObject({ code: "OPTIMISTIC_LOCK_FAILURE" });
  expect(await services.listTopics(b)).toEqual([]);
  for (const operation of [
    () => services.getTopic(b, t.id),
    () => services.getDocument(b, d.id),
    () => services.updateTopic(b, { ...t, expectedVersion: 1 }),
    () => services.editDocument(b, { ...d, expectedVersion: 1 }),
    () => services.documentHistory(b, d.id),
  ])
    await expect(operation()).rejects.toMatchObject({
      code: expect.stringMatching(/NOT_FOUND/),
    });
  await migrateFog(client);
  expect((await services.getDocument(a, d.id)).body).toBe(d.body);
  expect(await services.listMemos(a)).toHaveLength(1);
});

test("invalid parents and sources abort all document, revision and link writes", async () => {
  const t = await topic();
  const valid = await services.createMemo(a, { body: "valid" });
  const foreign = await services.createMemo(b, { body: "foreign" });
  const foreignTopic = await services.createTopic(b, {
    title: "other",
    description: "",
  });
  for (const input of [
    { topicId: t.id, sourceMemoIds: [valid.id, foreign.id] },
    { topicId: t.id, sourceMemoIds: [valid.id, "missing"] },
    { topicId: foreignTopic.id, sourceMemoIds: [valid.id] },
    { topicId: "missing", sourceMemoIds: [] },
  ])
    await expect(
      services.createDocument(a, { ...input, title: "資料", body: "" }),
    ).rejects.toMatchObject({ code: expect.stringMatching(/NOT_FOUND/) });
  for (const table of [
    "fog_documents",
    "fog_document_revisions",
    "fog_document_sources",
  ])
    expect((await client.execute(`SELECT * FROM ${table}`)).rows).toHaveLength(
      0,
    );
  await expect(
    services.createTopic(a, { title: " ", description: "" }),
  ).rejects.toMatchObject({ code: "INVALID_TITLE" });
  await expect(
    services.createDocument(a, {
      topicId: t.id,
      title: " ",
      body: "",
      sourceMemoIds: [],
    }),
  ).rejects.toMatchObject({ code: "INVALID_TITLE" });
  expect(
    (
      await services.createDocument(a, {
        topicId: t.id,
        title: "空の本文",
        body: "",
        sourceMemoIds: [],
      })
    ).body,
  ).toBe("");
});

test("document revisions record who/when/why and rollback is append-only even for matching contents", async () => {
  const t = await topic();
  const d = await services.createDocument(a, {
    topicId: t.id,
    title: "最初",
    body: "本文",
    sourceMemoIds: [],
  });
  expect(
    await services.editDocument(a, {
      ...d,
      reason: "理由だけ変更",
      expectedVersion: 1,
    }),
  ).toEqual(d);
  const changed = await services.editDocument(ai(), {
    id: d.id,
    title: "AI 版",
    body: "書き直し",
    reason: "出典の要点を整理",
    expectedVersion: 1,
  });
  await expect(
    services.editDocument(a, { ...changed, expectedVersion: 1 }),
  ).rejects.toMatchObject({ code: "OPTIMISTIC_LOCK_FAILURE" });
  await expect(
    services.editDocument(ai(), {
      ...changed,
      body: "fail",
      expectedVersion: 2,
    }),
  ).rejects.toMatchObject({ code: "REASON_REQUIRED" });
  await services.editDocument(a, {
    ...changed,
    body: "手動の本文",
    expectedVersion: 2,
  });
  const restored = await services.rollbackDocument(a, {
    id: d.id,
    version: 1,
    expectedVersion: 3,
  });
  expect(restored).toMatchObject({ title: d.title, body: d.body, version: 4 });
  await services.rollbackDocument(a, {
    id: d.id,
    version: 1,
    expectedVersion: 4,
  });
  const history = await services.documentHistory(a, d.id);
  expect(history.map((rev) => rev.version)).toEqual([5, 4, 3, 2, 1]);
  expect(history[2]?.reason).toBe("手動編集");
  expect(history[3]).toMatchObject({
    reason: "出典の要点を整理",
    actor: { kind: "ai", id: "client-1", name: "Research assistant" },
    title: "AI 版",
  });
  await expect(
    services.rollbackDocument(a, { id: d.id, version: 99, expectedVersion: 5 }),
  ).rejects.toMatchObject({ code: "REVISION_NOT_FOUND" });
  expect((await services.getDocument(a, d.id)).version).toBe(5);
});

test("human-only history and rollback reject AI even when a caller bypasses static typing", async () => {
  const memo = await services.createMemo(a, { body: "memo" });
  const t = await topic();
  const d = await services.createDocument(a, {
    topicId: t.id,
    title: "doc",
    body: "",
    sourceMemoIds: [],
  });
  // @ts-expect-error This simulates a caller bypassing the public human-only type.
  const forgedHuman: HumanActor = ai();
  await expect(
    services.memoHistory(forgedHuman, memo.id),
  ).rejects.toMatchObject({
    code: "HUMAN_ONLY",
  });
  await expect(
    services.rollbackMemo(forgedHuman, {
      id: memo.id,
      version: 1,
      expectedVersion: 1,
    }),
  ).rejects.toMatchObject({ code: "HUMAN_ONLY" });
  await expect(
    services.documentHistory(forgedHuman, d.id),
  ).rejects.toMatchObject({
    code: "HUMAN_ONLY",
  });
  await expect(
    services.rollbackDocument(forgedHuman, {
      id: d.id,
      version: 1,
      expectedVersion: 1,
    }),
  ).rejects.toMatchObject({ code: "HUMAN_ONLY" });
});

test("two racing writes preserve exactly one winning revision and leave no partial loser", async () => {
  const memo = await services.createMemo(a, { body: "start" });
  const result = await Promise.allSettled([
    services.editMemo(a, { id: memo.id, body: "first", expectedVersion: 1 }),
    services.editMemo(a, { id: memo.id, body: "second", expectedVersion: 1 }),
  ]);
  expect(result.filter((r) => r.status === "fulfilled")).toHaveLength(1);
  expect(result.find((r) => r.status === "rejected")).toMatchObject({
    reason: { code: "OPTIMISTIC_LOCK_FAILURE" },
  });
  expect(
    (await services.memoHistory(a, memo.id)).map((r) => r.version),
  ).toEqual([2, 1]);
});

test("a failure after document and revision insertion rolls back the entire source-linked creation", async () => {
  const t = await topic();
  const memo = await services.createMemo(a, { body: "出典" });
  await client.execute(
    "CREATE TRIGGER fail_source BEFORE INSERT ON fog_document_sources BEGIN SELECT RAISE(ABORT,'injected source failure'); END",
  );
  await expect(
    services.createDocument(a, {
      topicId: t.id,
      title: "中断",
      body: "本文",
      sourceMemoIds: [memo.id],
    }),
  ).rejects.toMatchObject({ code: "STORAGE_CONFLICT" });
  expect((await services.getTopic(a, t.id)).documents).toEqual([]);
  expect((await services.getMemo(a, memo.id)).sourceDocuments).toEqual([]);
  expect(
    (await client.execute("SELECT * FROM fog_document_revisions")).rows,
  ).toEqual([]);
});

test("racing document edits preserve the winner and source references across a process-style reopen", async () => {
  const t = await topic();
  const memo = await services.createMemo(a, { body: "出典" });
  const document = await services.createDocument(a, {
    topicId: t.id,
    title: "資料",
    body: "元の本文",
    sourceMemoIds: [memo.id],
  });
  const edits = await Promise.allSettled([
    services.editDocument(a, {
      ...document,
      body: "人間の本文",
      expectedVersion: 1,
    }),
    services.editDocument(ai(), {
      ...document,
      body: "AI の本文",
      reason: "要約",
      expectedVersion: 1,
    }),
  ]);
  expect(edits.filter((edit) => edit.status === "fulfilled")).toHaveLength(1);
  expect(edits.find((edit) => edit.status === "rejected")).toMatchObject({
    reason: { code: "OPTIMISTIC_LOCK_FAILURE" },
  });
  const latest = await services.getDocument(a, document.id);
  expect(
    (await services.documentHistory(a, document.id)).map((rev) => rev.version),
  ).toEqual([2, 1]);
  client.close();
  client = createClient({ url: `file:${dir}/app.db` });
  services = await createFogServices({
    unitOfWork: new LibsqlFogUnitOfWork(client),
    crypto: nodeSecretCrypto,
    clock: { now: () => now },
    ids: UuidV7Generator,
  });
  expect(await services.getDocument(a, document.id)).toEqual(latest);
  expect((await services.getTopic(a, t.id)).relatedMemos[0]?.id).toBe(memo.id);
  expect(await services.documentHistory(a, document.id)).toHaveLength(2);
});

test("multiline change reasons leave document contents and revisions unchanged", async () => {
  const t = await topic();
  const document = await services.createDocument(a, {
    topicId: t.id,
    title: "資料",
    body: "原文",
    sourceMemoIds: [],
  });
  for (const reason of [
    "一行目\n二行目",
    "一行目\r二行目",
    "一行目\r\n二行目",
  ]) {
    await expect(
      services.editDocument(a, {
        ...document,
        body: "変更後",
        reason,
        expectedVersion: 1,
      }),
    ).rejects.toMatchObject({ code: "INVALID_REASON" });
  }
  expect(await services.getDocument(a, document.id)).toEqual(document);
  expect(
    (await services.documentHistory(a, document.id)).map(
      (revision) => revision.version,
    ),
  ).toEqual([1]);
  await services.editDocument(a, {
    ...document,
    body: "変更後",
    reason: "  一行サマリ  ",
    expectedVersion: 1,
  });
  expect((await services.documentHistory(a, document.id))[0]?.reason).toBe(
    "一行サマリ",
  );
});

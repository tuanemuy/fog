import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { type Client, createClient } from "@libsql/client";
import { createFogServices } from "../../packages/core/src/application/fog/services";
import { purgeExpiredTrash } from "../../packages/core/src/application/fog/trashServices";
import type {
  Actor,
  FogServices,
  HumanActor,
} from "../../packages/core/src/application/fog/types";
import { UuidV7Generator } from "../../packages/core/src/application/ports/idGenerator";
import { afterEach, beforeEach, expect, test } from "vitest";
import { nodeSecretCrypto } from "../../packages/core/src/adapters/fog/crypto";
import { fogSchema, migrateFog } from "../../packages/core/src/adapters/fog/schema";
import { LibsqlFogUnitOfWork } from "../../packages/core/src/adapters/fog/unitOfWork";

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


test("independent: failed orphan destination creation restores no partial topic or assignment", async () => {
  const t = await topic(); const d = await doc(t.id);
  await remove("document", d); await remove("topic", t);
  await services.hardDelete(a, {kind:"topic", id:t.id});
  await client.execute("CREATE TRIGGER fail_orphan_restore BEFORE UPDATE OF deleted_at ON fog_documents WHEN NEW.deleted_at IS NULL BEGIN SELECT RAISE(ABORT,'fail'); END");
  await expect(services.restore(a, {kind:"document",id:d.id,targetTopic:{kind:"new",title:"atomic destination",description:""}})).rejects.toMatchObject({code:"STORAGE_CONFLICT"});
  expect(await services.listTopics(a)).toEqual([]);
  expect((await services.trash(a)).items[0]?.topic).toEqual({kind:"missing"});
  expect(await count("fog_document_revisions")).toBe(1);
});
test("independent: empty trash rollback restores already-deleted histories and links", async () => {
  const t = await topic(); const m = await memo(); const d = await doc(t.id,[m.id]);
  await remove("memo",m); await remove("document",d); await remove("topic",t);
  await client.execute("CREATE TRIGGER fail_last_delete BEFORE DELETE ON fog_memos BEGIN SELECT RAISE(ABORT,'fail'); END");
  await expect(services.emptyTrash(a)).rejects.toMatchObject({code:"STORAGE_CONFLICT"});
  expect((await services.trash(a)).items).toHaveLength(3);
  expect(await count("fog_document_revisions")).toBe(1);
  expect(await count("fog_memo_revisions")).toBe(1);
  expect(await count("fog_document_sources")).toBe(1);
  expect((await client.execute("PRAGMA foreign_key_check")).rows).toEqual([]);
});
test("independent: deleted memo secrecy holds in AI mutation returns, topic relations, and long search snippets", async () => {
  const t = await topic(); const m = await memo("deleted-secret-body"); const active = await memo("visible memo");
  const d = await doc(t.id,[m.id,active.id]);
  await remove("memo",m);
  const result = await services.editDocument(ai(), {id:d.id,title:d.title,body:"x".repeat(300)+"キーワード"+"y".repeat(300),reason:"AI edit",expectedVersion:1});
  const related = await services.getTopic(ai(),t.id);
  const resultSearch = await services.search(ai(),{query:"キーワード"});
  for (const payload of [result,related,resultSearch]) {
    expect(JSON.stringify(payload)).not.toContain(m.id);
    expect(JSON.stringify(payload)).not.toContain("deleted-secret-body");
  }
  expect(resultSearch.items[0]?.snippet).toHaveLength(200);
  expect(result.body).toContain(resultSearch.items[0]?.snippet);
  expect(resultSearch.items[0]?.snippet).toContain("キーワード");
  await services.softDelete(ai(),{kind:"document",id:d.id,expectedVersion:2});
  const editedMemo = await services.editMemo(ai(),{id:active.id,body:"visible memo edited",expectedVersion:1});
  expect(editedMemo.sourceDocuments).toEqual([]);
  expect((await services.listMemos(ai())).flatMap(x=>x.sourceDocuments)).toEqual([]);
  for (const op of [()=>services.getMemo(ai(),m.id),()=>services.getDocument(ai(),d.id)])
    await expect(op()).rejects.toMatchObject({name:"NotFoundError"});
});
test("independent: export emits latest document only, omits trashed document/topic/source and foreign owner", async () => {
  const t = await topic(); const m = await memo("deleted source"); const d = await doc(t.id,[m.id]);
  const hiddenTopic = await services.createTopic(a,{title:"hidden-topic",description:"hidden-description"});
  await services.createDocument(a,{topicId:hiddenTopic.id,title:"hidden-document",body:"hidden-body",sourceMemoIds:[]});
  await services.editDocument(a,{id:d.id,title:"latest-title",body:"latest-document-body",reason:"edit-reason-not-exported",expectedVersion:1});
  await remove("memo",m); await remove("topic",hiddenTopic);
  const other=await topic(b); await doc(other.id,[],b);
  const result=await services.exportData(a); const text=JSON.stringify(result);
  expect(result.documents).toHaveLength(1);
  expect(result.documents[0]).toMatchObject({title:"latest-title",body:"latest-document-body",sourceMemoIds:[]});
  for (const secret of [d.body,"hidden-topic","hidden-document","hidden-description","hidden-body",m.id,other.id,"edit-reason-not-exported"])
    expect(text).not.toContain(secret);
});

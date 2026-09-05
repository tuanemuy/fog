import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { type Client, createClient } from "@libsql/client";
import { createFogServices } from "@repo/core/application/fog/services";
import type {
  Actor,
  AiClient,
  AiReceipt,
  AiRequest,
  AiWriteRequest,
  FogServices,
  HumanActor,
} from "@repo/core/application/fog/types";
import { UuidV7Generator } from "@repo/core/application/ports/idGenerator";
import { afterEach, beforeEach, expect, test } from "vitest";
import { nodeSecretCrypto } from "../crypto";
import { migrateFog } from "../schema";
import { LibsqlFogUnitOfWork } from "../unitOfWork";

const redirectUri = "http://127.0.0.1:3456/callback?from=fog";
const clients: AiClient[] = [
  {
    id: "research",
    name: "調査AI",
    redirectUris: [redirectUri, "https://client.example/callback"],
  },
  { id: "other", name: "別AI", redirectUris: [redirectUri] },
];
const verifier = "a".repeat(43);
let dir: string;
let client: Client;
let services: FogServices;
let now: Date;
let a: HumanActor;
let b: HumanActor;
const clock = { now: () => now };
const makeServices = () =>
  createFogServices({
    unitOfWork: new LibsqlFogUnitOfWork(client),
    crypto: nodeSecretCrypto,
    clock,
    ids: UuidV7Generator,
    aiClients: clients,
  });
beforeEach(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), "fog-ai-"));
  client = createClient({ url: `file:${dir}/app.db` });
  await client.execute("PRAGMA journal_mode=WAL");
  await client.execute("PRAGMA foreign_keys=ON");
  await client.execute("PRAGMA busy_timeout=5000");
  await migrateFog(client);
  now = new Date("2026-09-05T12:00:00.000Z");
  services = await makeServices();
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
const begin = (clientId = "research") =>
  services.beginAiAuthorization({
    clientId,
    redirectUri,
    state: "state=&日本語",
    codeChallenge: nodeSecretCrypto.pkceChallenge(verifier),
    codeChallengeMethod: "S256",
  });
async function authorize(actor = a) {
  const request = await begin();
  await services.getAiAuthorization(actor, request.requestToken);
  const consent = await services.decideAiAuthorization(actor, {
    requestToken: request.requestToken,
    allow: true,
  });
  const code = new URL(consent.redirectUri).searchParams.get("code");
  if (!code) throw new Error("missing code");
  return code;
}
const exchange = (code: string) =>
  services.exchangeAiCode({
    clientId: "research",
    redirectUri,
    code,
    codeVerifier: verifier,
  });
const connect = async (actor = a) =>
  (await exchange(await authorize(actor))).accessToken;
async function write(
  token: string,
  request: AiWriteRequest,
): Promise<AiReceipt> {
  const result = await services.executeAi(token, request);
  if (result.kind !== "receipt") throw new Error("expected receipt");
  return result;
}
const createMemo = (token: string, key = "memo", body = "日本語の新しいメモ") =>
  write(token, {
    operation: "memos.create",
    input: { body },
    idempotencyKey: key,
  });
const resourceId = (receipt: AiReceipt) => {
  if (!receipt.resource) throw new Error("missing resource");
  return receipt.resource.id;
};
const topic = () =>
  services.createTopic(a, { title: "調査", description: "説明" });
const doc = (
  topicId: string,
  body = "前半 alpha 後半",
  sourceMemoIds: string[] = [],
) =>
  services.createDocument(a, { topicId, title: "文書", body, sourceMemoIds });
const count = async (table: string) =>
  Number((await client.execute(`SELECT count(*) n FROM ${table}`)).rows[0]?.n);

test("PKCE authorization binds owner, preserves state and registered callback, exchanges once, and stores only hashed secrets", async () => {
  const request = await begin();
  const consent = await services.getAiAuthorization(a, request.requestToken);
  expect(consent).toMatchObject({
    clientId: "research",
    clientName: "調査AI",
    redirectUri,
  });
  expect(consent.operations).toContain("documents.patch");
  expect(consent.operations).not.toContain("hardDelete");
  const result = await services.decideAiAuthorization(a, {
    requestToken: request.requestToken,
    allow: true,
  });
  const redirect = new URL(result.redirectUri);
  expect(redirect.origin + redirect.pathname).toBe(
    "http://127.0.0.1:3456/callback",
  );
  expect(redirect.searchParams.get("from")).toBe("fog");
  expect(redirect.searchParams.get("state")).toBe("state=&日本語");
  const code = redirect.searchParams.get("code");
  if (!code) throw new Error("code");
  const token = await exchange(code);
  expect(token).toMatchObject({ tokenType: "Bearer", expiresIn: 2592000 });
  await expect(exchange(code)).rejects.toMatchObject({
    code: "INVALID_AI_CODE",
  });
  const stored =
    JSON.stringify(
      (await client.execute("SELECT * FROM fog_ai_authorization_requests"))
        .rows,
    ) +
    JSON.stringify(
      (await client.execute("SELECT * FROM fog_ai_connections")).rows,
    );
  expect(stored).not.toContain(request.requestToken);
  expect(stored).not.toContain(token.accessToken);
  expect(stored).not.toContain(verifier);
  expect(await services.authenticate(token.accessToken)).toBeNull();
  expect((await services.listAiConnections(a))[0]).toMatchObject({
    clientName: "調査AI",
    lastUsedAt: null,
  });
});

test("authorization cannot be decided before consent binding or by a different human; consumed requests cannot be replayed", async () => {
  const request = await begin();
  await expect(
    services.decideAiAuthorization(a, {
      requestToken: request.requestToken,
      allow: true,
    }),
  ).rejects.toMatchObject({ code: "INVALID_AI_AUTHORIZATION" });
  await services.getAiAuthorization(a, request.requestToken);
  await expect(
    services.getAiAuthorization(b, request.requestToken),
  ).rejects.toMatchObject({ code: "INVALID_AI_AUTHORIZATION" });
  await expect(
    services.decideAiAuthorization(b, {
      requestToken: request.requestToken,
      allow: true,
    }),
  ).rejects.toMatchObject({ code: "INVALID_AI_AUTHORIZATION" });
  await services.decideAiAuthorization(a, {
    requestToken: request.requestToken,
    allow: true,
  });
  await expect(
    services.getAiAuthorization(a, request.requestToken),
  ).rejects.toMatchObject({ code: "INVALID_AI_AUTHORIZATION" });
  await expect(
    services.decideAiAuthorization(a, {
      requestToken: request.requestToken,
      allow: true,
    }),
  ).rejects.toMatchObject({ code: "INVALID_AI_AUTHORIZATION" });
  expect(await count("fog_ai_authorization_codes")).toBe(1);
});

test("denial returns state and access_denied without creating a connection or code", async () => {
  const request = await begin();
  await services.getAiAuthorization(a, request.requestToken);
  const denied = await services.decideAiAuthorization(a, {
    requestToken: request.requestToken,
    allow: false,
  });
  const params = new URL(denied.redirectUri).searchParams;
  expect(params.get("error")).toBe("access_denied");
  expect(params.get("state")).toBe("state=&日本語");
  expect(params.has("code")).toBe(false);
  expect(await count("fog_ai_connections")).toBe(0);
  expect(await count("fog_ai_authorization_codes")).toBe(0);
});

test("unregistered redirect/client, unsupported PKCE, malformed challenge and empty state are rejected", async () => {
  const input = {
    clientId: "research",
    redirectUri,
    state: "state",
    codeChallenge: nodeSecretCrypto.pkceChallenge(verifier),
    codeChallengeMethod: "S256" as const,
  };
  for (const changes of [
    { clientId: "unknown" },
    { redirectUri: "https://evil.example/callback" },
    { redirectUri: `${redirectUri}#fragment` },
    { codeChallenge: "bad" },
    { state: "" },
    { codeChallengeMethod: "plain" },
  ])
    await expect(
      services.beginAiAuthorization({ ...input, ...changes } as typeof input),
    ).rejects.toMatchObject({ code: "INVALID_AI_AUTHORIZATION" });
  expect(await count("fog_ai_authorization_requests")).toBe(0);
});

test("request, code and token expire at their exact injected-clock boundaries", async () => {
  const request = await begin();
  now = new Date(now.getTime() + 600_000);
  await expect(
    services.getAiAuthorization(a, request.requestToken),
  ).rejects.toMatchObject({ code: "INVALID_AI_AUTHORIZATION" });
  const code = await authorize();
  now = new Date(now.getTime() + 120_000);
  await expect(exchange(code)).rejects.toMatchObject({
    code: "INVALID_AI_CODE",
  });
  const token = await connect();
  now = new Date(now.getTime() + 2_592_000_000);
  await expect(
    services.executeAi(token, { operation: "guidance", input: {} }),
  ).rejects.toMatchObject({ code: "AI_CONNECTION_UNAUTHORIZED" });
  expect(await services.listAiConnections(a)).toEqual([]);
});

test("wrong PKCE verifier, redirect and client never consume a valid code; concurrent exchanges create only one connection", async () => {
  const code = await authorize();
  await expect(
    services.exchangeAiCode({
      clientId: "research",
      redirectUri,
      code,
      codeVerifier: "b".repeat(43),
    }),
  ).rejects.toMatchObject({ code: "INVALID_AI_CODE" });
  await expect(
    services.exchangeAiCode({
      clientId: "research",
      redirectUri,
      code,
      codeVerifier: "short",
    }),
  ).rejects.toMatchObject({ code: "INVALID_AI_CODE" });
  await expect(
    services.exchangeAiCode({
      clientId: "research",
      redirectUri: "https://client.example/callback",
      code,
      codeVerifier: verifier,
    }),
  ).rejects.toMatchObject({ code: "INVALID_AI_CODE" });
  await expect(
    services.exchangeAiCode({
      clientId: "other",
      redirectUri,
      code,
      codeVerifier: verifier,
    }),
  ).rejects.toMatchObject({ code: "INVALID_AI_CODE" });
  const results = await Promise.allSettled([exchange(code), exchange(code)]);
  expect(results.filter((x) => x.status === "fulfilled")).toHaveLength(1);
  expect(await count("fog_ai_connections")).toBe(1);
});

test("AI reads/writes use the authorized owner, record actor, expose current safe facts and update last-used", async () => {
  const token = await connect();
  const other = await services.createMemo(b, { body: "別ユーザー秘密" });
  const receipt = await createMemo(token);
  const id = resourceId(receipt);
  expect((await services.memoHistory(a, id))[0]?.actor).toEqual({
    kind: "ai",
    id: "research",
    name: "調査AI",
  });
  now = new Date(now.getTime() + 1000);
  const current = await services.executeAi(token, {
    operation: "memos.get",
    input: { id },
  });
  expect(current).toMatchObject({
    kind: "read",
    data: { id, body: "日本語の新しいメモ" },
  });
  const search = await services.executeAi(token, {
    operation: "search",
    input: { query: "日本語" },
  });
  expect(search).toMatchObject({ kind: "read", data: { items: [{ id }] } });
  await expect(
    services.executeAi(token, {
      operation: "memos.get",
      input: { id: other.id },
    }),
  ).rejects.toMatchObject({ code: "MEMO_NOT_FOUND" });
  expect((await services.listAiConnections(a))[0]?.lastUsedAt).toBe(
    now.toISOString(),
  );
  expect(JSON.stringify(current)).not.toContain("deleted");
  expect(JSON.stringify(current)).not.toContain("ownerId");
});

test("all topic operations, document creation with sources, recent context and single reads are usable", async () => {
  const token = await connect();
  const m = resourceId(await createMemo(token));
  const t = resourceId(
    await write(token, {
      operation: "topics.create",
      input: { title: "日本語 トピック", description: "説明" },
      idempotencyKey: "topic",
    }),
  );
  await write(token, {
    operation: "topics.update",
    input: {
      id: t,
      title: "日本語 完了",
      description: "説明更新",
      completed: true,
      expectedVersion: 1,
    },
    idempotencyKey: "topic-update",
  });
  const d = resourceId(
    await write(token, {
      operation: "documents.create",
      input: {
        topicId: t,
        title: "日本語の文書",
        body: "メモを整理",
        sourceMemoIds: [m],
        reason: "議論を整理",
      },
      idempotencyKey: "document",
    }),
  );
  expect(
    await services.executeAi(token, { operation: "topics.list", input: {} }),
  ).toMatchObject({ data: [{ id: t, completed: true }] });
  expect(
    await services.executeAi(token, {
      operation: "topics.get",
      input: { id: t },
    }),
  ).toMatchObject({
    data: { documents: [{ id: d }], relatedMemos: [{ id: m }] },
  });
  expect(
    await services.executeAi(token, {
      operation: "documents.get",
      input: { id: d },
    }),
  ).toMatchObject({
    data: { sourceMemos: [{ id: m, body: "日本語の新しいメモ" }] },
  });
  expect(
    await services.executeAi(token, {
      operation: "memos.recent",
      input: { limit: 1 },
    }),
  ).toMatchObject({ data: { memos: [{ id: m }] } });
  expect((await services.documentHistory(a, d))[0]).toMatchObject({
    reason: "議論を整理",
    actor: { kind: "ai", name: "調査AI" },
  });
});

test("idempotency serializes concurrent writes, survives service/database reopen, and compares canonical payloads", async () => {
  const token = await connect();
  const input = {
    operation: "memos.create" as const,
    input: { body: "一度だけ" },
    idempotencyKey: "stable",
  };
  const results = await Promise.all([
    write(token, input),
    write(token, input),
    write(token, input),
  ]);
  expect(new Set(results.map((x) => x.requestId)).size).toBe(1);
  expect(results.filter((x) => !x.replayed)).toHaveLength(1);
  expect(await count("fog_memos")).toBe(1);
  expect(await count("fog_memo_revisions")).toBe(1);
  client.close();
  client = createClient({ url: `file:${dir}/app.db` });
  await client.execute("PRAGMA journal_mode=WAL");
  await client.execute("PRAGMA foreign_keys=ON");
  services = await makeServices();
  expect(
    await write(token, {
      idempotencyKey: "stable",
      input: { body: "一度だけ" },
      operation: "memos.create",
    }),
  ).toMatchObject({ requestId: results[0]?.requestId, replayed: true });
  await expect(createMemo(token, "stable", "違う内容")).rejects.toMatchObject({
    code: "IDEMPOTENCY_PAYLOAD_MISMATCH",
  });
  const second = await connect();
  await createMemo(second, "stable", "別接続の要求");
  expect(await count("fog_memos")).toBe(2);
  const ledger = JSON.stringify(
    (await client.execute("SELECT * FROM fog_ai_idempotency")).rows,
  );
  expect(ledger).not.toContain("一度だけ");
  expect(ledger).not.toContain("別接続の要求");
  expect(ledger).not.toContain("stable");
});

test("ledger failure rolls content and revisions back, and the same key can succeed after the fault is removed", async () => {
  const token = await connect();
  await client.execute(
    "CREATE TRIGGER fail_ledger BEFORE INSERT ON fog_ai_idempotency BEGIN SELECT RAISE(ABORT,'fail'); END",
  );
  await expect(createMemo(token)).rejects.toMatchObject({
    code: "STORAGE_CONFLICT",
  });
  expect(await count("fog_memos")).toBe(0);
  expect(await count("fog_memo_revisions")).toBe(0);
  expect(await count("fog_ai_idempotency")).toBe(0);
  expect((await services.listAiConnections(a))[0]?.lastUsedAt).toBeNull();
  await client.execute("DROP TRIGGER fail_ledger");
  await createMemo(token);
  expect(await count("fog_memos")).toBe(1);
});

test("replayed receipts resolve current active metadata, never cached content, and hide resources after soft or hard deletion", async () => {
  const token = await connect();
  const original = await createMemo(token);
  const id = resourceId(original);
  await services.editMemo(a, {
    id,
    body: "人間の新しい本文",
    expectedVersion: 1,
  });
  expect(await createMemo(token)).toMatchObject({
    replayed: true,
    resource: { id, version: 2 },
  });
  await services.softDelete(a, { kind: "memo", id, expectedVersion: 2 });
  expect(await createMemo(token)).toEqual({
    kind: "receipt",
    operation: "memos.create",
    requestId: original.requestId,
    replayed: true,
    resource: null,
  });
  await services.hardDelete(a, { kind: "memo", id });
  expect((await createMemo(token)).resource).toBeNull();
  expect(await count("fog_memos")).toBe(0);
});

test("deleted source metadata is absent from every AI read and write replay", async () => {
  const token = await connect();
  const m = resourceId(await createMemo(token));
  const t = await topic();
  const input = {
    operation: "documents.create" as const,
    input: {
      topicId: t.id,
      title: "現存文書",
      body: "出典の整理",
      sourceMemoIds: [m],
      reason: "整理",
    },
    idempotencyKey: "doc",
  };
  const d = resourceId(await write(token, input));
  await services.softDelete(a, { kind: "memo", id: m, expectedVersion: 1 });
  for (const request of [
    { operation: "documents.get", input: { id: d } },
    { operation: "topics.get", input: { id: t.id } },
    { operation: "search", input: { query: "出典" } },
    input,
  ] satisfies AiRequest[]) {
    const result = JSON.stringify(await services.executeAi(token, request));
    expect(result).not.toContain(m);
    expect(result).not.toContain("日本語の新しいメモ");
    expect(result).not.toContain("deleted");
  }
  await services.restore(a, { kind: "memo", id: m });
  await services.softDelete(a, { kind: "document", id: d, expectedVersion: 1 });
  for (const request of [
    { operation: "memos.get", input: { id: m } },
    { operation: "memos.recent", input: { limit: 30 } },
    { operation: "search", input: { query: "日本語" } },
  ] satisfies AiRequest[])
    expect(
      JSON.stringify(await services.executeAi(token, request)),
    ).not.toContain("現存文書");
});

test("partial edits require version, unique exact substring and reason; failures leave no revision or ledger", async () => {
  const token = await connect();
  const t = await topic();
  const d = await doc(t.id, "前 alpha 中 alpha 後");
  const input = {
    id: d.id,
    expectedVersion: 1,
    find: "alpha",
    replace: "beta",
    reason: "修正",
  };
  for (const [changes, code] of [
    [{ find: "missing" }, "PATCH_MATCH_FAILURE"],
    [{}, "PATCH_MATCH_FAILURE"],
    [{ expectedVersion: 2 }, "OPTIMISTIC_LOCK_FAILURE"],
    [{ find: "前", reason: "" }, "REASON_REQUIRED"],
    [{ find: "" }, "INVALID_PATCH"],
    [{ find: d.body }, "REWRITE_CONFIRMATION_REQUIRED"],
  ] as const)
    await expect(
      write(token, {
        operation: "documents.patch",
        input: { ...input, ...changes },
        idempotencyKey: "patch",
      }),
    ).rejects.toMatchObject({ code });
  expect(await services.documentHistory(a, d.id)).toHaveLength(1);
  expect(await count("fog_ai_idempotency")).toBe(0);
  await write(token, {
    operation: "documents.patch",
    input: { ...input, find: "前 alpha", replace: "前 beta", title: "修正版" },
    idempotencyKey: "patch",
  });
  expect(await services.getDocument(a, d.id)).toMatchObject({
    title: "修正版",
    body: "前 beta 中 alpha 後",
    version: 2,
  });
  expect((await services.documentHistory(a, d.id))[0]).toMatchObject({
    reason: "修正",
    actor: { name: "調査AI" },
  });
});

test("overlapping patch matches are ambiguous and full rewrite requires explicit confirmation with reason", async () => {
  const token = await connect();
  const t = await topic();
  const d = await doc(t.id, "aaaa");
  await expect(
    write(token, {
      operation: "documents.patch",
      input: {
        id: d.id,
        expectedVersion: 1,
        find: "aa",
        replace: "b",
        reason: "修正",
      },
      idempotencyKey: "patch",
    }),
  ).rejects.toMatchObject({ code: "PATCH_MATCH_FAILURE" });
  const input = {
    id: d.id,
    expectedVersion: 1,
    title: "全面改訂",
    body: "別の本文",
    reason: "ユーザーが全面改訂を指定",
    confirmRewrite: true as const,
  };
  await expect(
    write(token, {
      operation: "documents.rewrite",
      input: { ...input, confirmRewrite: false } as unknown as typeof input,
      idempotencyKey: "rewrite",
    }),
  ).rejects.toMatchObject({ code: "REWRITE_CONFIRMATION_REQUIRED" });
  await expect(
    write(token, {
      operation: "documents.rewrite",
      input: { ...input, reason: "" },
      idempotencyKey: "rewrite",
    }),
  ).rejects.toMatchObject({ code: "REASON_REQUIRED" });
  await write(token, {
    operation: "documents.rewrite",
    input,
    idempotencyKey: "rewrite",
  });
  expect(await services.getDocument(a, d.id)).toMatchObject({
    title: "全面改訂",
    body: "別の本文",
    version: 2,
  });
});

test("memo replacement and soft deletion are atomic, replay does not redelete restored content, and trash is absent to AI", async () => {
  const token = await connect();
  const id = resourceId(await createMemo(token));
  await write(token, {
    operation: "memos.replace",
    input: { id, body: "置換した本文", expectedVersion: 1 },
    idempotencyKey: "replace",
  });
  const request = {
    operation: "content.delete" as const,
    input: { kind: "memo" as const, id, expectedVersion: 2 },
    idempotencyKey: "delete",
  };
  expect((await write(token, request)).resource).toBeNull();
  await expect(
    services.executeAi(token, { operation: "memos.get", input: { id } }),
  ).rejects.toMatchObject({ code: "MEMO_NOT_FOUND" });
  await expect(
    write(token, { ...request, idempotencyKey: "delete2" }),
  ).rejects.toMatchObject({ code: "MEMO_NOT_FOUND" });
  await services.restore(a, { kind: "memo", id });
  await write(token, request);
  expect((await services.getMemo(a, id)).body).toBe("置換した本文");
});

test("invalid ownership/source/parent writes and missing idempotency key fail without partial documents", async () => {
  const token = await connect();
  const t = await topic();
  const foreign = await services.createMemo(b, { body: "秘密" });
  for (const input of [
    { topicId: t.id, sourceMemoIds: [foreign.id] },
    { topicId: "missing", sourceMemoIds: [] },
  ])
    await expect(
      write(token, {
        operation: "documents.create",
        input: { ...input, title: "文書", body: "本文", reason: "作成" },
        idempotencyKey: "doc",
      }),
    ).rejects.toMatchObject({ name: "NotFoundError" });
  await expect(
    services.executeAi(token, {
      operation: "memos.create",
      input: { body: "メモ" },
    } as AiRequest),
  ).rejects.toMatchObject({ code: "IDEMPOTENCY_KEY_REQUIRED" });
  expect(await count("fog_documents")).toBe(0);
  expect(await count("fog_document_revisions")).toBe(0);
  expect(await count("fog_ai_idempotency")).toBe(0);
});

test("forbidden operations cannot be dispatched, connection management is human-only, and revoked credentials reject reads/writes/replays", async () => {
  const token = await connect();
  await createMemo(token);
  for (const operation of [
    "trash",
    "hardDelete",
    "restore",
    "memoHistory",
    "documentHistory",
    "exportData",
    "getSettings",
    "register",
    "executeAi",
  ])
    await expect(
      services.executeAi(token, {
        operation,
        input: {},
        idempotencyKey: "forbidden",
      } as unknown as AiRequest),
    ).rejects.toMatchObject({ code: "AI_OPERATION_FORBIDDEN" });
  const forged = {
    kind: "ai",
    userId: a.userId,
    clientId: "research",
    clientName: "調査AI",
  } as Actor as HumanActor;
  for (const operation of [
    () => services.getAiAuthorization(forged, "bad"),
    () =>
      services.decideAiAuthorization(forged, {
        requestToken: "bad",
        allow: true,
      }),
    () => services.listAiConnections(forged),
    () => services.revokeAiConnection(forged, { id: "bad" }),
  ])
    await expect(operation()).rejects.toMatchObject({ code: "HUMAN_ONLY" });
  const connection = (await services.listAiConnections(a))[0];
  if (!connection) throw new Error("connection");
  expect(await services.listAiConnections(b)).toEqual([]);
  await expect(
    services.revokeAiConnection(b, { id: connection.id }),
  ).rejects.toMatchObject({ code: "AI_CONNECTION_NOT_FOUND" });
  await services.revokeAiConnection(a, { id: connection.id });
  await expect(
    services.executeAi(token, { operation: "guidance", input: {} }),
  ).rejects.toMatchObject({ code: "AI_CONNECTION_UNAUTHORIZED" });
  await expect(createMemo(token)).rejects.toMatchObject({
    code: "AI_CONNECTION_UNAUTHORIZED",
  });
  await expect(createMemo(token, "new")).rejects.toMatchObject({
    code: "AI_CONNECTION_UNAUTHORIZED",
  });
  expect(await services.listAiConnections(a)).toEqual([]);
  const fresh = await connect();
  await createMemo(fresh);
  expect(await count("fog_memos")).toBe(2);
});

test("repeat migration retains P3 data/settings/history and AI credential/ledger state", async () => {
  const token = await connect();
  const receipt = await createMemo(token);
  const id = resourceId(receipt);
  await services.setRetentionDays(a, { retentionDays: 17 });
  await services.softDelete(a, { kind: "memo", id, expectedVersion: 1 });
  await migrateFog(client);
  await migrateFog(client);
  expect((await services.trash(a)).items[0]?.id).toBe(id);
  expect(await services.getSettings(a)).toEqual({ retentionDays: 17 });
  await services.restore(a, { kind: "memo", id });
  expect(await services.memoHistory(a, id)).toHaveLength(1);
  expect(await createMemo(token)).toMatchObject({
    requestId: receipt.requestId,
    replayed: true,
  });
  expect((await client.execute("PRAGMA foreign_key_check")).rows).toEqual([]);
});

test("independent SQLite clients deduplicate concurrent same-key writes in one durable ledger", async () => {
  const token = await connect();
  const peer = createClient({ url: `file:${dir}/app.db` });
  try {
    await peer.execute("PRAGMA journal_mode=WAL");
    await peer.execute("PRAGMA foreign_keys=ON");
    // A synchronous SQLite wait would prevent the peer on this event loop from committing.
    await peer.execute("PRAGMA busy_timeout=0");
    await client.execute("PRAGMA busy_timeout=0");
    const other = await createFogServices({
      unitOfWork: new LibsqlFogUnitOfWork(peer),
      crypto: nodeSecretCrypto,
      clock,
      ids: UuidV7Generator,
      aiClients: clients,
    });
    const request = {
      operation: "memos.create" as const,
      input: { body: "プロセス間で一度" },
      idempotencyKey: "two-clients",
    };
    const results = await Promise.all([
      services.executeAi(token, request),
      other.executeAi(token, request),
    ]);
    expect(results.every((result) => result.kind === "receipt")).toBe(true);
    expect(
      results.map((result) =>
        result.kind === "receipt" ? result.requestId : null,
      )[0],
    ).toBe(
      results.map((result) =>
        result.kind === "receipt" ? result.requestId : null,
      )[1],
    );
    expect(await count("fog_memos")).toBe(1);
    expect(await count("fog_ai_idempotency")).toBe(1);
  } finally {
    peer.close();
  }
});

test("AI deletes document and exact topic set; foreign IDs and deleted edits stay unavailable", async () => {
  const token = await connect();
  const t = await topic();
  const first = await doc(t.id);
  const second = await doc(t.id);
  const foreign = await services.createTopic(b, {
    title: "別所有者",
    description: "",
  });
  await expect(
    write(token, {
      operation: "content.delete",
      input: { kind: "topic", id: foreign.id, expectedVersion: 1 },
      idempotencyKey: "foreign",
    }),
  ).rejects.toMatchObject({ code: "TOPIC_NOT_FOUND" });
  await write(token, {
    operation: "content.delete",
    input: { kind: "document", id: first.id, expectedVersion: 1 },
    idempotencyKey: "doc-delete",
  });
  await write(token, {
    operation: "content.delete",
    input: { kind: "topic", id: t.id, expectedVersion: 1 },
    idempotencyKey: "topic-delete",
  });
  expect(
    (await services.trash(a)).items.find((item) => item.id === t.id)
      ?.setDocumentIds,
  ).toEqual([second.id]);
  await expect(
    services.executeAi(token, {
      operation: "documents.get",
      input: { id: second.id },
    }),
  ).rejects.toMatchObject({ code: "DOCUMENT_NOT_FOUND" });
  await expect(
    write(token, {
      operation: "documents.patch",
      input: {
        id: first.id,
        find: "alpha",
        replace: "beta",
        reason: "修正",
        expectedVersion: 1,
      },
      idempotencyKey: "deleted-edit",
    }),
  ).rejects.toMatchObject({ code: "DOCUMENT_NOT_FOUND" });
  await services.restore(a, { kind: "topic", id: t.id });
  expect((await services.getTopic(a, t.id)).documents.map((d) => d.id)).toEqual(
    [second.id],
  );
});

test("canonical idempotency ignores object key order but rejects changed operation and missing rewrite flag", async () => {
  const token = await connect();
  const t = await topic();
  const first = await write(token, {
    operation: "documents.create",
    input: {
      topicId: t.id,
      title: "資料",
      body: "文書本文",
      sourceMemoIds: [],
      reason: "作成",
    },
    idempotencyKey: "canonical",
  });
  const replay = await write(token, {
    idempotencyKey: "canonical",
    operation: "documents.create",
    input: {
      reason: "作成",
      sourceMemoIds: [],
      body: "文書本文",
      title: "資料",
      topicId: t.id,
    },
  });
  expect(replay).toMatchObject({ requestId: first.requestId, replayed: true });
  await expect(
    write(token, {
      operation: "topics.create",
      input: { title: "別操作", description: "" },
      idempotencyKey: "canonical",
    }),
  ).rejects.toMatchObject({ code: "IDEMPOTENCY_PAYLOAD_MISMATCH" });
  const id = resourceId(first);
  await expect(
    services.executeAi(token, {
      operation: "documents.rewrite",
      input: {
        id,
        title: "改訂",
        body: "本文",
        reason: "改訂",
        expectedVersion: 1,
      },
      idempotencyKey: "rewrite-no-flag",
    } as AiRequest),
  ).rejects.toMatchObject({ code: "REWRITE_CONFIRMATION_REQUIRED" });
  expect(await services.documentHistory(a, id)).toHaveLength(1);
});

test("PKCE S256 matches the standard vector and dangerous even registered callback schemes are rejected", async () => {
  expect(
    nodeSecretCrypto.pkceChallenge(
      "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk",
    ),
  ).toBe("E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM");
  const unsafe = await createFogServices({
    unitOfWork: new LibsqlFogUnitOfWork(client),
    crypto: nodeSecretCrypto,
    clock,
    ids: UuidV7Generator,
    aiClients: [
      {
        id: "unsafe",
        name: "設定不備",
        redirectUris: [
          "javascript:alert(1)",
          "http://public.example/callback",
          "https://user:pass@example.com/callback",
          "https://example.com/callback#fragment",
        ],
      },
    ],
  });
  for (const uri of [
    "javascript:alert(1)",
    "http://public.example/callback",
    "https://user:pass@example.com/callback",
    "https://example.com/callback#fragment",
  ])
    await expect(
      unsafe.beginAiAuthorization({
        clientId: "unsafe",
        redirectUri: uri,
        state: "state",
        codeChallenge: nodeSecretCrypto.pkceChallenge(verifier),
        codeChallengeMethod: "S256",
      }),
    ).rejects.toMatchObject({ code: "INVALID_AI_AUTHORIZATION" });
});

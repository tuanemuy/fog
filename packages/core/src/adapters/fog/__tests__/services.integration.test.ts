import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { type Client, createClient } from "@libsql/client";
import { createFogServices } from "@repo/core/application/fog/services";
import type { FogServices } from "@repo/core/application/fog/types";
import { UuidV7Generator } from "@repo/core/application/ports/idGenerator";
import { afterEach, beforeEach, expect, test } from "vitest";
import { nodeSecretCrypto } from "../crypto";
import { migrateFog } from "../schema";
import { LibsqlFogUnitOfWork } from "../unitOfWork";

let dir: string;
let client: Client;
let services: FogServices;
let now: Date;
const credentials = {
  email: "user@example.com",
  password: "long-enough-password",
};

beforeEach(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), "fog-test-"));
  client = createClient({ url: `file:${dir}/app.db` });
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
});

afterEach(async () => {
  client.close();
  await rm(dir, { recursive: true, force: true });
});

test("registration normalizes email, hashes credentials, and establishes a revocable session", async () => {
  const registered = await services.register({
    ...credentials,
    email: " USER@EXAMPLE.COM ",
  });
  expect(registered.user.email).toBe(credentials.email);
  expect(await services.authenticate(registered.token)).toEqual(
    registered.user,
  );
  expect(await services.authenticate("invalid-token")).toBeNull();
  const secretRows = await client.execute(
    "SELECT password_hash FROM fog_password_credentials",
  );
  expect(secretRows.rows[0]?.password_hash).not.toContain(credentials.password);
  const sessions = await client.execute("SELECT token_hash FROM fog_sessions");
  expect(sessions.rows[0]?.token_hash).not.toEqual(registered.token);
  expect(await services.login(credentials)).toMatchObject({
    user: registered.user,
  });
  await services.logout(registered.token);
  expect(await services.authenticate(registered.token)).toBeNull();
  await expect(services.register(credentials)).rejects.toMatchObject({
    code: "EMAIL_EXISTS",
  });
});

test("session expiration and login attempts use the injected clock", async () => {
  const registered = await services.register(credentials);
  for (let attempt = 0; attempt < 5; attempt++) {
    await expect(
      services.login({ ...credentials, password: "wrong-password" }),
    ).rejects.toMatchObject({ code: "INVALID_CREDENTIALS" });
  }
  await expect(services.login(credentials)).rejects.toMatchObject({
    code: "INVALID_CREDENTIALS",
  });
  now = new Date(now.getTime() + 16 * 60 * 1000);
  expect(await services.login(credentials)).toMatchObject({
    user: registered.user,
  });
  now = new Date(now.getTime() + 31 * 24 * 60 * 60 * 1000);
  expect(await services.authenticate(registered.token)).toBeNull();
});

test("each tenant sees only their memos and every creation includes an immutable first revision", async () => {
  const a = await services.register(credentials);
  const b = await services.register({
    ...credentials,
    email: "other@example.com",
  });
  const memo = await services.createMemo(a.user, {
    body: "雑に残す、日本語のメモ\n原文の改行",
  });
  expect(await services.listMemos(a.user)).toEqual([memo]);
  expect(await services.listMemos(b.user)).toEqual([]);
  await expect(services.getMemo(b.user, memo.id)).rejects.toMatchObject({
    code: "MEMO_NOT_FOUND",
  });
  expect(await services.getMemo(a.user, memo.id)).toEqual(memo);
  expect(
    (await client.execute("SELECT * FROM fog_memo_revisions")).rows,
  ).toMatchObject([
    {
      memo_id: memo.id,
      body: memo.body,
      actor_kind: "human",
      actor_id: a.user.userId,
      version: 1,
    },
  ]);
  client.close();
  client = createClient({ url: `file:${dir}/app.db` });
  const restarted = await createFogServices({
    unitOfWork: new LibsqlFogUnitOfWork(client),
    crypto: nodeSecretCrypto,
    clock: { now: () => now },
    ids: UuidV7Generator,
  });
  expect(await restarted.authenticate(a.token)).toEqual(a.user);
  expect(await restarted.listMemos(a.user)).toEqual([memo]);
});

test("invalid bodies create nothing and transaction failures roll back dependent writes", async () => {
  const a = await services.register(credentials);
  await expect(
    services.createMemo(a.user, { body: " \n " }),
  ).rejects.toMatchObject({ code: "INVALID_MEMO_BODY" });
  const uow = new LibsqlFogUnitOfWork(client);
  await expect(
    uow.run(async (context) => {
      await context.auth.createUser(
        {
          id: "aborted",
          email: "abort@example.com",
          createdAt: now.toISOString(),
        },
        "hash",
      );
      throw new Error("deliberate failure");
    }),
  ).rejects.toMatchObject({ code: "DATABASE_ERROR" });
  expect(
    (await client.execute("SELECT * FROM fog_users WHERE id='aborted'")).rows,
  ).toEqual([]);
  expect(
    (
      await client.execute(
        "SELECT * FROM fog_password_credentials WHERE user_id='aborted'",
      )
    ).rows,
  ).toEqual([]);
  expect(await services.listMemos(a.user)).toEqual([]);
});

test("same-time memos have stable newest-first ordering and invalid account input is rejected", async () => {
  await expect(
    services.register({ ...credentials, password: "short" }),
  ).rejects.toMatchObject({ code: "INVALID_PASSWORD" });
  const a = await services.register(credentials);
  const first = await services.createMemo(a.user, { body: "first" });
  const second = await services.createMemo(a.user, { body: "second" });
  expect((await services.listMemos(a.user)).map((memo) => memo.id)).toEqual([
    second.id,
    first.id,
  ]);
});

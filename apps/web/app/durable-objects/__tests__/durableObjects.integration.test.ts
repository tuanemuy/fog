import {
  reset,
  runDurableObjectAlarm,
  runInDurableObject,
} from "cloudflare:test";
import { env } from "cloudflare:workers";
import type { RpcResult } from "@repo/core/application/identity/contracts";
import type { SemanticCommand } from "@repo/core/application/search/contracts";
import { CloudflareIdentityGateway } from "@repo/core/adapters/cloudflare/identityGateway";
import { afterEach, describe, expect, it } from "vitest";
import type { AccountHomeDurableObject } from "../AccountHomeDurableObject";
import type { IdentityDirectoryDurableObject } from "../IdentityDirectoryDurableObject";
import type { UserDataDurableObject } from "../UserDataDurableObject";

type TestEnv = {
  USER_DATA: DurableObjectNamespace<UserDataDurableObject>;
  IDENTITY_DIRECTORY: DurableObjectNamespace<IdentityDirectoryDurableObject>;
  ACCOUNT_HOME: DurableObjectNamespace<AccountHomeDurableObject>;
};

const bindings = env as unknown as TestEnv;

afterEach(() => reset());

function value<T>(result: RpcResult<T>): T {
  if (!result.ok) throw new Error(result.error.code);
  return result.value;
}

function userData(name: string) {
  return bindings.USER_DATA.get(bindings.USER_DATA.idFromName(name));
}

describe("SQLite Durable Objects", () => {
  it("runs signup, login lookup, and current-user composition through three DOs", async () => {
    const gateway = new CloudflareIdentityGateway(
      bindings.IDENTITY_DIRECTORY as never,
      bindings.ACCOUNT_HOME as never,
      bindings.USER_DATA as never,
      {
        active: { generation: "v2", secret: "active-routing-secret" },
        previous: { generation: "v1", secret: "previous-routing-secret" },
      },
    );
    await gateway.registerWithPassword({
      operationId: "signup-1",
      userId: "user-1",
      email: "user@example.com",
      passwordHash: "encoded-password-hash" as never,
      now: 1,
    });
    expect(await gateway.findPasswordCredential("USER@example.com")).toEqual({
      userId: "user-1",
      passwordHash: "encoded-password-hash",
    });
    expect(await gateway.getCurrentAccount("user-1")).toEqual({
      userId: "user-1",
      email: "user@example.com",
      authMethod: "password",
      trashRetentionDays: 30,
      sessionEpoch: 0,
    });
    await expect(
      gateway.registerWithPassword({
        operationId: "signup-2",
        userId: "user-2",
        email: "user@example.com",
        passwordHash: "another-password-hash" as never,
        now: 2,
      }),
    ).rejects.toMatchObject({ code: "CREDENTIAL_ALREADY_REGISTERED" });
  });

  it("keeps each user's data physically isolated and migrates lazily", async () => {
    const first = userData("user-1");
    const second = userData("user-2");
    await first.initialize({
      operationId: "init-1",
      userId: "user-1",
      now: 1,
    });
    await second.initialize({
      operationId: "init-2",
      userId: "user-2",
      now: 1,
    });
    const command: SemanticCommand = {
      type: "upsert-content",
      operationId: "content-1",
      entry: {
        id: "memo-1",
        kind: "memo",
        title: "東京散歩",
        body: "東京駅から散歩する",
        topicArchived: false,
        sourceLinks: [],
        updatedAt: 2,
      },
    };
    await first.commit(command);

    expect(value(await first.search({ text: "東京駅" })).items).toHaveLength(1);
    expect(value(await second.search({ text: "東京駅" })).items).toHaveLength(
      0,
    );
    await runInDurableObject(first, (_instance, state) => {
      const versions = state.storage.sql
        .exec<{ version: number }>(
          "SELECT version FROM schema_migrations ORDER BY version",
        )
        .toArray();
      expect(versions).toEqual([{ version: 1 }]);
    });
  });

  it("commits lifecycle and FTS projection atomically", async () => {
    const object = userData("lifecycle");
    await object.initialize({
      operationId: "init",
      userId: "lifecycle",
      now: 1,
    });
    await object.commit({
      type: "upsert-content",
      operationId: "create",
      entry: {
        id: "document-1",
        kind: "document",
        title: "設計",
        body: "耐障害性を高める設計",
        topicId: "topic-1",
        topicArchived: true,
        sourceLinks: [{ memoId: "memo-1", label: "出典" }],
        updatedAt: 2,
      },
    });
    const short = value(
      await object.search({ text: "設計", topicId: "topic-1" }),
    );
    expect(short.items[0]).toMatchObject({
      id: "document-1",
      kind: "document",
      topicArchived: true,
      sourceLinks: [{ memoId: "memo-1", label: "出典" }],
    });

    await object.commit({
      type: "trash-content",
      operationId: "trash",
      id: "document-1",
      trashedAt: 3,
    });
    expect(value(await object.search({ text: "設計" })).items).toHaveLength(0);

    await object.commit({
      type: "restore-content",
      operationId: "restore",
      id: "document-1",
      restoredAt: 4,
    });
    expect(value(await object.search({ text: "設計" })).items).toHaveLength(1);

    await object.commit({
      type: "remove-content",
      operationId: "remove",
      id: "document-1",
    });
    expect(value(await object.search({ text: "設計" })).items).toHaveLength(0);
  });

  it("makes credential reservation and activation idempotent", async () => {
    const directory = bindings.IDENTITY_DIRECTORY.get(
      bindings.IDENTITY_DIRECTORY.idFromName("generation-1:0"),
    );
    const input = {
      opaqueKey: "opaque",
      generation: "generation-1",
      canonicalValue: "email:sensitive@example.com",
      kind: "password" as const,
      userId: "user-1",
      operationId: "signup-1",
      passwordHash: "hash" as never,
      now: 1,
      reservationExpiresAt: 60_001,
    };
    expect(await directory.reserve(input)).toMatchObject({ ok: true });
    expect(await directory.reserve(input)).toMatchObject({ ok: true });
    expect(
      await directory.activate({
        opaqueKey: "opaque",
        operationId: "signup-1",
        userId: "user-1",
        now: 2,
      }),
    ).toMatchObject({ ok: true });
    expect(await directory.lookupPassword("opaque")).toMatchObject({
      ok: true,
      value: { userId: "user-1", passwordHash: "hash" },
    });
  });

  it("keeps SSO provider subjects separate and reset tokens one-time", async () => {
    const directory = bindings.IDENTITY_DIRECTORY.get(
      bindings.IDENTITY_DIRECTORY.idFromName("generation-1:1"),
    );
    const base = {
      generation: "generation-1",
      kind: "sso" as const,
      userId: "user-1",
      now: 1,
      reservationExpiresAt: 60_001,
    };
    const google = {
      ...base,
      opaqueKey: "google-subject",
      canonicalValue: "sso:google\u0000same-subject",
      provider: "google",
      operationId: "sso-google",
    };
    const apple = {
      ...base,
      opaqueKey: "apple-subject",
      canonicalValue: "sso:apple\u0000same-subject",
      provider: "apple",
      operationId: "sso-apple",
    };
    expect(await directory.reserve(google)).toMatchObject({ ok: true });
    expect(await directory.reserve(google)).toMatchObject({ ok: true });
    expect(await directory.reserve(apple)).toMatchObject({ ok: true });
    expect(
      await directory.reserve({
        ...google,
        operationId: "racing-operation",
        userId: "user-2",
      }),
    ).toMatchObject({
      ok: false,
      error: { code: "CREDENTIAL_ALREADY_REGISTERED" },
    });

    await directory.storePasswordReset({
      tokenHash: "token",
      userId: "user-1",
      operationId: "reset-1",
      expiresAt: 10,
    });
    expect(await directory.consumePasswordReset("token", 2)).toMatchObject({
      ok: true,
      value: { userId: "user-1" },
    });
    expect(await directory.consumePasswordReset("token", 3)).toMatchObject({
      ok: true,
      value: null,
    });
  });

  it("rolls back the content write when the FTS projection fails", async () => {
    const object = userData("rollback");
    await object.initialize({
      operationId: "init",
      userId: "rollback",
      now: 1,
    });
    await runInDurableObject(object, async (instance, state) => {
      state.storage.sql.exec("DROP TABLE search_fts");
      let failed = false;
      try {
        await (instance as UserDataDurableObject).commit({
          type: "upsert-content",
          operationId: "failing-write",
          entry: {
            id: "memo-failed",
            kind: "memo",
            title: "失敗",
            body: "索引更新が失敗する",
            topicArchived: false,
            sourceLinks: [],
            updatedAt: 2,
          },
        });
      } catch {
        failed = true;
      }
      expect(failed).toBe(true);
      expect(
        state.storage.sql
          .exec<{ count: number }>(
            "SELECT COUNT(*) AS count FROM content WHERE id = 'memo-failed'",
          )
          .one().count,
      ).toBe(0);
    });
  });

  it("rejects Account Home restore and keeps a non-PII deletion authority", async () => {
    const home = bindings.ACCOUNT_HOME.get(
      bindings.ACCOUNT_HOME.idFromName("user-1"),
    );
    await home.beginSignup({
      operationId: "signup",
      userId: "user-1",
      email: "sensitive@example.com",
      opaqueKey: "opaque",
      generation: "generation-1",
      now: 1,
    });
    const deletion = await home.beginDeletion(2);
    await home.finishDeletion(value(deletion).epoch, 3);
    expect(await home.authority()).toEqual({
      ok: true,
      value: { status: "deleted", epoch: 1 },
    });
    expect(await home.restore()).toMatchObject({
      ok: false,
      error: { code: "ACCOUNT_HOME_RESTORE_FORBIDDEN" },
    });
  });

  it("re-schedules a failed persistent job after an alarm delivery", async () => {
    const object = userData("jobs");
    await object.initialize({
      operationId: "init",
      userId: "jobs",
      now: 1,
    });
    await object.enqueueJob({
      id: "job-1",
      kind: "mail",
      payload: {},
      nextRunAt: 1,
      providerIdempotencyKey: "provider-1",
      now: 1,
    });
    expect(await runDurableObjectAlarm(object)).toBe(true);
    await runInDurableObject(object, (_instance, state) => {
      const row = state.storage.sql
        .exec<{ status: string; attempt: number }>(
          "SELECT status, attempt FROM jobs WHERE id = 'job-1'",
        )
        .one();
      expect(row).toEqual({ status: "pending", attempt: 1 });
    });
  });
});

import {
  inDirectoryStorage,
  inUserDataStorage,
  uniqueEmail,
} from "@repo/core/adapters/cloudflare/__tests__/helpers";
import {
  bucketOfEmail,
  createTestContainer,
  registerTestUser,
  TEST_PASSWORD,
} from "@repo/core/adapters/cloudflare/__tests__/testContainer";
import { resetTokenFor } from "@repo/core/adapters/cloudflare/stores/passwordResetTokenStore";
import { isNotFoundError } from "@repo/core/application/errors";
import { isBusinessRuleError } from "@repo/core/domain/error";
import { describe, expect, it } from "vitest";
import { approveAiClientAuthorization } from "../approveAiClientAuthorization";
import { authorizeAiClient } from "../authorizeAiClient";
import { changePassword } from "../changePassword";
import { consumeAuthorizationCode } from "../consumeAuthorizationCode";
import { executePasswordReset } from "../executePasswordReset";
import { listAiClientConnections } from "../listAiClientConnections";
import { requestPasswordReset } from "../requestPasswordReset";
import { revokeAiClientConnection } from "../revokeAiClientConnection";
import { revokeAllAiClientConnections } from "../revokeAllAiClientConnections";

/** `vitest.config.do.ts` hands the state Worker this key. */
const TEST_RESET_TOKEN_KEY = "test-reset-token-key-at-least-32-chars";

type Row = Readonly<{
  id: string;
  client_name: string;
  scope: string;
  status: string;
  revoked_at: number | null;
  last_used_at: number | null;
  created_at_reset_version: number;
  version: number;
}>;

async function rows(userId: string): Promise<Row[]> {
  return inUserDataStorage(userId, (sql) =>
    sql
      .exec<Row>(
        "SELECT id, client_name, scope, status, revoked_at, last_used_at, created_at_reset_version, version FROM ai_client_connections ORDER BY connected_at DESC, id DESC",
      )
      .toArray(),
  );
}

async function expectCode<TGuard extends (error: unknown) => boolean>(
  promise: Promise<unknown>,
  guard: TGuard,
  code: string,
): Promise<void> {
  let caught: unknown = null;
  try {
    await promise;
  } catch (error) {
    caught = error;
  }
  expect(caught).not.toBeNull();
  expect(guard(caught)).toBe(true);
  expect((caught as { code: string }).code).toBe(code);
}

describe("AI client connections — approve, list, authorize, revoke", () => {
  it("records the authorization, guards each call, and revokes irreversibly", async () => {
    const container = createTestContainer();
    const { userId } = await registerTestUser(container);

    const { connectionId } = await approveAiClientAuthorization({
      container,
      input: { userId, clientName: "  Claude Desktop  " },
    });
    const [row] = await rows(userId);
    expect(row).toMatchObject({
      id: connectionId,
      client_name: "Claude Desktop",
      scope: "ai",
      status: "active",
      revoked_at: null,
      last_used_at: null,
      created_at_reset_version: 0,
      version: 0,
    });

    // The same name again is a second connection: one approval, one row.
    const second = await approveAiClientAuthorization({
      container,
      input: { userId, clientName: "Claude Desktop" },
    });
    expect(second.connectionId).not.toBe(connectionId);
    const listed = await listAiClientConnections({
      container,
      input: { userId },
    });
    expect(listed.connections.map((c) => c.status)).toEqual([
      "active",
      "active",
    ]);
    expect(listed.connections[0]?.lastUsedAt).toBeNull();

    // The guard: active answers the name and records usage best-effort.
    const first = await authorizeAiClient({
      container,
      input: { userId, connectionId },
    });
    expect(first).toEqual({ clientName: "Claude Desktop" });
    const used = (await rows(userId)).find((r) => r.id === connectionId);
    expect(used?.last_used_at).not.toBeNull();
    expect(used?.version).toBe(0);
    const usedAt = used?.last_used_at ?? 0;
    await authorizeAiClient({ container, input: { userId, connectionId } });
    const usedAgain = (await rows(userId)).find((r) => r.id === connectionId);
    expect(usedAgain?.last_used_at ?? 0).toBeGreaterThanOrEqual(usedAt);
    expect(
      (
        await listAiClientConnections({ container, input: { userId } })
      ).connections.find((c) => c.connectionId === connectionId)?.lastUsedAt,
    ).not.toBeNull();

    // Revocation: the status column is the authority the next call reads.
    await revokeAiClientConnection({
      container,
      input: { userId, connectionId },
    });
    expect(
      await authorizeAiClient({ container, input: { userId, connectionId } }),
    ).toBeNull();
    const revoked = (await rows(userId)).find((r) => r.id === connectionId);
    expect(revoked?.status).toBe("revoked");
    expect(revoked?.revoked_at).not.toBeNull();
    expect(revoked?.version).toBe(1);
    // Idempotent: nothing moves on a second revocation.
    await revokeAiClientConnection({
      container,
      input: { userId, connectionId },
    });
    expect(
      (await rows(userId)).find((r) => r.id === connectionId)?.version,
    ).toBe(1);
    // The fact stays in the list; the screens choose.
    const after = await listAiClientConnections({
      container,
      input: { userId },
    });
    expect(
      after.connections.find((c) => c.connectionId === connectionId),
    ).toMatchObject({
      status: "revoked",
    });
    expect(
      after.connections.find((c) => c.connectionId === connectionId)?.revokedAt,
    ).not.toBeNull();

    await expectCode(
      revokeAiClientConnection({
        container,
        input: { userId, connectionId: "no-such-connection" },
      }),
      isNotFoundError,
      "CONNECTION_NOT_FOUND",
    );
    await expectCode(
      revokeAiClientConnection({
        container,
        input: { userId, connectionId: "  " },
      }),
      isBusinessRuleError,
      "INVALID_AI_CLIENT_CONNECTION_ID",
    );
    await expectCode(
      approveAiClientAuthorization({
        container,
        input: { userId, clientName: "x".repeat(101) },
      }),
      isBusinessRuleError,
      "INVALID_CLIENT_NAME",
    );
    // Another user's connection id is simply absent here.
    const other = await registerTestUser(container);
    await expectCode(
      revokeAiClientConnection({
        container,
        input: { userId: other.userId, connectionId: second.connectionId },
      }),
      isNotFoundError,
      "CONNECTION_NOT_FOUND",
    );
    expect(
      (await rows(userId)).find((r) => r.id === second.connectionId)?.status,
    ).toBe("active");
  });

  it("revokeAll revokes every active connection, skips the revoked ones, and converges on a re-run", async () => {
    const container = createTestContainer();
    const { userId } = await registerTestUser(container);
    const ids: string[] = [];
    for (let i = 0; i < 3; i += 1) {
      ids.push(
        (
          await approveAiClientAuthorization({
            container,
            input: { userId, clientName: `client-${i}` },
          })
        ).connectionId,
      );
    }
    await revokeAiClientConnection({
      container,
      input: { userId, connectionId: ids[0] ?? "" },
    });
    const outcome = await revokeAllAiClientConnections({
      container,
      input: { userId },
    });
    expect(outcome).toEqual({ revokedCount: 2, failedCount: 0 });
    const again = await revokeAllAiClientConnections({
      container,
      input: { userId },
    });
    expect(again).toEqual({ revokedCount: 0, failedCount: 0 });
    expect((await rows(userId)).map((r) => r.status)).toEqual([
      "revoked",
      "revoked",
      "revoked",
    ]);
    // Every revocation counted once: the versions moved exactly one step.
    expect((await rows(userId)).map((r) => r.version)).toEqual([1, 1, 1]);
  });

  it("a reset completion revokes the connections of the reset version that ended, and not the newer ones", async () => {
    const container = createTestContainer();
    const email = uniqueEmail();
    const { userId } = await registerTestUser(container, { email });
    const old = await approveAiClientAuthorization({
      container,
      input: { userId, clientName: "old" },
    });
    // A password change in between does not move the reset version.
    await changePassword({
      container,
      input: {
        userId,
        currentPassword: TEST_PASSWORD,
        newPassword: "changed-pass-1",
      },
    });
    expect(
      (await rows(userId)).find((r) => r.id === old.connectionId)?.status,
    ).toBe("active");

    await requestPasswordReset({ container, input: { email } });
    const bucket = await bucketOfEmail(email);
    const materials = await inDirectoryStorage(
      bucket.generation,
      bucket.bucketIndex,
      (sql) => {
        const tokenId = sql
          .exec<{ token_id: string }>(
            `SELECT token_id FROM password_reset_tokens WHERE used_at IS NULL AND credential_id IN
               (SELECT credential_id FROM credential_mappings WHERE kind = 'email' AND hmac = ?)`,
            bucket.hmac,
          )
          .one().token_id;
        return resetTokenFor(
          sql,
          {
            resetTokenKey: TEST_RESET_TOKEN_KEY,
            bucket: {
              generation: bucket.generation,
              bucketIndex: bucket.bucketIndex,
            },
          },
          tokenId,
          Date.now(),
        );
      },
    );
    if (materials === null) throw new Error("unreachable");
    await executePasswordReset({
      container,
      input: { token: materials.token, newPassword: "after-reset-pass" },
    });
    expect(
      (await rows(userId)).find((r) => r.id === old.connectionId)?.status,
    ).toBe("revoked");
    // A connection made after the reset belongs to the new version and lives.
    const fresh = await approveAiClientAuthorization({
      container,
      input: { userId, clientName: "new" },
    });
    expect(
      (await rows(userId)).find((r) => r.id === fresh.connectionId)
        ?.created_at_reset_version,
    ).toBe(1);
    expect(
      await authorizeAiClient({
        container,
        input: { userId, connectionId: fresh.connectionId },
      }),
    ).toEqual({ clientName: "new" });
  });

  it("an account that is not active neither authorizes a call nor exchanges a code", async () => {
    const container = createTestContainer();
    const { userId } = await registerTestUser(container);
    const { connectionId } = await approveAiClientAuthorization({
      container,
      input: { userId, clientName: "c" },
    });
    const expiresAt = new Date(Date.now() + 600_000);
    await inUserDataStorage(userId, (sql) => {
      sql.exec("UPDATE account SET status = 'deleting'");
    });
    expect(
      await authorizeAiClient({ container, input: { userId, connectionId } }),
    ).toBeNull();
    expect(
      await consumeAuthorizationCode({
        container,
        input: { userId, jti: "jti-deleting", expiresAt, connectionId },
      }),
    ).toEqual({ ok: false });
    await inUserDataStorage(userId, (sql) => {
      sql.exec("UPDATE account SET status = 'active'");
    });
    expect(
      await authorizeAiClient({ container, input: { userId, connectionId } }),
    ).toEqual({ clientName: "c" });
  });

  it("consumeAuthorizationCode spends a jti once and refuses a revoked connection", async () => {
    const container = createTestContainer();
    const { userId } = await registerTestUser(container);
    const { connectionId } = await approveAiClientAuthorization({
      container,
      input: { userId, clientName: "c" },
    });
    const expiresAt = new Date(Date.now() + 600_000);
    expect(
      await consumeAuthorizationCode({
        container,
        input: { userId, jti: "jti-1", expiresAt, connectionId },
      }),
    ).toEqual({ ok: true, clientName: "c" });
    expect(
      await consumeAuthorizationCode({
        container,
        input: { userId, jti: "jti-1", expiresAt, connectionId },
      }),
    ).toEqual({ ok: false });
    // An expired jti is swept by the next exchange.
    await inUserDataStorage(userId, (sql) => {
      sql.exec(
        "UPDATE oauth_consumed_codes SET expires_at = ? WHERE jti = 'jti-1'",
        Date.now() - 1,
      );
    });
    expect(
      await consumeAuthorizationCode({
        container,
        input: { userId, jti: "jti-2", expiresAt, connectionId },
      }),
    ).toEqual({ ok: true, clientName: "c" });
    expect(
      await inUserDataStorage(userId, (sql) =>
        sql
          .exec<{ jti: string }>("SELECT jti FROM oauth_consumed_codes")
          .toArray(),
      ),
    ).toEqual([{ jti: "jti-2" }]);
    await revokeAiClientConnection({
      container,
      input: { userId, connectionId },
    });
    expect(
      await consumeAuthorizationCode({
        container,
        input: { userId, jti: "jti-3", expiresAt, connectionId },
      }),
    ).toEqual({ ok: false });
  });
});

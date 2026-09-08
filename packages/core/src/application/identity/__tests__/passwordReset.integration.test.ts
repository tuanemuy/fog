import { runDurableObjectAlarm } from "cloudflare:test";
import {
  directoryStubOf,
  inDirectoryStorage,
  inUserDataStorage,
  uniqueEmail,
  userDataStubOf,
} from "@repo/core/adapters/cloudflare/__tests__/helpers";
import {
  bucketOfEmail,
  createTestContainer,
  registerTestUser,
  TEST_PASSWORD,
} from "@repo/core/adapters/cloudflare/__tests__/testContainer";
import type { IdentityDirectoryDurableObject } from "@repo/core/adapters/cloudflare/identityDirectoryDurableObject";
import { isValidationError } from "@repo/core/application/errors";
import { PASSWORD_RESET_REQUESTED } from "@repo/core/domain/identity/passwordResetRequested";
import { describe, expect, it } from "vitest";
import { changePassword } from "../changePassword";
import { executePasswordReset } from "../executePasswordReset";
import {
  resumeCredentialChangeOperationKey,
  SWEEP_RESET_TOKENS_OPERATION_KEY,
} from "../jobKeys";
import { loginWithPassword } from "../loginWithPassword";
import { registerOrLoginWithSso } from "../registerOrLoginWithSso";
import { requestPasswordReset } from "../requestPasswordReset";
import { resumeSignupOperationKey } from "../reserveSignupCredential";
import { revokeAllAiClientConnections } from "../revokeAllAiClientConnections";

type OutboxRow = Readonly<{
  id: string;
  type: string;
  payload: string;
  aggregate_id: string;
  status: string;
  owner_token: string | null;
}>;

type TokenRow = Readonly<{
  token_id: string;
  credential_id: string;
  used_at: number | null;
  change_auth_token: string | null;
  expires_at: number;
}>;

type MappingRow = Readonly<{
  credential_id: string;
  status: string;
  user_id: string | null;
  password_verifier: string | null;
  pending_verifier: string | null;
  change_state: string | null;
  change_origin: string | null;
  operation_id: string | null;
  credential_version: number;
  failed_attempts: number;
}>;

type AccountRow = Readonly<{
  session_epoch: number;
  reset_version: number;
}>;

type JobRow = Readonly<{
  operation_key: string;
  kind: string;
  status: string;
  next_run_at: number | null;
  terminal_reason: string | null;
}>;

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

async function bucketState(email: string) {
  const bucket = await bucketOfEmail(email);
  // Buckets are shared across the suite, so every read is scoped to this
  // canonical: its window keys, its credential, its mapping row.
  return inDirectoryStorage(bucket.generation, bucket.bucketIndex, (sql) => ({
    outbox: sql
      .exec<OutboxRow>(
        "SELECT id, type, payload, aggregate_id, status, owner_token FROM outbox_events WHERE substr(aggregate_id, 1, ?) = ? ORDER BY created_at",
        bucket.hmac.length + 1,
        `${bucket.hmac}:`,
      )
      .toArray(),
    tokens: sql
      .exec<TokenRow>(
        `SELECT token_id, credential_id, used_at, change_auth_token, expires_at FROM password_reset_tokens
         WHERE credential_id IN (SELECT credential_id FROM credential_mappings WHERE kind = 'email' AND hmac = ?)`,
        bucket.hmac,
      )
      .toArray(),
    windows: sql
      .exec<{ window_key: string; last_requested_at: number }>(
        "SELECT window_key, last_requested_at FROM reset_request_windows WHERE substr(window_key, 1, ?) = ?",
        bucket.hmac.length + 1,
        `${bucket.hmac}:`,
      )
      .toArray(),
    mapping: sql
      .exec<MappingRow>(
        `SELECT credential_id, status, user_id, password_verifier, pending_verifier, change_state, change_origin, operation_id, credential_version, failed_attempts
         FROM credential_mappings WHERE kind = 'email' AND hmac = ?`,
        bucket.hmac,
      )
      .toArray()[0],
    jobs: sql
      .exec<JobRow>(
        "SELECT operation_key, kind, status, next_run_at, terminal_reason FROM jobs",
      )
      .toArray(),
  }));
}

async function accountOf(userId: string): Promise<AccountRow> {
  return inUserDataStorage(userId, (sql) =>
    sql
      .exec<AccountRow>("SELECT session_epoch, reset_version FROM account")
      .one(),
  );
}

/** Publishes the bucket's due outbox rows and runs its due jobs. */
async function wakeBucket(email: string): Promise<void> {
  const bucket = await bucketOfEmail(email);
  await inDirectoryStorage(
    bucket.generation,
    bucket.bucketIndex,
    async (sql, _instance, state) => {
      sql.exec(
        "UPDATE outbox_events SET next_run_at = ? WHERE status = 'pending'",
        Date.now() - 1_000,
      );
      await state.storage.setAlarm(Date.now() + 60_000);
    },
  );
  expect(
    await runDurableObjectAlarm(
      directoryStubOf(bucket.generation, bucket.bucketIndex),
    ),
  ).toBe(true);
}

async function runBucketJob(email: string, operationKey: string) {
  const bucket = await bucketOfEmail(email);
  await inDirectoryStorage(
    bucket.generation,
    bucket.bucketIndex,
    async (sql, _instance, state) => {
      sql.exec(
        "UPDATE jobs SET next_run_at = ? WHERE operation_key = ?",
        Date.now() - 1_000,
        operationKey,
      );
      await state.storage.setAlarm(Date.now() + 60_000);
    },
  );
  expect(
    await runDurableObjectAlarm(
      directoryStubOf(bucket.generation, bucket.bucketIndex),
    ),
  ).toBe(true);
  return (await bucketState(email)).jobs.find(
    (job) => job.operation_key === operationKey,
  );
}

async function materialsFor(
  email: string,
  eventId: string,
  ownerToken: string | null | undefined,
) {
  const bucket = await bucketOfEmail(email);
  const stub = directoryStubOf(
    bucket.generation,
    bucket.bucketIndex,
  ) as unknown as IdentityDirectoryDurableObject;
  const envelope = await stub.getResetMailMaterials({ eventId, ownerToken });
  if (!envelope.ok) throw new Error(envelope.error.message);
  return envelope.value;
}

describe("password reset — request, delivery guard, completion", () => {
  it("issues one token and one event per window, hands the materials out under the guard, and completes the reset", async () => {
    const container = createTestContainer();
    const email = uniqueEmail();
    const { userId } = await registerTestUser(container, { email });
    const before = await accountOf(userId);

    await inUserDataStorage(userId, (sql) => {
      const now = Date.now();
      sql.exec(
        `INSERT INTO ai_client_connections (id, client_name, scope, status, connected_at, revoked_at, last_used_at, created_at_reset_version, version, created_at, updated_at)
         VALUES ('conn-old', 'old client', 'read', 'active', ?, NULL, NULL, ?, 0, ?, ?)`,
        now,
        before.reset_version,
        now,
        now,
      );
    });

    await requestPasswordReset({ container, input: { email } });
    await requestPasswordReset({ container, input: { email } });

    const requested = await bucketState(email);
    expect(requested.outbox).toHaveLength(1);
    const [event] = requested.outbox;
    if (!event) throw new Error("unreachable");
    expect(event.type).toBe(PASSWORD_RESET_REQUESTED);
    expect(requested.tokens).toHaveLength(1);
    const [token] = requested.tokens;
    if (!token) throw new Error("unreachable");
    expect(JSON.parse(event.payload)).toEqual({
      tokenId: token.token_id,
      mailKind: "password-reset",
    });
    expect(
      event.aggregate_id.startsWith(`${(await bucketOfEmail(email)).hmac}:`),
    ).toBe(true);
    expect(requested.windows).toHaveLength(1);
    expect(token.used_at).toBeNull();
    const sweep = requested.jobs.find(
      (job) => job.operation_key === SWEEP_RESET_TOKENS_OPERATION_KEY,
    );
    expect(sweep?.kind).toBe("sweep-reset-tokens");
    expect(sweep?.status).toBe("pending");

    // The relay publishes; the row keeps its owner token for the guard.
    await wakeBucket(email);
    const published = await bucketState(email);
    expect(published.outbox[0]?.status).toBe("published");
    const ownerToken = published.outbox[0]?.owner_token ?? null;
    expect(ownerToken).not.toBeNull();

    // The guard: the right token answers, everything else is the same nothing.
    const materials = await materialsFor(email, event.id, ownerToken);
    expect(materials.kind).toBe("send");
    if (materials.kind !== "send") throw new Error("unreachable");
    expect(materials.to).toBe(email);
    expect(materials.resetToken).toMatch(/^\d+\.\d+\.[A-Za-z0-9_-]{16,}$/);
    expect(materials.providerIdempotencyKey).toMatch(/^[0-9a-f]{64}$/);
    expect(await materialsFor(email, event.id, `${ownerToken}x`)).toEqual({
      kind: "nothing-to-send",
    });
    expect(await materialsFor(email, event.id, "short")).toEqual({
      kind: "nothing-to-send",
    });
    expect(await materialsFor(email, event.id, null)).toEqual({
      kind: "nothing-to-send",
    });
    expect(await materialsFor(email, "no-such-event", ownerToken)).toEqual({
      kind: "nothing-to-send",
    });

    // Completion: a weak password spends nothing.
    await expectCode(
      executePasswordReset({
        container,
        input: { token: materials.resetToken, newPassword: "short" },
      }),
      (e) => (e as { code?: string }).code === "PASSWORD_TOO_WEAK",
      "PASSWORD_TOO_WEAK",
    );
    expect((await bucketState(email)).tokens[0]?.used_at).toBeNull();

    const newPassword = "brand-new-password";
    const result = await executePasswordReset({
      container,
      input: { token: materials.resetToken, newPassword },
    });
    expect(result.userId).toBe(userId);

    const after = await accountOf(userId);
    expect(after.session_epoch).toBe(before.session_epoch + 1);
    expect(after.reset_version).toBe(before.reset_version + 1);
    const done = await bucketState(email);
    expect(done.mapping?.change_state).toBeNull();
    expect(done.mapping?.pending_verifier).toBeNull();
    expect(done.mapping?.credential_version).toBe(2);
    expect(done.tokens[0]?.used_at).not.toBeNull();
    // A spent token no longer feeds the consumer.
    expect(await materialsFor(email, event.id, ownerToken)).toEqual({
      kind: "nothing-to-send",
    });
    // The connections of the previous reset version are revoked; the listing arrives later.
    const connections = await inUserDataStorage(userId, (sql) =>
      sql
        .exec<{ id: string; status: string }>(
          "SELECT id, status FROM ai_client_connections",
        )
        .toArray(),
    );
    expect(connections).toEqual([{ id: "conn-old", status: "revoked" }]);

    // The new password logs in; the old one does not; the link is spent.
    expect(
      (
        await loginWithPassword({
          container,
          input: { email, password: newPassword },
        })
      ).userId,
    ).toBe(userId);
    await expectCode(
      loginWithPassword({
        container,
        input: { email, password: TEST_PASSWORD },
      }),
      isValidationError,
      "INVALID_CREDENTIALS",
    );
    await expectCode(
      executePasswordReset({
        container,
        input: { token: materials.resetToken, newPassword: "another-new-one" },
      }),
      isValidationError,
      "RESET_TOKEN_INVALID",
    );

    // The fallback job finds nothing left to do.
    const operationId = done.mapping?.operation_id;
    const resume = done.jobs.find(
      (job) => job.kind === "resume-credential-change",
    );
    expect(resume?.status).toBe("pending");
    expect(resume?.operation_key).toBe(
      resumeCredentialChangeOperationKey(operationId ?? ""),
    );
    const ran = await runBucketJob(email, resume?.operation_key ?? "");
    expect(ran?.status).toBe("done");
    expect((await accountOf(userId)).session_epoch).toBe(after.session_epoch);
  });

  it("an SSO-only address gets the same event row with a decoy id and no token, and the consumer gets nothing", async () => {
    const container = createTestContainer();
    const email = uniqueEmail();
    await registerOrLoginWithSso({
      container,
      input: { provider: "google", providerSubject: `sub-${email}`, email },
    });
    await requestPasswordReset({ container, input: { email } });
    const state = await bucketState(email);
    expect(state.outbox).toHaveLength(1);
    expect(state.tokens).toHaveLength(0);
    const payload = JSON.parse(state.outbox[0]?.payload ?? "{}") as {
      tokenId: string;
    };
    expect(payload.tokenId).toMatch(/^[A-Za-z0-9_-]{22}$/);
    await wakeBucket(email);
    const published = await bucketState(email);
    expect(
      await materialsFor(
        email,
        published.outbox[0]?.id ?? "",
        published.outbox[0]?.owner_token,
      ),
    ).toEqual({ kind: "nothing-to-send" });
  });

  it("an unknown address writes the same one event row and answers the same silence", async () => {
    const container = createTestContainer();
    const email = uniqueEmail();
    await expect(
      requestPasswordReset({ container, input: { email } }),
    ).resolves.toBeUndefined();
    const state = await bucketState(email);
    expect(state.outbox).toHaveLength(1);
    expect(state.tokens).toHaveLength(0);
    expect(state.windows).toHaveLength(1);
    expect(state.mapping).toBeUndefined();
  });

  it("sweep-reset-tokens deletes expired tokens and windows and finishes", async () => {
    const container = createTestContainer();
    const email = uniqueEmail();
    await registerTestUser(container, { email });
    await requestPasswordReset({ container, input: { email } });
    const bucket = await bucketOfEmail(email);
    await inDirectoryStorage(bucket.generation, bucket.bucketIndex, (sql) => {
      sql.exec(
        "UPDATE password_reset_tokens SET expires_at = ?",
        Date.now() - 1,
      );
      sql.exec(
        "UPDATE reset_request_windows SET expires_at = ?",
        Date.now() - 1,
      );
    });
    const job = await runBucketJob(email, SWEEP_RESET_TOKENS_OPERATION_KEY);
    expect(job?.status).toBe("done");
    const state = await bucketState(email);
    expect(state.tokens).toHaveLength(0);
    expect(state.windows).toHaveLength(0);
  });
});

describe("resume-credential-change — the fallback re-drives a change the request left behind", () => {
  it("completes a `pending` change: apply, advance, promote", async () => {
    const container = createTestContainer();
    const email = uniqueEmail();
    const { userId } = await registerTestUser(container, { email });
    const before = await accountOf(userId);
    const mapping = (await bucketState(email)).mapping;
    if (!mapping) throw new Error("unreachable");
    const coordinate = {
      credentialId: mapping.credential_id,
      kind: "email" as const,
      mapping: `g${(await bucketOfEmail(email)).generation}:b${(await bucketOfEmail(email)).bucketIndex}:${(await bucketOfEmail(email)).hmac}`,
    };
    const operationId = container.idGenerator.next();
    const pendingVerifier = await container.passwordHasher.hash(
      (
        await import("@repo/core/domain/identity/valueObject")
      ).PlainPassword.create("job-driven-password"),
    );
    expect(
      await container.identityGateway.beginCredentialChange(coordinate, {
        operationId,
        userId,
        pendingVerifier,
        origin: "password-change",
        changeAuthToken: null,
      }),
    ).toBe(true);
    expect((await bucketState(email)).mapping?.change_state).toBe("pending");

    const job = await runBucketJob(
      email,
      resumeCredentialChangeOperationKey(operationId),
    );
    expect(job?.status).toBe("done");
    expect(job?.terminal_reason).toBeNull();
    const after = await bucketState(email);
    expect(after.mapping?.change_state).toBeNull();
    expect(after.mapping?.password_verifier).toBe(pendingVerifier);
    expect(after.mapping?.credential_version).toBe(2);
    expect((await accountOf(userId)).session_epoch).toBe(
      before.session_epoch + 1,
    );
    expect((await accountOf(userId)).reset_version).toBe(before.reset_version);
    expect(
      (
        await loginWithPassword({
          container,
          input: { email, password: "job-driven-password" },
        })
      ).userId,
    ).toBe(userId);
  });
});

describe("resume-credential-change — the `advanced` branch", () => {
  it("re-reads the version the User Data side holds and promotes", async () => {
    const container = createTestContainer();
    const email = uniqueEmail();
    const { userId } = await registerTestUser(container, { email });
    const bucket = await bucketOfEmail(email);
    const mapping = (await bucketState(email)).mapping;
    if (!mapping) throw new Error("unreachable");
    const coordinate = {
      credentialId: mapping.credential_id,
      kind: "email" as const,
      mapping: `g${bucket.generation}:b${bucket.bucketIndex}:${bucket.hmac}`,
    };
    const operationId = container.idGenerator.next();
    const pendingVerifier = await container.passwordHasher.hash(
      (
        await import("@repo/core/domain/identity/valueObject")
      ).PlainPassword.create("advanced-password"),
    );
    expect(
      await container.identityGateway.beginCredentialChange(coordinate, {
        operationId,
        userId,
        pendingVerifier,
        origin: "password-change",
        changeAuthToken: null,
      }),
    ).toBe(true);
    // Phase 2 applied and phase 3a recorded; the request died before 3b.
    const applied = await container.identityGateway.applyCredentialChange(
      userId,
      { credentialId: mapping.credential_id, resetCompletion: false },
    );
    expect(
      await container.identityGateway.markCredentialChangeAdvanced(
        coordinate,
        operationId,
      ),
    ).toBe(true);
    expect((await bucketState(email)).mapping?.change_state).toBe("advanced");

    const job = await runBucketJob(
      email,
      resumeCredentialChangeOperationKey(operationId),
    );
    expect(job?.status).toBe("done");
    expect(job?.terminal_reason).toBeNull();
    const after = await bucketState(email);
    expect(after.mapping?.change_state).toBeNull();
    expect(after.mapping?.password_verifier).toBe(pendingVerifier);
    expect(after.mapping?.credential_version).toBe(applied.credentialVersion);
    // Phase 2 ran once: the job did not apply it again.
    expect((await accountOf(userId)).session_epoch).toBe(1);
  });
});

describe("resume-signup after a credential change (B-2)", () => {
  // `credential_mappings.operation_id` is mutable: a change that completes
  // before the signup's re-drive wakes overwrites it. The re-drive must
  // then find nothing to do rather than lose its CAS and run to `poison`.
  it("stays `done` when a password change completed before the re-drive woke up", async () => {
    const container = createTestContainer();
    const email = uniqueEmail();
    const { userId } = await registerTestUser(container, { email });
    await changePassword({
      container,
      input: {
        userId,
        currentPassword: TEST_PASSWORD,
        newPassword: "changed-before-resume",
      },
    });
    const signupOperationId = (
      await inUserDataStorage(userId, (sql) =>
        sql
          .exec<{ operation_id: string }>(
            "SELECT operation_id FROM operations WHERE kind = 'signup'",
          )
          .one(),
      )
    ).operation_id;
    const signup = (await bucketState(email)).jobs.find(
      (job) =>
        job.operation_key === resumeSignupOperationKey(signupOperationId),
    );
    expect(signup?.status).toBe("pending");
    const job = await runBucketJob(email, signup?.operation_key ?? "");
    expect(job?.status).toBe("done");
    expect(job?.terminal_reason).toBeNull();
    // Nothing moved on either side.
    const mapping = (await bucketState(email)).mapping;
    expect(mapping?.status).toBe("active");
    expect(mapping?.change_state).toBeNull();
    expect(
      (
        await loginWithPassword({
          container,
          input: { email, password: "changed-before-resume" },
        })
      ).userId,
    ).toBe(userId);
  });
});

describe("changePassword", () => {
  it("records a wrong current password, then changes on the right one and keeps the reset version", async () => {
    const container = createTestContainer();
    const email = uniqueEmail();
    const { userId } = await registerTestUser(container, { email });
    const before = await accountOf(userId);

    await expectCode(
      changePassword({
        container,
        input: {
          userId,
          currentPassword: "not-the-password",
          newPassword: "another-good-one",
        },
      }),
      isValidationError,
      "CURRENT_PASSWORD_MISMATCH",
    );
    expect((await bucketState(email)).mapping?.failed_attempts).toBe(1);

    await changePassword({
      container,
      input: {
        userId,
        currentPassword: TEST_PASSWORD,
        newPassword: "another-good-one",
      },
    });
    const after = await accountOf(userId);
    expect(after.session_epoch).toBe(before.session_epoch + 1);
    expect(after.reset_version).toBe(before.reset_version);
    const mapping = (await bucketState(email)).mapping;
    expect(mapping?.change_state).toBeNull();
    expect(mapping?.failed_attempts).toBe(0);
    expect(
      (
        await loginWithPassword({
          container,
          input: { email, password: "another-good-one" },
        })
      ).userId,
    ).toBe(userId);
    await expectCode(
      loginWithPassword({
        container,
        input: { email, password: TEST_PASSWORD },
      }),
      isValidationError,
      "INVALID_CREDENTIALS",
    );
  });
});

describe("revokeAllAiClientConnections", () => {
  it("revokes every active connection and reports the count, idempotently", async () => {
    const container = createTestContainer();
    const { userId } = await registerTestUser(container);
    await inUserDataStorage(userId, (sql) => {
      const now = Date.now();
      for (const id of ["a", "b"]) {
        sql.exec(
          `INSERT INTO ai_client_connections (id, client_name, scope, status, connected_at, revoked_at, last_used_at, created_at_reset_version, version, created_at, updated_at)
           VALUES (?, 'c', 'read', 'active', ?, NULL, NULL, 0, 0, ?, ?)`,
          id,
          now,
          now,
          now,
        );
      }
    });
    expect(
      await revokeAllAiClientConnections({ container, input: { userId } }),
    ).toEqual({ revokedCount: 2 });
    expect(
      await revokeAllAiClientConnections({ container, input: { userId } }),
    ).toEqual({ revokedCount: 0 });
    // The stub still answers, so the object was not left half-written.
    expect(await userDataStubOf(userId).readAccountState()).toMatchObject({
      ok: true,
    });
  });
});

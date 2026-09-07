import { runDurableObjectAlarm } from "cloudflare:test";
import {
  directoryStubOf,
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
import {
  isConflictError,
  isValidationError,
} from "@repo/core/application/errors";
import { CALLER_TOKEN_MIN_LENGTH } from "@repo/core/application/identity/callerToken";
import { getCurrentUser } from "@repo/core/application/identity/getCurrentUser";
import { loginWithPassword } from "@repo/core/application/identity/loginWithPassword";
import { registerWithPassword } from "@repo/core/application/identity/registerWithPassword";
import { resumeSignupOperationKey } from "@repo/core/application/identity/reserveSignupCredential";
import { isBusinessRuleError } from "@repo/core/domain/error";
import { PlainPassword } from "@repo/core/domain/identity/valueObject";
import { describe, expect, it } from "vitest";

type OperationRow = Readonly<{
  operation_id: string;
  kind: string;
  phase: string;
  terminal_reason: string | null;
}>;

type AccountRow = Readonly<{
  status: string;
  caller_token: string | null;
  session_epoch: number;
  reset_version: number;
  version: number;
}>;

type LocatorRow = Readonly<{
  credential_id: string;
  kind: string;
  hmac: string;
  generation: number;
  bucket_index: number;
  credential_version: number;
  status: string;
  usable_for_login: number;
  label: string;
}>;

type MappingRow = Readonly<{
  credential_id: string;
  status: string;
  user_id: string | null;
  saga_committed: number | null;
  operation_id: string | null;
  failed_attempts: number;
  next_attempt_allowed_at: number | null;
  password_verifier: string | null;
}>;

type JobRow = Readonly<{
  operation_key: string;
  kind: string;
  status: string;
  attempt: number;
  next_run_at: number | null;
  terminal_reason: string | null;
  payload: string;
}>;

async function readMapping(email: string): Promise<MappingRow> {
  const bucket = await bucketOfEmail(email);
  return inDirectoryStorage(bucket.generation, bucket.bucketIndex, (sql) =>
    sql
      .exec<MappingRow>(
        `SELECT credential_id, status, user_id, saga_committed, operation_id, failed_attempts, next_attempt_allowed_at, password_verifier
         FROM credential_mappings WHERE kind = 'email' AND hmac = ?`,
        bucket.hmac,
      )
      .one(),
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

describe("registerWithPassword — the four-phase saga", () => {
  it("(a) commits both sides and leaves the resume-signup job pending", async () => {
    const container = createTestContainer();
    const email = uniqueEmail();
    const { userId } = await registerTestUser(container, { email });
    expect(container.idGenerator.validate(userId)).toBe(true);

    const userSide = await inUserDataStorage(userId, (sql) => ({
      operations: sql
        .exec<OperationRow>(
          "SELECT operation_id, kind, phase, terminal_reason FROM operations",
        )
        .toArray(),
      locators: sql
        .exec<LocatorRow>(
          "SELECT credential_id, kind, hmac, generation, bucket_index, credential_version, status, usable_for_login, label FROM credential_locators",
        )
        .toArray(),
      account: sql
        .exec<AccountRow>(
          "SELECT status, caller_token, session_epoch, reset_version, version FROM account",
        )
        .toArray(),
      settings: sql
        .exec<{ trash_retention_days: number; version: number }>(
          "SELECT trash_retention_days, version FROM user_settings",
        )
        .toArray(),
    }));

    expect(userSide.operations).toHaveLength(1);
    const operation = userSide.operations[0];
    if (!operation) throw new Error("unreachable");
    expect(operation.kind).toBe("signup");
    expect(operation.phase).toBe("done");
    expect(operation.terminal_reason).toBeNull();

    expect(userSide.locators).toHaveLength(1);
    const locator = userSide.locators[0];
    if (!locator) throw new Error("unreachable");
    expect(locator.kind).toBe("email");
    expect(locator.status).toBe("active");
    expect(locator.usable_for_login).toBe(1);
    expect(locator.credential_version).toBe(1);
    expect(locator.label).toBe("");

    expect(userSide.account).toHaveLength(1);
    const account = userSide.account[0];
    if (!account) throw new Error("unreachable");
    expect(account.status).toBe("active");
    expect(account.caller_token).toHaveLength(32);
    expect(account.caller_token?.length).toBeGreaterThanOrEqual(
      CALLER_TOKEN_MIN_LENGTH,
    );
    expect(account.version).toBe(0);

    expect(userSide.settings).toEqual([
      { trash_retention_days: 30, version: 0 },
    ]);

    const bucket = await bucketOfEmail(email);
    expect(bucket.generation).toBe(locator.generation);
    expect(bucket.bucketIndex).toBe(locator.bucket_index);
    expect(bucket.hmac).toBe(locator.hmac);

    const mapping = await readMapping(email);
    expect(mapping.credential_id).toBe(locator.credential_id);
    expect(mapping.status).toBe("active");
    expect(mapping.saga_committed).toBe(1);
    expect(mapping.user_id).toBe(userId);
    expect(mapping.operation_id).toBe(operation.operation_id);
    expect(mapping.password_verifier).not.toContain(TEST_PASSWORD);

    const job = await inDirectoryStorage(
      bucket.generation,
      bucket.bucketIndex,
      (sql) =>
        sql
          .exec<JobRow>(
            "SELECT operation_key, kind, status, attempt, next_run_at, terminal_reason, payload FROM jobs WHERE operation_key = ?",
            resumeSignupOperationKey(operation.operation_id),
          )
          .one(),
    );
    expect(job.kind).toBe("resume-signup");
    expect(job.status).toBe("pending");
    expect(job.attempt).toBe(0);
    expect(job.next_run_at).not.toBeNull();
    expect(JSON.parse(job.payload)).toMatchObject({
      operationId: operation.operation_id,
    });
  });

  it("(b) re-driving a completed saga through the alarm is idempotent", async () => {
    const container = createTestContainer();
    const email = uniqueEmail();
    const { userId } = await registerTestUser(container, { email });

    const before = await inUserDataStorage(userId, (sql) => ({
      account: sql
        .exec<AccountRow>(
          "SELECT status, caller_token, session_epoch, reset_version, version FROM account",
        )
        .toArray(),
      locators: sql
        .exec<LocatorRow>(
          "SELECT credential_id, kind, hmac, generation, bucket_index, credential_version, status, usable_for_login, label FROM credential_locators ORDER BY credential_id, generation",
        )
        .toArray(),
      operations: sql
        .exec<OperationRow>(
          "SELECT operation_id, kind, phase, terminal_reason FROM operations",
        )
        .toArray(),
    }));
    const operationId = before.operations[0]?.operation_id;
    if (!operationId) throw new Error("unreachable");
    const operationKey = resumeSignupOperationKey(operationId);

    const bucket = await bucketOfEmail(email);
    const stub = directoryStubOf(bucket.generation, bucket.bucketIndex);
    await inDirectoryStorage(
      bucket.generation,
      bucket.bucketIndex,
      async (sql, _instance, state) => {
        sql.exec(
          "UPDATE jobs SET next_run_at = ? WHERE operation_key = ?",
          Date.now() - 1_000,
          operationKey,
        );
        // Armed in the future so workerd does not fire it on its own before
        // `runDurableObjectAlarm` executes it explicitly.
        await state.storage.setAlarm(Date.now() + 60_000);
      },
    );
    expect(await runDurableObjectAlarm(stub)).toBe(true);

    const job = await inDirectoryStorage(
      bucket.generation,
      bucket.bucketIndex,
      (sql) =>
        sql
          .exec<JobRow>(
            "SELECT operation_key, kind, status, attempt, next_run_at, terminal_reason, payload FROM jobs WHERE operation_key = ?",
            operationKey,
          )
          .one(),
    );
    expect(job.status).toBe("done");
    expect(job.terminal_reason).toBeNull();
    expect(job.attempt).toBe(0);

    const after = await inUserDataStorage(userId, (sql) => ({
      account: sql
        .exec<AccountRow>(
          "SELECT status, caller_token, session_epoch, reset_version, version FROM account",
        )
        .toArray(),
      locators: sql
        .exec<LocatorRow>(
          "SELECT credential_id, kind, hmac, generation, bucket_index, credential_version, status, usable_for_login, label FROM credential_locators ORDER BY credential_id, generation",
        )
        .toArray(),
      operations: sql
        .exec<OperationRow>(
          "SELECT operation_id, kind, phase, terminal_reason FROM operations",
        )
        .toArray(),
    }));
    expect(after).toEqual(before);

    const mapping = await readMapping(email);
    expect(mapping.status).toBe("active");
    expect(mapping.user_id).toBe(userId);
    expect(mapping.saga_committed).toBe(1);

    // The re-driven account still logs in.
    const login = await loginWithPassword({
      container,
      input: { email, password: TEST_PASSWORD },
    });
    expect(login.userId).toBe(userId);
  });

  it("(c) a registered address conflicts, including its case and whitespace variants", async () => {
    const container = createTestContainer();
    const local = `dup-${Date.now().toString(36)}-${Math.floor(Math.random() * 1e6)}`;
    const email = `${local}@example.com`;
    const { userId } = await registerTestUser(container, { email });

    await expectCode(
      registerWithPassword({
        container,
        input: { email, password: TEST_PASSWORD },
      }),
      isConflictError,
      "EMAIL_ALREADY_REGISTERED",
    );
    await expectCode(
      registerWithPassword({
        container,
        input: {
          email: `  ${local.toUpperCase()}@Example.COM  `,
          password: "another-password",
        },
      }),
      isConflictError,
      "EMAIL_ALREADY_REGISTERED",
    );

    // The loser initialised no second account: the mapping still names the winner.
    const mapping = await readMapping(email);
    expect(mapping.user_id).toBe(userId);
    expect(mapping.status).toBe("active");
  });

  it("(d) rejects malformed input at value-object construction and accepts the boundaries", async () => {
    const container = createTestContainer();

    await expectCode(
      registerWithPassword({
        container,
        input: { email: "not-an-email", password: TEST_PASSWORD },
      }),
      isBusinessRuleError,
      "INVALID_EMAIL",
    );
    await expectCode(
      registerWithPassword({
        container,
        input: { email: "local@", password: TEST_PASSWORD },
      }),
      isBusinessRuleError,
      "INVALID_EMAIL",
    );
    await expectCode(
      registerWithPassword({
        container,
        input: { email: uniqueEmail(), password: "1234567" },
      }),
      isBusinessRuleError,
      "PASSWORD_TOO_WEAK",
    );
    await expectCode(
      registerWithPassword({
        container,
        input: { email: uniqueEmail(), password: "x".repeat(129) },
      }),
      isBusinessRuleError,
      "PASSWORD_TOO_WEAK",
    );

    const eightChars = "12345678";
    const eight = await registerTestUser(container, { password: eightChars });
    expect(
      (
        await loginWithPassword({
          container,
          input: { email: eight.email, password: eightChars },
        })
      ).userId,
    ).toBe(eight.userId);

    const maxChars = "y".repeat(128);
    const max = await registerTestUser(container, { password: maxChars });
    expect(
      (
        await loginWithPassword({
          container,
          input: { email: max.email, password: maxChars },
        })
      ).userId,
    ).toBe(max.userId);
  });
});

describe("sweep-reservations against the saga mark", () => {
  // Phases 1 and 2 done, the mark written, the coordinator gone before
  // phase 3: the TTL has passed, and the sweep must leave the row alone —
  // it is the only material `resume-signup` has left to finish with.
  it("(h) does not delete a reservation whose saga is committed but not yet activated", async () => {
    const container = createTestContainer();
    const email = uniqueEmail();
    const userId = container.idGenerator.next();
    const credentialId = container.idGenerator.next();
    const operationId = container.idGenerator.next();
    const gateway = container.identityGateway;
    const locator = await gateway.deriveCredentialLocator(
      "email",
      email,
      credentialId,
    );
    const now = Date.now();
    await gateway.reserveCredential(locator, {
      operationId,
      candidateUserId: userId,
      callerToken: "x".repeat(CALLER_TOKEN_MIN_LENGTH),
      canonical: email,
      passwordVerifier: await container.passwordHasher.hash(
        PlainPassword.create(TEST_PASSWORD),
      ),
      reservedUntil: new Date(now + container.identityTuning.reservationTtlMs),
      coordinator: { role: "coordinator", locators: [locator] },
    });
    await gateway.initializeAccount(userId, {
      operationId,
      callerToken: "x".repeat(CALLER_TOKEN_MIN_LENGTH),
      credential: {
        credentialId,
        kind: "email",
        label: "",
        usableForLogin: true,
      },
      locators: [locator],
    });
    expect(await gateway.commitSignupSaga(locator, operationId)).toBe(true);

    const marked = await readMapping(email);
    expect(marked.status).toBe("reserved");
    expect(marked.saga_committed).toBe(1);
    expect(marked.user_id).toBeNull();

    const bucket = await bucketOfEmail(email);
    const stub = directoryStubOf(bucket.generation, bucket.bucketIndex);
    await inDirectoryStorage(
      bucket.generation,
      bucket.bucketIndex,
      async (sql, _instance, state) => {
        // The TTL has run out, the sweep is due, and the re-drive is not.
        sql.exec(
          "UPDATE credential_mappings SET reserved_until = ? WHERE hmac = ?",
          now - 1_000,
          locator.hmac,
        );
        sql.exec(
          "UPDATE jobs SET next_run_at = ? WHERE operation_key = 'sweep-reservations'",
          now - 1_000,
        );
        sql.exec(
          "UPDATE jobs SET next_run_at = ? WHERE operation_key = ?",
          now + 3_600_000,
          resumeSignupOperationKey(operationId),
        );
        await state.storage.setAlarm(Date.now() + 60_000);
      },
    );
    expect(await runDurableObjectAlarm(stub)).toBe(true);

    const swept = await inDirectoryStorage(
      bucket.generation,
      bucket.bucketIndex,
      (sql) =>
        sql
          .exec<{ status: string }>(
            "SELECT status FROM jobs WHERE operation_key = 'sweep-reservations'",
          )
          .toArray(),
    );
    expect(swept.map((row) => row.status)).not.toContain("poison");

    const kept = await readMapping(email);
    expect(kept.status).toBe("reserved");
    expect(kept.saga_committed).toBe(1);
    expect(kept.credential_id).toBe(credentialId);

    // The re-drive still finishes the saga from that row.
    await inDirectoryStorage(
      bucket.generation,
      bucket.bucketIndex,
      async (sql, _instance, state) => {
        sql.exec(
          "UPDATE jobs SET next_run_at = ? WHERE operation_key = ?",
          Date.now() - 1_000,
          resumeSignupOperationKey(operationId),
        );
        await state.storage.setAlarm(Date.now() + 60_000);
      },
    );
    expect(await runDurableObjectAlarm(stub)).toBe(true);
    const active = await readMapping(email);
    expect(active.status).toBe("active");
    expect(active.user_id).toBe(userId);
    const login = await loginWithPassword({
      container,
      input: { email, password: TEST_PASSWORD },
    });
    expect(login.userId).toBe(userId);
  });

  it("(i) deletes an expired reservation that never reached phase 2", async () => {
    const container = createTestContainer();
    const email = uniqueEmail();
    const userId = container.idGenerator.next();
    const credentialId = container.idGenerator.next();
    const operationId = container.idGenerator.next();
    const gateway = container.identityGateway;
    const locator = await gateway.deriveCredentialLocator(
      "email",
      email,
      credentialId,
    );
    const now = Date.now();
    await gateway.reserveCredential(locator, {
      operationId,
      candidateUserId: userId,
      callerToken: "x".repeat(CALLER_TOKEN_MIN_LENGTH),
      canonical: email,
      passwordVerifier: null,
      reservedUntil: new Date(now + container.identityTuning.reservationTtlMs),
      coordinator: { role: "coordinator", locators: [locator] },
    });
    expect((await readMapping(email)).saga_committed).toBeNull();

    const bucket = await bucketOfEmail(email);
    const stub = directoryStubOf(bucket.generation, bucket.bucketIndex);
    await inDirectoryStorage(
      bucket.generation,
      bucket.bucketIndex,
      async (sql, _instance, state) => {
        sql.exec(
          "UPDATE credential_mappings SET reserved_until = ? WHERE hmac = ?",
          now - 1_000,
          locator.hmac,
        );
        sql.exec(
          "UPDATE jobs SET next_run_at = ? WHERE operation_key = 'sweep-reservations'",
          now - 1_000,
        );
        sql.exec(
          "UPDATE jobs SET next_run_at = ? WHERE operation_key = ?",
          now + 3_600_000,
          resumeSignupOperationKey(operationId),
        );
        await state.storage.setAlarm(Date.now() + 60_000);
      },
    );
    expect(await runDurableObjectAlarm(stub)).toBe(true);

    const rows = await inDirectoryStorage(
      bucket.generation,
      bucket.bucketIndex,
      (sql) =>
        sql
          .exec(
            "SELECT status FROM credential_mappings WHERE hmac = ?",
            locator.hmac,
          )
          .toArray(),
    );
    expect(rows).toEqual([]);
  });
});

describe("loginWithPassword", () => {
  it("(e) returns the userId for the right password and INVALID_CREDENTIALS for every failure", async () => {
    const container = createTestContainer();
    const { userId, email } = await registerTestUser(container);

    const ok = await loginWithPassword({
      container,
      input: { email, password: TEST_PASSWORD },
    });
    expect(ok.userId).toBe(userId);

    const normalized = await loginWithPassword({
      container,
      input: { email: `  ${email.toUpperCase()}  `, password: TEST_PASSWORD },
    });
    expect(normalized.userId).toBe(userId);

    const failures: ReadonlyArray<{ email: string; password: string }> = [
      { email, password: "wrong password" },
      { email: uniqueEmail(), password: TEST_PASSWORD },
      { email: "not-an-email", password: TEST_PASSWORD },
      { email, password: "1234567" },
    ];
    const serialized: string[] = [];
    for (const input of failures) {
      let caught: unknown = null;
      try {
        await loginWithPassword({ container, input });
      } catch (error) {
        caught = error;
      }
      expect(isValidationError(caught)).toBe(true);
      if (!isValidationError(caught)) throw new Error("unreachable");
      expect(caught.code).toBe("INVALID_CREDENTIALS");
      serialized.push(JSON.stringify(caught.toSerialized()));
    }
    // Indistinguishable: every failure serializes to the same shape.
    expect(new Set(serialized).size).toBe(1);
  });

  it("(f) locks out after the threshold and a throttled attempt neither succeeds nor counts", async () => {
    const container = createTestContainer();
    const { userId, email } = await registerTestUser(container);
    const threshold = container.identityTuning.loginLockoutThreshold;
    expect(threshold).toBe(5);

    for (let i = 0; i < threshold; i += 1) {
      await expectCode(
        loginWithPassword({
          container,
          // Long enough to pass `PlainPassword`, so the failure reaches the verifier.
          input: { email, password: `wrong-password-${i}` },
        }),
        isValidationError,
        "INVALID_CREDENTIALS",
      );
    }

    const locked = await readMapping(email);
    expect(locked.failed_attempts).toBe(threshold);
    expect(locked.next_attempt_allowed_at).not.toBeNull();
    expect(locked.next_attempt_allowed_at ?? 0).toBeGreaterThan(Date.now());

    // Throttled: the right password is refused and moves no counter.
    await expectCode(
      loginWithPassword({
        container,
        input: { email, password: TEST_PASSWORD },
      }),
      isValidationError,
      "INVALID_CREDENTIALS",
    );
    const stillLocked = await readMapping(email);
    expect(stillLocked.failed_attempts).toBe(threshold);
    expect(stillLocked.next_attempt_allowed_at).toBe(
      locked.next_attempt_allowed_at,
    );
    expect(stillLocked.user_id).toBe(userId);
  });
});

describe("getCurrentUser", () => {
  it("(g) projects the canonical address and the credential summary without verifier material", async () => {
    const container = createTestContainer();
    const rawLocal = `Current-${Date.now().toString(36)}-${Math.floor(Math.random() * 1e6)}`;
    const canonical = `${rawLocal.toLowerCase()}@example.com`;
    const { userId } = await registerTestUser(container, {
      email: `  ${rawLocal}@Example.COM `,
    });

    const credentialId = await inUserDataStorage(
      userId,
      (sql) =>
        sql
          .exec<{ credential_id: string }>(
            "SELECT credential_id FROM credential_locators",
          )
          .one().credential_id,
    );

    const view = await getCurrentUser({ container, input: { userId } });
    expect(view).toEqual({
      userId,
      email: canonical,
      credentials: [
        { kind: "email", label: "", usableForLogin: true, credentialId },
      ],
      trashRetentionDays: 30,
    });

    const json = JSON.stringify(view);
    expect(json).not.toContain(TEST_PASSWORD);
    expect(json.toLowerCase()).not.toContain("verifier");
    expect(json).not.toContain("pbkdf2");
  });
});

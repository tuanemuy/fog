import { runDurableObjectAlarm } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { resumeLinkOperationKey } from "../../../../application/identity/jobKeys";
import { ssoCanonicalOf } from "../../../../application/identity/registerOrLoginWithSso";
import { PlainPassword } from "../../../../domain/identity/valueObject";
import {
  deliveryTuning,
  directoryStubOf,
  inDirectoryStorage,
  inUserDataStorage,
  uniqueEmail,
  userDataStubOf,
} from "../../__tests__/helpers";
import {
  bucketOfEmail,
  createTestContainer,
  registerTestUser,
  TEST_PASSWORD,
} from "../../__tests__/testContainer";

type JobRow = Readonly<{
  operation_key: string;
  kind: string;
  status: string;
  attempt: number;
  terminal_reason: string | null;
  completed_at: number | null;
  payload: string;
}>;

const JOB_COLUMNS =
  "operation_key, kind, status, attempt, terminal_reason, completed_at, payload";

async function directoryJob(
  bucket: { generation: number; bucketIndex: number },
  key: string,
): Promise<JobRow | undefined> {
  return inDirectoryStorage(
    bucket.generation,
    bucket.bucketIndex,
    (sql) =>
      sql
        .exec<JobRow>(
          `SELECT ${JOB_COLUMNS} FROM jobs WHERE operation_key = ?`,
          key,
        )
        .toArray()[0],
  );
}

async function userJob(
  userId: string,
  key: string,
): Promise<JobRow | undefined> {
  return inUserDataStorage(
    userId,
    (sql) =>
      sql
        .exec<JobRow>(
          `SELECT ${JOB_COLUMNS} FROM jobs WHERE operation_key = ?`,
          key,
        )
        .toArray()[0],
  );
}

/** Puts a row into terminal mode by hand: the runner's own write, minus the failure that earns it. */
function forceTerminal(sql: SqlStorage, key: string, reason: string): void {
  sql.exec(
    `UPDATE jobs SET status = 'pending', attempt = 0, terminal_reason = ?, next_run_at = ?, lease_until = NULL, owner_token = NULL, completed_at = NULL
     WHERE operation_key = ?`,
    reason,
    Date.now() - 1_000,
    key,
  );
}

function pullBack(sql: SqlStorage, key: string): void {
  sql.exec(
    "UPDATE jobs SET next_run_at = ? WHERE operation_key = ? AND status = 'pending'",
    Date.now() - 1_000,
    key,
  );
}

async function wakeDirectory(bucket: {
  generation: number;
  bucketIndex: number;
}): Promise<void> {
  await inDirectoryStorage(
    bucket.generation,
    bucket.bucketIndex,
    async (_sql, _i, state) => {
      await state.storage.setAlarm(Date.now() + 60_000);
    },
  );
  expect(
    await runDurableObjectAlarm(
      directoryStubOf(bucket.generation, bucket.bucketIndex),
    ),
  ).toBe(true);
}

async function wakeUser(userId: string): Promise<void> {
  await inUserDataStorage(userId, async (_sql, _i, state) => {
    await state.storage.setAlarm(Date.now() + 60_000);
  });
  expect(await runDurableObjectAlarm(userDataStubOf(userId))).toBe(true);
}

async function callerTokenOf(userId: string): Promise<string> {
  return inUserDataStorage(
    userId,
    (sql) =>
      sql
        .exec<{ caller_token: string }>("SELECT caller_token FROM account")
        .one().caller_token,
  );
}

async function accountOf(userId: string) {
  return inUserDataStorage(userId, (sql) => ({
    account: sql
      .exec<{
        status: string;
        caller_token: string | null;
        session_epoch: number;
        deleted_at: number | null;
      }>("SELECT status, caller_token, session_epoch, deleted_at FROM account")
      .toArray()[0],
    locators: sql
      .exec<{ n: number }>("SELECT count(*) AS n FROM credential_locators")
      .one().n,
    operations: sql
      .exec<{ kind: string; phase: string }>(
        "SELECT kind, phase FROM operations ORDER BY created_at",
      )
      .toArray(),
    connections: sql
      .exec<{ status: string }>("SELECT status FROM ai_client_connections")
      .toArray(),
    jobs: sql
      .exec<{
        operation_key: string;
        status: string;
        terminal_reason: string | null;
      }>("SELECT operation_key, status, terminal_reason FROM jobs")
      .toArray(),
  }));
}

async function emailMapping(email: string) {
  const bucket = await bucketOfEmail(email);
  return inDirectoryStorage(bucket.generation, bucket.bucketIndex, (sql) => ({
    row: sql
      .exec<{
        credential_id: string;
        status: string;
        user_id: string | null;
        operation_id: string | null;
      }>(
        "SELECT credential_id, status, user_id, operation_id FROM credential_mappings WHERE kind = 'email' AND hmac = ?",
        bucket.hmac,
      )
      .toArray()[0],
    tokens: sql
      .exec<{ n: number }>("SELECT count(*) AS n FROM password_reset_tokens")
      .one().n,
  }));
}

/**
 * A registration that got through phase 2 and then died: the coordinator
 * row is `reserved`, the account exists with a `signup` record that is not
 * `done`, the `resume-signup` row is `pending`.
 */
async function stalledSignup() {
  const container = createTestContainer();
  const email = uniqueEmail();
  const gateway = container.identityGateway;
  const userId = container.idGenerator.next();
  const credentialId = container.idGenerator.next();
  const operationId = container.idGenerator.next();
  const callerToken =
    container.tokenGenerator.next() + container.tokenGenerator.next();
  const locator = await gateway.deriveCredentialLocator(
    "email",
    email,
    credentialId,
  );
  await gateway.reserveCredential(locator, {
    saga: "signup",
    operationId,
    candidateUserId: userId,
    callerToken,
    canonical: email,
    passwordVerifier: await container.passwordHasher.hash(
      PlainPassword.create(TEST_PASSWORD),
    ),
    reservedUntil: new Date(Date.now() + 3_600_000),
    coordinator: { role: "coordinator", locators: [locator] },
  });
  await gateway.initializeAccount(userId, {
    operationId,
    callerToken,
    credentials: [
      { credentialId, kind: "email", label: "", usableForLogin: true },
    ],
    locators: [locator],
  });
  const bucket = await bucketOfEmail(email);
  const key = `resume-signup:${operationId}`;
  return {
    container,
    email,
    userId,
    credentialId,
    operationId,
    callerToken,
    locator,
    bucket,
    key,
  };
}

describe("abandon-account: the six checks in order", () => {
  it("an object that was never initialised has nothing to abandon, and stays at zero bytes", async () => {
    const userId = "01950000-0000-7000-8000-0000000000ab";
    expect(
      await userDataStubOf(userId).abandonAccount({
        operationId: "op",
        callerToken: "x".repeat(40),
      }),
    ).toEqual({ ok: true, value: "nothing-to-abandon" });
    expect(await userDataStubOf(userId).readSchemaVersion()).toEqual({
      ok: true,
      value: { schemaVersion: null },
    });
  });

  it("a wrong, short, empty or foreign caller token is refused; a missing or foreign record is nothing; a done record is completed; an open one abandons and enqueues once", async () => {
    const container = createTestContainer();
    const { userId } = await registerTestUser(container);
    const token = await callerTokenOf(userId);
    const stub = userDataStubOf(userId);
    const signupOperationId = await inUserDataStorage(
      userId,
      (sql) =>
        sql
          .exec<{ operation_id: string }>(
            "SELECT operation_id FROM operations WHERE kind = 'signup'",
          )
          .one().operation_id,
    );

    for (const callerToken of [
      "",
      "short",
      `${token.slice(0, -1)}x`,
      "y".repeat(token.length),
    ]) {
      const answer = await stub.abandonAccount({
        operationId: signupOperationId,
        callerToken,
      });
      expect(answer.ok).toBe(false);
    }
    expect(
      await stub.abandonAccount({
        operationId: "no-such-op",
        callerToken: token,
      }),
    ).toEqual({
      ok: true,
      value: "nothing-to-abandon",
    });
    // A completed signup is never abandoned.
    expect(
      await stub.abandonAccount({
        operationId: signupOperationId,
        callerToken: token,
      }),
    ).toEqual({
      ok: true,
      value: "already-completed",
    });
    expect((await accountOf(userId)).account?.status).toBe("active");

    // Reopen the record: the saga is now "not done".
    await inUserDataStorage(userId, (sql) => {
      sql.exec(
        "UPDATE operations SET phase = 'initialized' WHERE kind = 'signup'",
      );
    });
    const before = (await accountOf(userId)).account?.session_epoch ?? -1;
    expect(
      await stub.abandonAccount({
        operationId: signupOperationId,
        callerToken: token,
      }),
    ).toEqual({
      ok: true,
      value: "abandoned",
    });
    const after = await accountOf(userId);
    // Enqueued in the same transaction; the pool fires the due alarm at
    // once, so the withdrawal may be waiting, mid-run on its RPCs, or done
    // (the tombstone does not move the epoch again).
    expect(["deleting", "deleted"]).toContain(after.account?.status);
    expect(after.account?.session_epoch).toBe(before + 1);
    const withdrawal = after.jobs.find(
      (j) => j.operation_key === "finalize-withdrawal",
    );
    expect(["pending", "running", "done"]).toContain(withdrawal?.status);
    // Twice is the same answer, and the check on status comes before the binding.
    expect(
      await stub.abandonAccount({
        operationId: signupOperationId,
        callerToken: "z".repeat(40),
      }),
    ).toEqual({
      ok: true,
      value: "abandoned",
    });
    expect(
      (await accountOf(userId)).jobs.filter(
        (j) => j.operation_key === "finalize-withdrawal",
      ),
    ).toHaveLength(1);
  });
});

describe("resume-signup in terminal mode: S1〜S4 and the withdrawal it starts", () => {
  it("abandons a registration stuck after phase 2: S2 → S3 → S4, then finalize-withdrawal leaves a tombstone", async () => {
    const { email, userId, credentialId, operationId, bucket, key } =
      await stalledSignup();
    expect((await emailMapping(email)).row?.status).toBe("reserved");
    expect((await accountOf(userId)).account?.status).toBe("active");
    // An active AI connection seeded while the account is still active: the
    // last transaction revokes it through the repository (version + 1),
    // and an already revoked one is left as it was.
    const seededAt = Date.now() - 60_000;
    await inUserDataStorage(userId, (sql) => {
      sql.exec(
        `INSERT INTO ai_client_connections (id, client_name, scope, status, connected_at, revoked_at, last_used_at, created_at_reset_version, version, created_at, updated_at)
         VALUES ('01a0aaaa-0000-7000-8000-000000000001', 'Seeded', 'ai', 'active', ?, NULL, NULL, 0, 0, ?, ?),
                ('01a0aaaa-0000-7000-8000-000000000002', 'Old', 'ai', 'revoked', ?, ?, NULL, 0, 1, ?, ?)`,
        seededAt,
        seededAt,
        seededAt,
        seededAt,
        seededAt,
        seededAt,
        seededAt,
      );
    });

    await inDirectoryStorage(bucket.generation, bucket.bucketIndex, (sql) => {
      forceTerminal(sql, key, `forward-exhausted ${operationId}`);
    });
    await wakeDirectory(bucket);

    const job = await directoryJob(bucket, key);
    expect(job).toMatchObject({
      status: "done",
      terminal_reason: `forward-exhausted ${operationId}`,
    });
    expect(job?.completed_at).not.toBeNull();
    // S4: the coordinator's row and its tokens are gone.
    expect((await emailMapping(email)).row).toBeUndefined();
    // S2: the account is on its way out, with the withdrawal enqueued —
    // and, the pool firing a due alarm at once, possibly already gone.
    const abandoned = await accountOf(userId);
    expect(["deleting", "deleted"]).toContain(abandoned.account?.status);
    // The withdrawal's own record appears once its job has run, which the
    // pool may already have done.
    expect(abandoned.operations.filter((o) => o.kind !== "withdrawal")).toEqual(
      [{ kind: "signup", phase: "initialized" }],
    );

    if (abandoned.account?.status === "deleting") {
      await inUserDataStorage(userId, (sql) =>
        pullBack(sql, "finalize-withdrawal"),
      );
      await wakeUser(userId);
    }
    const revoked = await inUserDataStorage(userId, (sql) =>
      sql
        .exec<{
          id: string;
          status: string;
          version: number;
          revoked_at: number | null;
        }>(
          "SELECT id, status, version, revoked_at FROM ai_client_connections ORDER BY id",
        )
        .toArray(),
    );
    expect(revoked.map((c) => [c.status, c.version])).toEqual([
      ["revoked", 1],
      ["revoked", 1],
    ]);
    expect(revoked[0]?.revoked_at).toBeGreaterThan(seededAt);
    expect(revoked[1]?.revoked_at).toBe(seededAt);
    const done = await accountOf(userId);
    expect(done.account).toMatchObject({
      status: "deleted",
      caller_token: null,
    });
    expect(done.account?.deleted_at).not.toBeNull();
    // The withdrawal counts once among the epoch advances: `abandon-account`
    // moved it, the tombstone does not move it again.
    expect(done.account?.session_epoch).toBe(abandoned.account?.session_epoch);
    expect(done.locators).toBe(0);
    // The records stay (the withdrawal never deletes `operations`), the
    // withdrawal's own — its stashed coordinates — among them.
    expect(done.operations).toEqual([
      { kind: "signup", phase: "initialized" },
      { kind: "withdrawal", phase: "done" },
    ]);
    expect(
      done.jobs.find((j) => j.operation_key === "finalize-withdrawal"),
    ).toMatchObject({
      status: "done",
      terminal_reason: null,
    });
    // The tombstone refuses the session's epoch and nothing re-creates the object.
    expect(await userDataStubOf(userId).readAccountState()).toMatchObject({
      ok: true,
      value: { status: "deleted" },
    });
    void credentialId;
  });

  it("a completed saga that somehow enters terminal mode is answered already-completed and nothing is touched", async () => {
    const container = createTestContainer();
    const email = uniqueEmail();
    const { userId } = await registerTestUser(container, { email });
    const bucket = await bucketOfEmail(email);
    const mapping = (await emailMapping(email)).row;
    if (mapping === undefined || mapping.operation_id === null)
      throw new Error("mapping expected");
    const key = `resume-signup:${mapping.operation_id}`;
    // The request path already closed the row; reopen it as a terminal-mode job.
    await inDirectoryStorage(bucket.generation, bucket.bucketIndex, (sql) => {
      forceTerminal(sql, key, `forward-conflict ${mapping.operation_id}`);
    });
    await wakeDirectory(bucket);
    expect(await directoryJob(bucket, key)).toMatchObject({
      status: "done",
      terminal_reason: `forward-conflict ${mapping.operation_id}`,
    });
    expect((await emailMapping(email)).row).toMatchObject({
      status: "active",
      user_id: userId,
    });
    expect((await accountOf(userId)).account?.status).toBe("active");
  });

  it("a coordinator row that is gone, or that belongs to another saga, is lost material: poison at once, and again on re-drive", async () => {
    const { userId, operationId, bucket, key, locator } = await stalledSignup();
    // Another saga now owns the PK: the credential id no longer matches.
    await inDirectoryStorage(bucket.generation, bucket.bucketIndex, (sql) => {
      sql.exec(
        "UPDATE credential_mappings SET credential_id = ? WHERE kind = ? AND hmac = ?",
        "01950000-0000-7000-8000-00000000c0de",
        locator.kind,
        locator.hmac,
      );
      forceTerminal(sql, key, `forward-exhausted ${operationId}`);
    });
    await wakeDirectory(bucket);
    const poisoned = await directoryJob(bucket, key);
    expect(poisoned).toMatchObject({
      status: "poison",
      attempt: 0,
      terminal_reason: `cleanup-material-lost:forward-exhausted ${operationId}`,
    });
    expect(poisoned?.completed_at).not.toBeNull();
    // Nothing was deleted, and the account was not asked to abandon.
    expect((await accountOf(userId)).account?.status).toBe("active");

    // The operator re-drives it: the same verdict, the same six-valued reason.
    const stub = directoryStubOf(bucket.generation, bucket.bucketIndex);
    expect(await stub.requeuePoisonedJob(key)).toEqual({
      ok: true,
      value: { requeued: true },
    });
    // The re-arm's alarm is due at once; the pool may have run it already.
    expect(["pending", "poison"]).toContain(
      (await directoryJob(bucket, key))?.status,
    );
    await inDirectoryStorage(bucket.generation, bucket.bucketIndex, (sql) =>
      pullBack(sql, key),
    );
    await wakeDirectory(bucket);
    expect(await directoryJob(bucket, key)).toMatchObject({
      status: "poison",
      terminal_reason: `cleanup-material-lost:forward-exhausted ${operationId}`,
    });
  });

  it("a cleanup that cannot reach its account backs off, keeps its reason, and burns out with a crown; poison is never pruned", async () => {
    const { operationId, bucket, key } = await stalledSignup();
    // Break the caller binding: S2 is refused with a SystemError every time.
    await inDirectoryStorage(bucket.generation, bucket.bucketIndex, (sql) => {
      sql.exec(
        "UPDATE credential_mappings SET caller_token = ?",
        "z".repeat(64),
      );
      forceTerminal(sql, key, `forward-conflict ${operationId}`);
    });
    for (let i = 0; i < deliveryTuning.jobsMaxAttempts + 1; i++) {
      await inDirectoryStorage(bucket.generation, bucket.bucketIndex, (sql) =>
        pullBack(sql, key),
      );
      await wakeDirectory(bucket);
      const row = await directoryJob(bucket, key);
      if (row?.status === "poison") break;
      expect(row?.status).toBe("pending");
      expect(row?.terminal_reason).toBe(`forward-conflict ${operationId}`);
    }
    const burnt = await directoryJob(bucket, key);
    expect(burnt).toMatchObject({
      status: "poison",
      terminal_reason: `cleanup-exhausted:forward-conflict ${operationId}`,
    });
    // Older than the retention, a poison row survives the prune; a done row does not.
    await inDirectoryStorage(bucket.generation, bucket.bucketIndex, (sql) => {
      const old = Date.now() - deliveryTuning.doneRetentionMs - 60_000;
      sql.exec(
        "UPDATE jobs SET completed_at = ? WHERE operation_key = ?",
        old,
        key,
      );
      sql.exec(
        `INSERT INTO jobs (operation_key, kind, payload, payload_digest, attempt, next_run_at, status, lease_until, owner_token, terminal_reason, completed_at)
         VALUES ('done-row', 'sweep-reservations', '{}', '{}', 0, NULL, 'done', NULL, NULL, NULL, ?)`,
        old,
      );
    });
    await wakeDirectory(bucket);
    expect((await directoryJob(bucket, key))?.status).toBe("poison");
    expect(await directoryJob(bucket, "done-row")).toBeUndefined();
  });
});

describe("resume-link in terminal mode: L1〜L3", () => {
  async function stalledLink() {
    const container = createTestContainer();
    const email = uniqueEmail();
    const { userId } = await registerTestUser(container, { email });
    const subject = `stalled-${email}`;
    const gateway = container.identityGateway;
    const credentialId = container.idGenerator.next();
    const operationId = container.idGenerator.next();
    const canonical = ssoCanonicalOf("google", subject);
    const locator = await gateway.deriveCredentialLocator(
      "sso",
      canonical,
      credentialId,
    );
    const { callerToken } = await gateway.beginLink(userId, {
      operationId,
      credentialId,
      locator,
      label: "google",
    });
    await gateway.reserveCredential(locator, {
      saga: "link",
      operationId,
      candidateUserId: userId,
      callerToken,
      canonical,
      passwordVerifier: null,
      reservedUntil: new Date(Date.now() + 3_600_000),
      coordinator: { role: "coordinator", locators: [locator] },
    });
    const key = resumeLinkOperationKey(operationId);
    const mapping = () =>
      inDirectoryStorage(
        locator.generation,
        locator.bucketIndex,
        (sql) =>
          sql
            .exec<{ status: string }>(
              "SELECT status FROM credential_mappings WHERE kind = 'sso' AND hmac = ?",
              locator.hmac,
            )
            .toArray()[0],
      );
    return { userId, operationId, key, mapping };
  }

  it("hands the reservation back and closes the record with the job's done, keeping the targets", async () => {
    const { userId, operationId, key, mapping } = await stalledLink();
    expect((await mapping())?.status).toBe("reserved");
    await inUserDataStorage(userId, (sql) =>
      forceTerminal(sql, key, `forward-exhausted ${operationId}`),
    );
    await wakeUser(userId);
    expect(await userJob(userId, key)).toMatchObject({
      status: "done",
      terminal_reason: `forward-exhausted ${operationId}`,
    });
    expect(await mapping()).toBeUndefined();
    const side = await inUserDataStorage(userId, (sql) =>
      sql
        .exec<{ phase: string; target_locators: string | null }>(
          "SELECT phase, target_locators FROM operations WHERE operation_id = ?",
          operationId,
        )
        .one(),
    );
    expect(side.phase).toBe("done");
    expect(side.target_locators).not.toBeNull();
    // The account is untouched: still active, epoch unmoved by a link's roll-back.
    expect((await accountOf(userId)).account?.status).toBe("active");
  });

  it("a record that is gone is lost material", async () => {
    const container = createTestContainer();
    const { userId } = await registerTestUser(container);
    const key = "resume-link:no-record";
    await inUserDataStorage(userId, (sql) => {
      sql.exec(
        `INSERT INTO jobs (operation_key, kind, payload, payload_digest, attempt, next_run_at, status, lease_until, owner_token, terminal_reason, completed_at)
         VALUES (?, 'resume-link', ?, ?, 0, ?, 'pending', NULL, NULL, ?, NULL)`,
        key,
        JSON.stringify({ operationId: "no-record" }),
        JSON.stringify({ operationId: "no-record" }),
        Date.now() - 1_000,
        "forward-exhausted no-record",
      );
    });
    await wakeUser(userId);
    expect(await userJob(userId, key)).toMatchObject({
      status: "poison",
      terminal_reason: "cleanup-material-lost:forward-exhausted no-record",
    });
  });
});

describe("resume-credential-change in terminal mode: C1", () => {
  async function pendingChange(userIdOverride: string | null) {
    const container = createTestContainer();
    const email = uniqueEmail();
    const { userId } = await registerTestUser(container, { email });
    const bucket = await bucketOfEmail(email);
    const mapping = (await emailMapping(email)).row;
    if (mapping === undefined) throw new Error("mapping expected");
    const coordinate = {
      credentialId: mapping.credential_id,
      kind: "email" as const,
      mapping: `g${bucket.generation}:b${bucket.bucketIndex}:${bucket.hmac}`,
    };
    const operationId = container.idGenerator.next();
    expect(
      await container.identityGateway.beginCredentialChange(coordinate, {
        operationId,
        userId,
        pendingVerifier: "fake$pending",
        origin: "password-change",
        changeAuthToken: null,
      }),
    ).toBe(true);
    const key = `resume-credential-change:${operationId}`;
    if (userIdOverride !== null) {
      await inDirectoryStorage(bucket.generation, bucket.bucketIndex, (sql) => {
        sql.exec(
          "UPDATE jobs SET payload = json_set(payload, '$.userId', ?) WHERE operation_key = ?",
          userIdOverride,
          key,
        );
      });
    }
    const state = () =>
      inDirectoryStorage(bucket.generation, bucket.bucketIndex, (sql) =>
        sql
          .exec<{
            change_state: string | null;
            pending_verifier: string | null;
            operation_id: string | null;
            credential_version: number;
          }>(
            "SELECT change_state, pending_verifier, operation_id, credential_version FROM credential_mappings WHERE credential_id = ?",
            mapping.credential_id,
          )
          .one(),
      );
    return { userId, bucket, key, operationId, state };
  }

  it("a pending change whose account cannot be reached enters terminal mode at the ceiling and is rolled back, RPC-free", async () => {
    const { userId, bucket, key, operationId, state } = await pendingChange(
      "01950000-0000-7000-8000-00000000dead",
    );
    const epoch = (await accountOf(userId)).account?.session_epoch;
    let row: JobRow | undefined;
    for (let i = 0; i <= deliveryTuning.jobsMaxAttempts + 2; i++) {
      await inDirectoryStorage(bucket.generation, bucket.bucketIndex, (sql) =>
        pullBack(sql, key),
      );
      await wakeDirectory(bucket);
      row = await directoryJob(bucket, key);
      if (row?.status === "done" || row?.status === "poison") break;
      if (row?.terminal_reason !== null) {
        // Entered terminal mode: attempt restarted, still runnable, not completed.
        expect(row?.status).toBe("pending");
        expect(row?.completed_at).toBeNull();
      }
    }
    expect(row).toMatchObject({
      status: "done",
      terminal_reason: `forward-exhausted ${operationId}`,
    });
    expect(await state()).toMatchObject({
      change_state: null,
      pending_verifier: null,
      operation_id: null,
    });
    expect((await accountOf(userId)).account?.session_epoch).toBe(epoch);
  });

  it("an advanced change has no cleanup: it terminates poison with the forward reason, the row untouched", async () => {
    const { bucket, key, operationId, state } = await pendingChange(
      "01950000-0000-7000-8000-00000000dead",
    );
    await inDirectoryStorage(bucket.generation, bucket.bucketIndex, (sql) => {
      sql.exec("UPDATE credential_mappings SET change_state = 'advanced'");
      forceTerminal(sql, key, `forward-exhausted ${operationId}`);
    });
    let row: JobRow | undefined;
    for (let i = 0; i <= deliveryTuning.jobsMaxAttempts + 1; i++) {
      await inDirectoryStorage(bucket.generation, bucket.bucketIndex, (sql) =>
        pullBack(sql, key),
      );
      await wakeDirectory(bucket);
      row = await directoryJob(bucket, key);
      if (row?.status === "poison") break;
    }
    expect(row).toMatchObject({
      status: "poison",
      terminal_reason: `forward-exhausted ${operationId}`,
    });
    expect((await state()).change_state).toBe("advanced");
    expect((await state()).pending_verifier).toBe("fake$pending");
  });

  it("a later change that replaced the row makes the old cleanup a no-op that ends done", async () => {
    const { bucket, key, operationId, state } = await pendingChange(null);
    await inDirectoryStorage(bucket.generation, bucket.bucketIndex, (sql) => {
      sql.exec("UPDATE credential_mappings SET operation_id = 'another-saga'");
      forceTerminal(sql, key, `forward-conflict ${operationId}`);
    });
    await wakeDirectory(bucket);
    expect(await directoryJob(bucket, key)).toMatchObject({ status: "done" });
    expect(await state()).toMatchObject({
      change_state: "pending",
      pending_verifier: "fake$pending",
      operation_id: "another-saga",
    });
  });
});

describe("the kinds without a cleanup, and the re-drive", () => {
  it("sweep-orphan-mapping confirms straight to poison and a re-drive runs it forward again", async () => {
    const container = createTestContainer();
    const { userId } = await registerTestUser(container);
    await inUserDataStorage(userId, (sql, _i, state) => {
      state.storage.transactionSync(() => {
        sql.exec(
          `INSERT INTO operations (operation_id, kind, payload_digest, phase, target_locators, terminal_reason, created_at)
           VALUES ('broken-unlink', 'unlink', '{}', 'deleting', ?, NULL, ?)`,
          JSON.stringify([
            { credentialId: "c", kind: "sso", mapping: "not-a-mapping" },
          ]),
          Date.now(),
        );
        sql.exec(
          `INSERT INTO jobs (operation_key, kind, payload, payload_digest, attempt, next_run_at, status, lease_until, owner_token, terminal_reason, completed_at)
           VALUES ('sweep-orphan-mapping', 'sweep-orphan-mapping', '{}', '{}', 0, ?, 'pending', NULL, NULL, NULL, NULL)`,
          Date.now() - 1_000,
        );
      });
    });
    let row: JobRow | undefined;
    for (let i = 0; i <= deliveryTuning.jobsMaxAttempts + 1; i++) {
      await inUserDataStorage(userId, (sql) =>
        pullBack(sql, "sweep-orphan-mapping"),
      );
      await wakeUser(userId);
      row = await userJob(userId, "sweep-orphan-mapping");
      if (row?.status === "poison") break;
      expect(row?.terminal_reason).toBeNull();
    }
    expect(row).toMatchObject({
      status: "poison",
      terminal_reason: "forward-exhausted",
    });

    const stub = userDataStubOf(userId);
    expect(await stub.requeuePoisonedJob("sweep-orphan-mapping")).toEqual({
      ok: true,
      value: { requeued: true },
    });
    // The re-arm's alarm is due at once and the pool fires it, so the
    // forward run may already have failed once (attempt 1, backoff).
    const requeued = await userJob(userId, "sweep-orphan-mapping");
    expect(requeued).toMatchObject({
      status: "pending",
      completed_at: null,
      terminal_reason: "forward-exhausted",
    });
    expect(requeued?.attempt).toBeLessThanOrEqual(1);
    // Re-driven forward: the same failure re-confirms and the reason is the current one.
    for (let i = 0; i <= deliveryTuning.jobsMaxAttempts + 1; i++) {
      await inUserDataStorage(userId, (sql) =>
        pullBack(sql, "sweep-orphan-mapping"),
      );
      await wakeUser(userId);
      row = await userJob(userId, "sweep-orphan-mapping");
      if (row?.status === "poison") break;
    }
    expect(row).toMatchObject({
      status: "poison",
      terminal_reason: "forward-exhausted",
    });
    expect(await stub.requeuePoisonedJob("no-such-key")).toEqual({
      ok: true,
      value: { requeued: false },
    });
  });
});

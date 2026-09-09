import { runDurableObjectAlarm } from "cloudflare:test";
import { describe, expect, it } from "vitest";
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
} from "../../__tests__/testContainer";

type JobRow = Readonly<{
  operation_key: string;
  kind: string;
  status: string;
  attempt: number;
  terminal_reason: string | null;
  completed_at: number | null;
}>;

// Generation 8000+ is outside the keyring, so no registration lands here
// and the bucket can be broken on purpose.
const BROKEN_BUCKET = { generation: 8002, bucketIndex: 0 } as const;

function insertJob(
  sql: SqlStorage,
  key: string,
  kind: string,
  payload: Record<string, unknown>,
): void {
  sql.exec(
    `INSERT INTO jobs (operation_key, kind, payload, payload_digest, attempt, next_run_at, status, lease_until, owner_token, terminal_reason, completed_at)
     VALUES (?, ?, ?, ?, 0, ?, 'pending', NULL, NULL, NULL, NULL)`,
    key,
    kind,
    JSON.stringify(payload),
    JSON.stringify(payload),
    Date.now() - 1_000,
  );
}

/**
 * Wakes the object until the job leaves the runnable set: each wake-up
 * runs one attempt, the backoff is pulled back to the past between them.
 * Bounded by the attempt ceiling plus one so a job that never terminates
 * fails the test instead of looping.
 */
async function runUntilTerminal(
  stub: DurableObjectStub,
  read: () => Promise<JobRow>,
  pullBack: () => Promise<void>,
): Promise<JobRow> {
  for (let i = 0; i <= deliveryTuning.jobsMaxAttempts + 1; i += 1) {
    await pullBack();
    expect(await runDurableObjectAlarm(stub)).toBe(true);
    const row = await read();
    if (row.status !== "pending" && row.status !== "running") return row;
  }
  throw new Error("the job did not terminate within the attempt ceiling");
}

async function directoryJob(key: string): Promise<JobRow> {
  return inDirectoryStorage(
    BROKEN_BUCKET.generation,
    BROKEN_BUCKET.bucketIndex,
    (sql) =>
      sql
        .exec<JobRow>(
          "SELECT operation_key, kind, status, attempt, terminal_reason, completed_at FROM jobs WHERE operation_key = ?",
          key,
        )
        .one(),
  );
}

async function pullBackDirectory(key: string): Promise<void> {
  await inDirectoryStorage(
    BROKEN_BUCKET.generation,
    BROKEN_BUCKET.bucketIndex,
    async (sql, _instance, state) => {
      sql.exec(
        "UPDATE jobs SET next_run_at = ? WHERE operation_key = ? AND status = 'pending'",
        Date.now() - 1_000,
        key,
      );
      await state.storage.setAlarm(Date.now() + 60_000);
    },
  );
}

async function userJob(userId: string, key: string): Promise<JobRow> {
  return inUserDataStorage(userId, (sql) =>
    sql
      .exec<JobRow>(
        "SELECT operation_key, kind, status, attempt, terminal_reason, completed_at FROM jobs WHERE operation_key = ?",
        key,
      )
      .one(),
  );
}

async function pullBackUser(userId: string, key: string): Promise<void> {
  await inUserDataStorage(userId, async (sql, _instance, state) => {
    sql.exec(
      "UPDATE jobs SET next_run_at = ? WHERE operation_key = ? AND status = 'pending'",
      Date.now() - 1_000,
      key,
    );
    await state.storage.setAlarm(Date.now() + 60_000);
  });
}

// `attempt` counts the retries the backoff pushed out; the attempt that
// crosses the ceiling terminates the row without being counted again.
const POISON_ATTEMPT = deliveryTuning.jobsMaxAttempts - 1;

function expectPoison(row: JobRow, reason: string): void {
  expect(row.status).toBe("poison");
  expect(row.attempt).toBe(POISON_ATTEMPT);
  expect(row.terminal_reason).toBe(reason);
  expect(row.completed_at).not.toBeNull();
}

// R-INF-03 / R-REC-01: a saga job that cannot make progress is retried
// under the runner's backoff and, past the ceiling, confirms non-progress
// — never thrown out of `alarm()`. A kind with a cleanup stage enters
// terminal mode and ends `done` through it; a kind without one ends
// `poison` with `forward-exhausted` (the six-token vocabulary; the
// failure's code goes to the log).
describe("PH-06 job kinds: failure → backoff → confirmation", () => {
  it("sweep-reset-tokens: a bucket whose table is gone", async () => {
    const stub = directoryStubOf(
      BROKEN_BUCKET.generation,
      BROKEN_BUCKET.bucketIndex,
    );
    expect((await stub.readDeliveryBacklog()).ok).toBe(true);
    await inDirectoryStorage(
      BROKEN_BUCKET.generation,
      BROKEN_BUCKET.bucketIndex,
      async (sql, _instance, state) => {
        state.storage.transactionSync(() => {
          insertJob(sql, "sweep-reset-tokens", "sweep-reset-tokens", {});
          sql.exec("DROP TABLE reset_request_windows");
        });
        await state.storage.setAlarm(Date.now() + 60_000);
      },
    );
    const row = await runUntilTerminal(
      stub,
      () => directoryJob("sweep-reset-tokens"),
      () => pullBackDirectory("sweep-reset-tokens"),
    );
    expect(row.status).toBe("poison");
    expect(row.attempt).toBe(POISON_ATTEMPT);
    expect(row.terminal_reason).not.toBeNull();
    expect(row.completed_at).not.toBeNull();
  });

  it("resume-credential-change: a pending change whose account cannot be reached", async () => {
    const container = createTestContainer();
    const email = uniqueEmail();
    const { userId } = await registerTestUser(container, { email });
    const bucket = await bucketOfEmail(email);
    const mapping = await inDirectoryStorage(
      bucket.generation,
      bucket.bucketIndex,
      (sql) =>
        sql
          .exec<{ credential_id: string }>(
            "SELECT credential_id FROM credential_mappings WHERE kind = 'email' AND hmac = ?",
            bucket.hmac,
          )
          .one(),
    );
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
    // The payload names an account that was never initialised: phase 2
    // cannot be applied, and nothing about the row changes by retrying.
    await inDirectoryStorage(bucket.generation, bucket.bucketIndex, (sql) => {
      sql.exec(
        "UPDATE jobs SET payload = json_set(payload, '$.userId', ?) WHERE operation_key = ?",
        "01950000-0000-7000-8000-00000000dead",
        key,
      );
    });
    const stub = directoryStubOf(bucket.generation, bucket.bucketIndex);
    const row = await runUntilTerminal(
      stub,
      () =>
        inDirectoryStorage(bucket.generation, bucket.bucketIndex, (sql) =>
          sql
            .exec<JobRow>(
              "SELECT operation_key, kind, status, attempt, terminal_reason, completed_at FROM jobs WHERE operation_key = ?",
              key,
            )
            .one(),
        ),
      async () => {
        await inDirectoryStorage(
          bucket.generation,
          bucket.bucketIndex,
          async (sql, _instance, state) => {
            sql.exec(
              "UPDATE jobs SET next_run_at = ? WHERE operation_key = ? AND status = 'pending'",
              Date.now() - 1_000,
              key,
            );
            await state.storage.setAlarm(Date.now() + 60_000);
          },
        );
      },
    );
    // PH-09: the ceiling enters terminal mode and C1 rolls the pending
    // change back; the row ends `done` with the forward reason kept.
    expect(row.status).toBe("done");
    expect(row.terminal_reason).toBe(`forward-exhausted ${operationId}`);
    expect(row.completed_at).not.toBeNull();
    const after = await inDirectoryStorage(
      bucket.generation,
      bucket.bucketIndex,
      (sql) =>
        sql
          .exec<{
            change_state: string | null;
            pending_verifier: string | null;
          }>(
            "SELECT change_state, pending_verifier FROM credential_mappings WHERE credential_id = ?",
            mapping.credential_id,
          )
          .one(),
    );
    expect(after.change_state).toBeNull();
    expect(after.pending_verifier).toBeNull();
  });

  it("resume-link: a record that names no locator", async () => {
    const container = createTestContainer();
    const { userId } = await registerTestUser(container);
    const key = "resume-link:broken-link";
    await inUserDataStorage(userId, async (sql, _instance, state) => {
      state.storage.transactionSync(() => {
        sql.exec(
          `INSERT INTO operations (operation_id, kind, payload_digest, phase, target_locators, terminal_reason, created_at)
           VALUES ('broken-link', 'link', '{}', 'reserving', NULL, NULL, ?)`,
          Date.now(),
        );
        insertJob(sql, key, "resume-link", { operationId: "broken-link" });
      });
      await state.storage.setAlarm(Date.now() + 60_000);
    });
    const row = await runUntilTerminal(
      userDataStubOf(userId),
      () => userJob(userId, key),
      () => pullBackUser(userId, key),
    );
    // PH-09: the ceiling enters terminal mode; L1〜L3 find a record with
    // no coordinate to hand back and close it with the job's `done`.
    expect(row.status).toBe("done");
    expect(row.terminal_reason).toBe("forward-exhausted broken-link");
    const closed = await inUserDataStorage(userId, (sql) =>
      sql
        .exec<{ phase: string }>(
          "SELECT phase FROM operations WHERE operation_id = 'broken-link'",
        )
        .one(),
    );
    expect(closed.phase).toBe("done");
  });

  it("sweep-orphan-mapping: an unlink record whose mapping cannot be read", async () => {
    const container = createTestContainer();
    const { userId } = await registerTestUser(container);
    const key = "sweep-orphan-mapping";
    await inUserDataStorage(userId, async (sql, _instance, state) => {
      state.storage.transactionSync(() => {
        sql.exec(
          `INSERT INTO operations (operation_id, kind, payload_digest, phase, target_locators, terminal_reason, created_at)
           VALUES ('broken-unlink', 'unlink', '{}', 'deleting', ?, NULL, ?)`,
          JSON.stringify([
            { credentialId: "c", kind: "sso", mapping: "not-a-mapping" },
          ]),
          Date.now(),
        );
        insertJob(sql, key, "sweep-orphan-mapping", {});
      });
      await state.storage.setAlarm(Date.now() + 60_000);
    });
    const row = await runUntilTerminal(
      userDataStubOf(userId),
      () => userJob(userId, key),
      () => pullBackUser(userId, key),
    );
    expectPoison(row, "forward-exhausted");
    // The record stays open for the operator; nothing was deleted.
    const record = await inUserDataStorage(userId, (sql) =>
      sql
        .exec<{ phase: string }>(
          "SELECT phase FROM operations WHERE operation_id = 'broken-unlink'",
        )
        .one(),
    );
    expect(record.phase).toBe("deleting");
  });
});

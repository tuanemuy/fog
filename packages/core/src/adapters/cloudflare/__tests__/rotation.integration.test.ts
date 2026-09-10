import { describe, expect, it } from "vitest";
import { CALLER_TOKEN_MIN_LENGTH } from "../../../application/identity/callerToken";
import { loginWithPassword } from "../../../application/identity/loginWithPassword";
import type { MappingRowDto } from "../../../application/identity/rotation/transfer";
import { PlainPassword } from "../../../domain/identity/valueObject";
import { openCanonical } from "../crypto/canonicalCipher";
import {
  activeKey,
  createEncryptionKeyring,
  type MappingKeyEntry,
  previousKey,
} from "../crypto/keyring";
import { deriveLocator, encodeMapping } from "../crypto/locatorDerivation";
import { createIdentityGateway } from "../identityGateway";
import {
  deleteSourceRowIfUnchanged,
  insertMappingRowIfAbsent,
  readMappingRowByKey,
} from "../rotation/mappingRows";
import {
  bindings,
  commitmentJsonFor,
  directoryStubOf,
  inDirectoryStorage,
  inUserDataStorage,
  overrideDirectoryEnv,
  TEST_ENCRYPTION_KEY,
  TEST_ENCRYPTION_KEY_G2,
  twoGenerationKeyring,
  uniqueEmail,
  userDataStubOf,
} from "./helpers";
import {
  createTestContainer,
  registerTestUser,
  TEST_PASSWORD,
} from "./testContainer";

type MappingSnapshot = Readonly<{
  credential_id: string;
  hmac: string;
  generation: number;
  user_id: string | null;
  status: string;
  password_verifier: string | null;
  change_state: string | null;
  credential_version: number;
  encrypted_canonical: string;
  encryption_generation: number;
  encryption_nonce: string;
  failed_attempts: number;
  next_attempt_allowed_at: number | null;
  caller_token: string;
  operation_id: string | null;
  saga_committed: number | null;
}>;

const MAPPING_COLUMNS =
  "credential_id, hmac, generation, user_id, status, password_verifier, change_state, credential_version, encrypted_canonical, encryption_generation, encryption_nonce, failed_attempts, next_attempt_allowed_at, caller_token, operation_id, saga_committed";

const forward = twoGenerationKeyring("forward");
const ACTIVE = activeKey(forward);
const PREVIOUS = previousKey(forward) as MappingKeyEntry;
const testEncryptionKeyring = createEncryptionKeyring([
  { role: "active", generation: 1, key: TEST_ENCRYPTION_KEY },
]);

/** A registered account, its generation-1 row and the generation-2 bucket the transfer will land in. */
async function registeredForTransfer(commitment: string) {
  const container = createTestContainer();
  const email = uniqueEmail();
  const source = await deriveLocator(PREVIOUS, "email", email);
  const target = await deriveLocator(ACTIVE, "email", email);
  // Buckets are shared across the suite: an earlier test left this
  // generation-1 bucket committed to generation 2, which refuses the
  // registration (017 / 031). Uncommit it first, then register.
  await overrideDirectoryEnv(source.generation, source.bucketIndex, {
    DIRECTORY_KEY_COMMITMENT: undefined,
  });
  const { userId } = await registerTestUser(container, { email });
  await overrideDirectoryEnv(source.generation, source.bucketIndex, {
    DIRECTORY_KEY_COMMITMENT: commitment,
  });
  await overrideDirectoryEnv(target.generation, target.bucketIndex, {
    DIRECTORY_KEY_COMMITMENT: commitment,
  });
  const row = (
    bucket: { generation: number; bucketIndex: number },
    hmac: string,
  ) =>
    inDirectoryStorage(bucket.generation, bucket.bucketIndex, (sql) =>
      // A bucket no gated RPC has reached yet has no tables and no row.
      sql
        .exec<{ n: number }>(
          "SELECT count(*) AS n FROM sqlite_master WHERE type = 'table' AND name = 'credential_mappings'",
        )
        .one().n === 0
        ? undefined
        : sql
            .exec<MappingSnapshot>(
              `SELECT ${MAPPING_COLUMNS} FROM credential_mappings WHERE kind = 'email' AND hmac = ?`,
              hmac,
            )
            .toArray()[0],
    );
  const locators = () =>
    inUserDataStorage(userId, (sql) =>
      sql
        .exec<{ generation: number; hmac: string; credential_version: number }>(
          "SELECT generation, hmac, credential_version FROM credential_locators ORDER BY generation",
        )
        .toArray(),
    );
  const checkpoint = (
    bucket: { generation: number; bucketIndex: number },
    generation: number,
  ) =>
    inDirectoryStorage(
      bucket.generation,
      bucket.bucketIndex,
      (sql) =>
        sql
          .exec<{
            previous_count: number;
            conflict_count: number;
            last_conflict_credential_id: string | null;
          }>(
            "SELECT previous_count, conflict_count, last_conflict_credential_id FROM rotation_checkpoints WHERE rotation_kind = 'remap' AND bucket_index = ? AND generation = ?",
            bucket.bucketIndex,
            generation,
          )
          .toArray()[0],
    );
  // Buckets are shared across the suite, so a chunk is aimed at this
  // account's row alone: the cursor is the id just below it and the limit
  // is one. Counts other than `remaining` are then this row's.
  const predecessorOf = (credentialId: string) =>
    inDirectoryStorage(
      source.generation,
      source.bucketIndex,
      (sql) =>
        sql
          .exec<{ credential_id: string }>(
            "SELECT credential_id FROM credential_mappings WHERE credential_id < ? ORDER BY credential_id DESC LIMIT 1",
            credentialId,
          )
          .toArray()[0]?.credential_id ?? null,
    );
  const credentialId = async () => {
    const r = await row(source, source.hmac);
    if (r === undefined) throw new Error("source row expected");
    return r.credential_id;
  };
  const rowsLeft = () =>
    inDirectoryStorage(
      source.generation,
      source.bucketIndex,
      (sql) =>
        sql
          .exec<{ n: number }>("SELECT count(*) AS n FROM credential_mappings")
          .one().n,
    );
  const remap = async (
    overrides: Partial<{
      limit: number;
      afterCredentialId: string | null;
      active: MappingKeyEntry;
      previous: MappingKeyEntry;
    }> = {},
  ) =>
    directoryStubOf(source.generation, source.bucketIndex).remapChunk({
      active: ACTIVE,
      previous: PREVIOUS,
      limit: 1,
      afterCredentialId:
        "afterCredentialId" in overrides
          ? (overrides.afterCredentialId ?? null)
          : await predecessorOf(await credentialId()),
      ...overrides,
    });
  return {
    container,
    email,
    userId,
    source,
    target,
    sourceRow: () => row(source, source.hmac),
    targetRow: () => row(target, target.hmac),
    locators,
    checkpoint,
    remap,
    rowsLeft,
    credentialId,
    predecessorOf,
  };
}

describe("remap-chunk: one credential end to end (TC-keyRotation-006 / 007 / 021 / 025 / 039)", () => {
  it("moves an active row s3 → s4 → s5, keeps every other column, records the new locator and the checkpoint", async () => {
    const commitment = await commitmentJsonFor(forward);
    const t = await registeredForTransfer(commitment);

    // 025: the reservation wrote the ciphertext columns and the caller
    // binding; the ciphertext opens to the canonical.
    const before = await t.sourceRow();
    expect(before).toBeDefined();
    if (before === undefined) throw new Error("row expected");
    const callerToken = await inUserDataStorage(
      t.userId,
      (sql) =>
        sql
          .exec<{ caller_token: string }>("SELECT caller_token FROM account")
          .one().caller_token,
    );
    expect(before.caller_token).toBe(callerToken);
    expect(
      await openCanonical(
        testEncryptionKeyring,
        { kind: "email", credentialId: before.credential_id },
        {
          ciphertext: before.encrypted_canonical,
          encryptionGeneration: before.encryption_generation,
          nonce: before.encryption_nonce,
        },
      ),
    ).toBe(t.email);
    // 039: the reverse index is ahead of the row — the new row takes the max.
    await inUserDataStorage(t.userId, (sql) => {
      sql.exec("UPDATE credential_locators SET credential_version = 5");
    });
    // 007: a reset token on the credential goes with the row.
    await inDirectoryStorage(
      t.source.generation,
      t.source.bucketIndex,
      (sql) => {
        sql.exec(
          `INSERT INTO password_reset_tokens (token_id, token_hash, credential_id, expires_at, used_at, change_auth_token, consumed_by_operation_id, token_key_generation, created_at)
         VALUES ('tok-remap', 'h', ?, ?, NULL, NULL, NULL, 1, ?)`,
          before.credential_id,
          Date.now() + 60_000,
          Date.now(),
        );
      },
    );

    const answer = await t.remap();
    expect(answer).toEqual({
      ok: true,
      value: {
        processed: 1,
        skipped: 0,
        remaining: await t.rowsLeft(),
        conflicts: 0,
        lastCredentialId: before.credential_id,
      },
    });

    expect(await t.sourceRow()).toBeUndefined();
    const after = await t.targetRow();
    expect(after).toMatchObject({
      credential_id: before.credential_id,
      generation: 2,
      hmac: t.target.hmac,
      user_id: t.userId,
      status: "active",
      password_verifier: before.password_verifier,
      credential_version: before.credential_version,
      encrypted_canonical: before.encrypted_canonical,
      encryption_generation: before.encryption_generation,
      encryption_nonce: before.encryption_nonce,
      caller_token: before.caller_token,
      operation_id: before.operation_id,
      saga_committed: before.saga_committed,
    });
    // 007: tokens gone with the source row; 006: the old locator row stays.
    const tokens = await inDirectoryStorage(
      t.source.generation,
      t.source.bucketIndex,
      (sql) =>
        sql
          .exec<{ n: number }>(
            "SELECT count(*) AS n FROM password_reset_tokens WHERE credential_id = ?",
            before.credential_id,
          )
          .one().n,
    );
    expect(tokens).toBe(0);
    expect(await t.locators()).toEqual([
      { generation: 1, hmac: t.source.hmac, credential_version: 5 },
      { generation: 2, hmac: t.target.hmac, credential_version: 5 },
    ]);
    expect(await t.checkpoint(t.source, 1)).toEqual({
      previous_count: await t.rowsLeft(),
      conflict_count: 0,
      last_conflict_credential_id: null,
    });

    // 021: the surplus generation row changes nothing the user sees, and
    // login through the two-generation keyring finds the moved row.
    const rotating = createIdentityGateway({
      bindings,
      keyring: forward,
      clock: t.container.clock,
      tuning: t.container.identityTuning,
    });
    const current = await rotating.readCurrentUser(t.userId);
    expect(current?.credentials).toHaveLength(1);
    // The locator version is 5 but the row's is 1: login is refused
    // fail-closed, as the spec's 016 case describes for a stale copy.
    await expect(
      loginWithPassword({
        container: { ...t.container, identityGateway: rotating },
        input: { email: t.email, password: TEST_PASSWORD },
      }),
    ).rejects.toMatchObject({ code: "INVALID_CREDENTIALS" });
    await inUserDataStorage(t.userId, (sql) => {
      sql.exec("UPDATE credential_locators SET credential_version = 1");
    });
    await expect(
      loginWithPassword({
        container: { ...t.container, identityGateway: rotating },
        input: { email: t.email, password: TEST_PASSWORD },
      }),
    ).resolves.toMatchObject({ userId: t.userId });
    // Under the single-generation keyring the account is now unreachable
    // by design: generation 1 holds no row for it any more.
    await expect(
      loginWithPassword({
        container: t.container,
        input: { email: t.email, password: TEST_PASSWORD },
      }),
    ).rejects.toMatchObject({ code: "INVALID_CREDENTIALS" });
    void PlainPassword;
  });

  it("is refused, moving nothing, by every commitment mismatch (001) and by a source that is not the previous generation (002 / 033)", async () => {
    const commitment = await commitmentJsonFor(forward);
    const t = await registeredForTransfer(commitment);
    const forged = (
      entry: MappingKeyEntry,
      patch: Partial<MappingKeyEntry>,
    ) => ({
      ...entry,
      ...patch,
    });
    const refusals: Array<
      Partial<{ active: MappingKeyEntry; previous: MappingKeyEntry }>
    > = [
      {
        active: forged(ACTIVE, {
          key: "forged-directory-routing-secret-0123456789",
        }),
      },
      { active: forged(ACTIVE, { generation: 3 }) },
      { active: forged(ACTIVE, { bucketCount: 32 }) },
      {
        previous: forged(PREVIOUS, {
          key: "forged-directory-routing-secret-0123456789",
        }),
      },
      // The labels swapped: two correct keys driving the transfer backwards.
      {
        active: forged(PREVIOUS, { role: "active" }),
        previous: forged(ACTIVE, { role: "previous" }),
      },
    ];
    for (const refusal of refusals) {
      const answer = await t.remap(refusal);
      expect(answer, JSON.stringify(Object.keys(refusal))).toMatchObject({
        ok: false,
        error: { code: "CONFIGURATION_ERROR" },
      });
      if (!answer.ok) {
        expect(answer.error.message).not.toContain(ACTIVE.key);
        expect(answer.error.message).not.toContain(PREVIOUS.key);
      }
    }
    // 002: the active generation's bucket cannot be a source.
    expect(
      await directoryStubOf(
        t.target.generation,
        t.target.bucketIndex,
      ).remapChunk({
        active: ACTIVE,
        previous: PREVIOUS,
        limit: 10,
        afterCredentialId: null,
      }),
    ).toMatchObject({ ok: false, error: { code: "CONFIGURATION_ERROR" } });
    // 033: the retiring generation's bucket cannot be a destination.
    expect(
      await directoryStubOf(
        t.source.generation,
        t.source.bucketIndex,
      ).importRemappedMappings({
        active: ACTIVE,
        rows: [],
      }),
    ).toMatchObject({ ok: false, error: { code: "CONFIGURATION_ERROR" } });
    // A bucket with no commitment at all refuses too.
    await overrideDirectoryEnv(t.source.generation, t.source.bucketIndex, {
      DIRECTORY_KEY_COMMITMENT: undefined,
    });
    expect(await t.remap()).toMatchObject({
      ok: false,
      error: { code: "CONFIGURATION_ERROR" },
    });
    expect(await t.sourceRow()).toBeDefined();
    expect(await t.targetRow()).toBeUndefined();
    expect(await t.locators()).toHaveLength(1);
  });
});

/** The source row as the transfer reads it. */
async function sourceDto(t: Awaited<ReturnType<typeof registeredForTransfer>>) {
  const dto = await inDirectoryStorage(
    t.source.generation,
    t.source.bucketIndex,
    (sql) => readMappingRowByKey(sql, "email", t.source.hmac),
  );
  if (dto === null) throw new Error("source row expected");
  return dto;
}

/** Pre-places a copy of the source row at its generation-2 coordinate. */
async function placeCopy(
  t: Awaited<ReturnType<typeof registeredForTransfer>>,
  patch: Partial<MappingRowDto>,
): Promise<void> {
  const dto = await sourceDto(t);
  // The first gated RPC initialises the destination bucket.
  expect(
    (
      await directoryStubOf(
        t.target.generation,
        t.target.bucketIndex,
      ).readDeliveryBacklog()
    ).ok,
  ).toBe(true);
  await inDirectoryStorage(t.target.generation, t.target.bucketIndex, (sql) => {
    expect(
      insertMappingRowIfAbsent(sql, {
        ...dto,
        hmac: t.target.hmac,
        generation: 2,
        ...patch,
      }),
    ).toBe(true);
  });
}

async function sourceSql(
  t: Awaited<ReturnType<typeof registeredForTransfer>>,
  statement: string,
  ...bindings: SqlStorageValue[]
): Promise<void> {
  await inDirectoryStorage(t.source.generation, t.source.bucketIndex, (sql) => {
    sql.exec(statement, ...bindings);
  });
}

async function importAtTarget(
  t: Awaited<ReturnType<typeof registeredForTransfer>>,
  rows: MappingRowDto[],
) {
  return directoryStubOf(
    t.target.generation,
    t.target.bucketIndex,
  ).importRemappedMappings({ active: ACTIVE, rows });
}

describe("the guards of import and remap-chunk (TC-keyRotation-003 / 004 / 029)", () => {
  it("003: a row whose canonical or hmac does not verify is rejected per row and nothing is written", async () => {
    const t = await registeredForTransfer(await commitmentJsonFor(forward));
    const dto = await sourceDto(t);
    const copy = { ...dto, hmac: t.target.hmac, generation: 2 };
    expect(
      await importAtTarget(t, [
        { ...copy, encryptedCanonical: `${copy.encryptedCanonical}AA` },
      ]),
    ).toEqual({ ok: true, value: ["rejected"] });
    expect(
      await importAtTarget(t, [{ ...copy, hmac: "b".repeat(64) }]),
    ).toEqual({ ok: true, value: ["rejected"] });
    // The right hmac under the wrong generation label is not verified either.
    expect(await importAtTarget(t, [{ ...copy, generation: 1 }])).toEqual({
      ok: true,
      value: ["rejected"],
    });
    expect(await t.targetRow()).toBeUndefined();
    const count = await inDirectoryStorage(
      t.target.generation,
      t.target.bucketIndex,
      (sql) =>
        sql
          .exec<{ n: number }>(
            "SELECT count(*) AS n FROM credential_mappings WHERE kind = 'email' AND hmac = ?",
            "b".repeat(64),
          )
          .one().n,
    );
    expect(count).toBe(0);
  });

  it("004: each of the three serialisation conditions refuses the chunk, and no checkpoint is written", async () => {
    const t = await registeredForTransfer(await commitmentJsonFor(forward));
    const refused = async (label: string) => {
      expect(await t.remap(), label).toMatchObject({
        ok: false,
        error: { code: "CONFIGURATION_ERROR" },
      });
      expect(await t.sourceRow(), label).toBeDefined();
      expect(await t.targetRow(), label).toBeUndefined();
      expect(await t.checkpoint(t.source, 1), label).toBeUndefined();
    };
    // (i) the encryption keyring carries a previous entry.
    await overrideDirectoryEnv(t.source.generation, t.source.bucketIndex, {
      IDENTITY_MAIL_ENCRYPTION_KEYRING: JSON.stringify([
        { role: "active", generation: 1, key: TEST_ENCRYPTION_KEY },
        { role: "previous", generation: 2, key: TEST_ENCRYPTION_KEY_G2 },
      ]),
    });
    await refused("previous encryption entry");
    await overrideDirectoryEnv(t.source.generation, t.source.bucketIndex, {
      IDENTITY_MAIL_ENCRYPTION_KEYRING: undefined,
    });
    // (ii) a row under a retired encryption generation.
    await sourceSql(
      t,
      "UPDATE credential_mappings SET encryption_generation = 99 WHERE kind = 'email' AND hmac = ?",
      t.source.hmac,
    );
    await refused("retired encryption generation");
    await sourceSql(
      t,
      "UPDATE credential_mappings SET encryption_generation = 1 WHERE kind = 'email' AND hmac = ?",
      t.source.hmac,
    );
    // (iii) a rotate-encryption job that is not done.
    await sourceSql(
      t,
      `INSERT INTO jobs (operation_key, kind, payload, payload_digest, attempt, next_run_at, status, lease_until, owner_token, terminal_reason, completed_at)
       VALUES ('rotate-encryption', 'rotate-encryption', '{}', 'd', 0, ?, 'pending', NULL, NULL, NULL, NULL)`,
      Date.now() + 3_600_000,
    );
    await refused("open rotate-encryption job");
    await sourceSql(
      t,
      "DELETE FROM jobs WHERE operation_key = 'rotate-encryption'",
    );
    // With all three cleared the chunk goes through.
    expect(await t.remap()).toMatchObject({
      ok: true,
      value: { processed: 1, skipped: 0 },
    });
  });

  it("029: a row under a non-active encryption generation is rejected on its own, the other row lands", async () => {
    const t = await registeredForTransfer(await commitmentJsonFor(forward));
    const dto = await sourceDto(t);
    const copy = { ...dto, hmac: t.target.hmac, generation: 2 };
    expect(
      await importAtTarget(t, [{ ...copy, encryptionGeneration: 99 }, copy]),
    ).toEqual({ ok: true, value: ["rejected", "a"] });
    expect(await t.targetRow()).toMatchObject({
      credential_id: dto.credentialId,
      encryption_generation: 1,
    });
  });
});

describe("pass-overs at s1 and s3 (TC-keyRotation-008 / 009 / 032)", () => {
  it("008: a reserved row and a row with a change in flight are left in place and counted", async () => {
    const t = await registeredForTransfer(await commitmentJsonFor(forward));
    const expectSkipped = async () => {
      expect(await t.remap()).toMatchObject({
        ok: true,
        value: { processed: 0, skipped: 1 },
      });
      expect(await t.sourceRow()).toBeDefined();
      expect(await t.targetRow()).toBeUndefined();
      expect(await t.locators()).toHaveLength(1);
    };
    await sourceSql(
      t,
      "UPDATE credential_mappings SET status = 'reserved' WHERE kind = 'email' AND hmac = ?",
      t.source.hmac,
    );
    await expectSkipped();
    await sourceSql(
      t,
      "UPDATE credential_mappings SET status = 'active', change_state = 'pending' WHERE kind = 'email' AND hmac = ?",
      t.source.hmac,
    );
    await expectSkipped();
  });

  it("009: no reverse-index row, or an account that is not active, makes s3 pass the row over without a copy", async () => {
    const t = await registeredForTransfer(await commitmentJsonFor(forward));
    const expectSkipped = async () => {
      expect(await t.remap()).toMatchObject({
        ok: true,
        value: { processed: 0, skipped: 1 },
      });
      expect(await t.sourceRow()).toBeDefined();
      expect(await t.targetRow()).toBeUndefined();
    };
    const saved = await inUserDataStorage(t.userId, (sql) =>
      sql
        .exec<{
          credential_id: string;
          hmac: string;
          credential_version: number;
        }>(
          "SELECT credential_id, hmac, credential_version FROM credential_locators",
        )
        .toArray(),
    );
    await inUserDataStorage(t.userId, (sql) => {
      sql.exec("DELETE FROM credential_locators");
    });
    await expectSkipped();
    expect(await t.locators()).toEqual([]);
    await inUserDataStorage(t.userId, (sql) => {
      for (const row of saved) {
        sql.exec(
          `INSERT INTO credential_locators (credential_id, kind, hmac, generation, bucket_index, credential_version, status, usable_for_login, label, created_at, updated_at)
           VALUES (?, 'email', ?, 1, ?, ?, 'active', 1, '', 0, 0)`,
          row.credential_id,
          row.hmac,
          t.source.bucketIndex,
          row.credential_version,
        );
      }
      sql.exec("UPDATE account SET status = 'deleting'");
    });
    await expectSkipped();
    expect(await t.locators()).toHaveLength(1);
  });

  it("032: record-remapped-locator answers the one-valued skipped for every malformed or mismatched caller token", async () => {
    const t = await registeredForTransfer(await commitmentJsonFor(forward));
    const dto = await sourceDto(t);
    const locator = {
      credentialId: dto.credentialId,
      kind: "email" as const,
      mapping: encodeMapping(t.target),
      credentialVersion: dto.credentialVersion,
      usableForLogin: true,
      label: "",
    };
    const record = (callerToken: string) =>
      userDataStubOf(t.userId).recordRemappedLocator({ callerToken, locator });
    const right = dto.callerToken;
    const wrong = `${"x".repeat(right.length - 1)}${right.at(-1) === "x" ? "y" : "x"}`;
    expect(await record(wrong)).toEqual({ ok: true, value: "skipped" });
    expect(await record("")).toEqual({ ok: true, value: "skipped" });
    expect(await record(right.slice(0, CALLER_TOKEN_MIN_LENGTH - 1))).toEqual({
      ok: true,
      value: "skipped",
    });
    await inUserDataStorage(t.userId, (sql) => {
      sql.exec("UPDATE account SET caller_token = NULL");
    });
    expect(await record(right)).toEqual({ ok: true, value: "skipped" });
    expect(await t.locators()).toHaveLength(1);
    await inUserDataStorage(t.userId, (sql) => {
      sql.exec("UPDATE account SET caller_token = ?", right);
    });
    expect(await record(right)).toEqual({ ok: true, value: "recorded" });
    expect(await t.locators()).toEqual([
      expect.objectContaining({ generation: 1 }),
      expect.objectContaining({ generation: 2, hmac: t.target.hmac }),
    ]);
  });
});

describe("the canonical-row judgement at s4 (TC-keyRotation-011 / 012 / 013 / 014 / 023)", () => {
  it("011 (b): a newer destination is the canonical row; nothing is written there and the source goes", async () => {
    const t = await registeredForTransfer(await commitmentJsonFor(forward));
    await placeCopy(t, {
      credentialVersion: 5,
      passwordVerifier: "dest-verifier",
      failedAttempts: 7,
    });
    expect(await t.remap()).toMatchObject({
      ok: true,
      value: { processed: 1, skipped: 0, conflicts: 0 },
    });
    expect(await t.sourceRow()).toBeUndefined();
    expect(await t.targetRow()).toMatchObject({
      credential_version: 5,
      password_verifier: "dest-verifier",
      failed_attempts: 7,
    });
  });

  it("012 (c): a newer source overwrites the destination under predicate 1, then goes", async () => {
    const t = await registeredForTransfer(await commitmentJsonFor(forward));
    await placeCopy(t, {
      credentialVersion: 1,
      passwordVerifier: "stale-verifier",
      failedAttempts: 7,
    });
    await sourceSql(
      t,
      "UPDATE credential_mappings SET credential_version = 3, password_verifier = 'new-verifier' WHERE kind = 'email' AND hmac = ?",
      t.source.hmac,
    );
    expect(await t.remap()).toMatchObject({
      ok: true,
      value: { processed: 1, skipped: 0, conflicts: 0 },
    });
    expect(await t.sourceRow()).toBeUndefined();
    expect(await t.targetRow()).toMatchObject({
      credential_version: 3,
      password_verifier: "new-verifier",
      failed_attempts: 0,
    });
  });

  it("013 / 023 (d): an equal copy is overwritten idempotently, abuse counters included, to the one-shot end state", async () => {
    const t = await registeredForTransfer(await commitmentJsonFor(forward));
    const before = await t.sourceRow();
    await placeCopy(t, { failedAttempts: 7, nextAttemptAllowedAt: 123 });
    expect(await t.remap()).toMatchObject({
      ok: true,
      value: { processed: 1, skipped: 0, conflicts: 0 },
    });
    expect(await t.sourceRow()).toBeUndefined();
    expect(await t.targetRow()).toEqual({
      ...before,
      hmac: t.target.hmac,
      generation: 2,
    });
    // A second chunk with the row gone is a no-op with the same end state.
    expect(
      await t.remap({ afterCredentialId: before?.credential_id ?? null }),
    ).toMatchObject({ ok: true, value: { processed: 0, conflicts: 0 } });
    expect(await t.targetRow()).toEqual({
      ...before,
      hmac: t.target.hmac,
      generation: 2,
    });
  });

  it("014 (e): another account's row at the destination is passed over, both rows stay, the conflict columns record it", async () => {
    const t = await registeredForTransfer(await commitmentJsonFor(forward));
    const dto = await sourceDto(t);
    await placeCopy(t, {
      credentialId: `${dto.credentialId}-other`,
      userId: "01950000-0000-7000-8000-00000000dead",
      failedAttempts: 7,
    });
    expect(await t.remap()).toMatchObject({
      ok: true,
      value: { processed: 0, skipped: 0, conflicts: 1 },
    });
    expect(await t.sourceRow()).toMatchObject({
      credential_id: dto.credentialId,
      credential_version: dto.credentialVersion,
    });
    expect(await t.targetRow()).toMatchObject({
      credential_id: `${dto.credentialId}-other`,
      failed_attempts: 7,
    });
    expect(await t.checkpoint(t.source, 1)).toEqual({
      previous_count: await t.rowsLeft(),
      conflict_count: 1,
      last_conflict_credential_id: dto.credentialId,
    });
  });
});

describe("predicate 2 and the cursor (TC-keyRotation-015 / 034)", () => {
  it("015: the source deletion is conditioned on the version s1 read; a moved row stays for the next chunk", async () => {
    const t = await registeredForTransfer(await commitmentJsonFor(forward));
    const dto = await sourceDto(t);
    await sourceSql(
      t,
      `INSERT INTO password_reset_tokens (token_id, token_hash, credential_id, expires_at, used_at, change_auth_token, consumed_by_operation_id, token_key_generation, created_at)
       VALUES ('tok-015', 'h', ?, ?, NULL, NULL, NULL, 1, ?)`,
      dto.credentialId,
      Date.now() + 60_000,
      Date.now(),
    );
    const tokens = () =>
      inDirectoryStorage(
        t.source.generation,
        t.source.bucketIndex,
        (sql) =>
          sql
            .exec<{ n: number }>(
              "SELECT count(*) AS n FROM password_reset_tokens WHERE credential_id = ?",
              dto.credentialId,
            )
            .one().n,
      );
    expect(
      await inDirectoryStorage(
        t.source.generation,
        t.source.bucketIndex,
        (sql) =>
          deleteSourceRowIfUnchanged(sql, {
            ...dto,
            credentialVersion: dto.credentialVersion + 1,
          }),
      ),
    ).toBe(false);
    expect(await t.sourceRow()).toBeDefined();
    expect(await tokens()).toBe(1);
    expect(
      await inDirectoryStorage(
        t.source.generation,
        t.source.bucketIndex,
        (sql) => deleteSourceRowIfUnchanged(sql, dto),
      ),
    ).toBe(true);
    expect(await t.sourceRow()).toBeUndefined();
    expect(await tokens()).toBe(0);
  });

  it("034: the cursor carries the scan past a wall of pass-overs, and a lost cursor converges from the top", async () => {
    const commitment = await commitmentJsonFor(forward);
    const first = await registeredForTransfer(commitment);
    let second: Awaited<ReturnType<typeof registeredForTransfer>> | null = null;
    for (let i = 0; i < 400 && second === null; i += 1) {
      const email = uniqueEmail();
      const locator = await deriveLocator(PREVIOUS, "email", email);
      if (locator.bucketIndex !== first.source.bucketIndex) continue;
      const container = createTestContainer();
      await overrideDirectoryEnv(
        first.source.generation,
        first.source.bucketIndex,
        {
          DIRECTORY_KEY_COMMITMENT: undefined,
        },
      );
      const { userId } = await registerTestUser(container, { email });
      await overrideDirectoryEnv(
        first.source.generation,
        first.source.bucketIndex,
        {
          DIRECTORY_KEY_COMMITMENT: commitment,
        },
      );
      const target = await deriveLocator(ACTIVE, "email", email);
      await overrideDirectoryEnv(target.generation, target.bucketIndex, {
        DIRECTORY_KEY_COMMITMENT: commitment,
      });
      second = {
        ...first,
        container,
        email,
        userId,
        target,
        sourceRow: () =>
          inDirectoryStorage(
            first.source.generation,
            first.source.bucketIndex,
            (sql) =>
              sql
                .exec<MappingSnapshot>(
                  `SELECT ${MAPPING_COLUMNS} FROM credential_mappings WHERE kind = 'email' AND hmac = ?`,
                  locator.hmac,
                )
                .toArray()[0],
          ),
      };
    }
    if (second === null)
      throw new Error("no second account landed in the bucket");
    const ids = [
      (await first.sourceRow())?.credential_id ?? "",
      (await second.sourceRow())?.credential_id ?? "",
    ].sort();
    const [lower, upper] = ids as [string, string];
    // The lower id is the wall: a reservation the scan passes over. The
    // two registrations are the newest rows of the bucket, so from the
    // wall's predecessor the scan meets exactly these two.
    await sourceSql(
      first,
      "UPDATE credential_mappings SET status = 'reserved' WHERE credential_id = ?",
      lower,
    );
    const start = await first.predecessorOf(lower);
    expect(
      await first.remap({ limit: 1, afterCredentialId: start }),
    ).toMatchObject({
      ok: true,
      value: {
        processed: 0,
        skipped: 1,
        conflicts: 0,
        lastCredentialId: lower,
      },
    });
    expect(
      await first.remap({ limit: 1, afterCredentialId: lower }),
    ).toMatchObject({
      ok: true,
      value: { processed: 1, skipped: 0, lastCredentialId: upper },
    });
    expect(
      await first.remap({ limit: 1, afterCredentialId: upper }),
    ).toMatchObject({
      ok: true,
      value: { processed: 0, skipped: 0, lastCredentialId: null },
    });
    // Without the cursor the scan starts from the top of the bucket: the
    // moved row is not met again, the wall still is, and it converges.
    const whole = await first.remap({ limit: 500, afterCredentialId: null });
    expect(whole).toMatchObject({
      ok: true,
      value: { lastCredentialId: null },
    });
    expect(whole.ok && whole.value.skipped).toBeGreaterThanOrEqual(1);
    expect(await second.sourceRow()).toBeUndefined();
    expect((await first.sourceRow())?.status).toBe("reserved");
  });
});

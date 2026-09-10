import { runDurableObjectAlarm } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import {
  commitmentJsonFor,
  directoryStubOf,
  inDirectoryStorage,
  overrideDirectoryEnv,
  TEST_ENCRYPTION_KEY,
  TEST_ENCRYPTION_KEY_G2,
  twoGenerationKeyring,
  uniqueEmail,
} from "../../__tests__/helpers";
import {
  bucketOfEmail,
  createTestContainer,
  registerTestUser,
} from "../../__tests__/testContainer";
import { openCanonical, sealCanonical } from "../../crypto/canonicalCipher";
import {
  activeKey,
  createEncryptionKeyring,
  type MappingKeyEntry,
  previousKey,
} from "../../crypto/keyring";

type Bucket = Readonly<{ generation: number; bucketIndex: number }>;

type SealedRow = Readonly<{
  credential_id: string;
  encrypted_canonical: string;
  encryption_generation: number;
  encryption_nonce: string;
  updated_at: number;
}>;

type CheckpointRow = Readonly<{
  generation: number;
  previous_count: number;
  scanned_at: number;
}>;

const g1Only = createEncryptionKeyring([
  { role: "active", generation: 1, key: TEST_ENCRYPTION_KEY },
]);
const rotating = createEncryptionKeyring([
  { role: "active", generation: 2, key: TEST_ENCRYPTION_KEY_G2 },
  { role: "previous", generation: 1, key: TEST_ENCRYPTION_KEY },
]);
const ROTATING_JSON = JSON.stringify([
  { role: "active", generation: 2, key: TEST_ENCRYPTION_KEY_G2 },
  { role: "previous", generation: 1, key: TEST_ENCRYPTION_KEY },
]);

const forward = twoGenerationKeyring("forward");
const ACTIVE = activeKey(forward);
const PREVIOUS = previousKey(forward) as MappingKeyEntry;

function rows(bucket: Bucket, hmac: string) {
  return inDirectoryStorage(bucket.generation, bucket.bucketIndex, (sql) =>
    sql
      .exec<SealedRow>(
        "SELECT credential_id, encrypted_canonical, encryption_generation, encryption_nonce, updated_at FROM credential_mappings WHERE kind = 'email' AND hmac = ?",
        hmac,
      )
      .toArray(),
  );
}

function jobs(bucket: Bucket) {
  return inDirectoryStorage(bucket.generation, bucket.bucketIndex, (sql) =>
    sql
      .exec<{ operation_key: string; status: string; payload: string }>(
        "SELECT operation_key, status, payload FROM jobs WHERE kind = 'rotate-encryption'",
      )
      .toArray(),
  );
}

function checkpoints(bucket: Bucket) {
  return inDirectoryStorage(bucket.generation, bucket.bucketIndex, (sql) =>
    sql
      .exec<CheckpointRow>(
        "SELECT generation, previous_count, scanned_at FROM rotation_checkpoints WHERE rotation_kind = 'encryption' AND bucket_index = ? ORDER BY generation",
        bucket.bucketIndex,
      )
      .toArray(),
  );
}

function retiredCount(bucket: Bucket) {
  return inDirectoryStorage(
    bucket.generation,
    bucket.bucketIndex,
    (sql) =>
      sql
        .exec<{ n: number }>(
          "SELECT count(*) AS n FROM credential_mappings WHERE encryption_generation != 2",
        )
        .one().n,
  );
}

async function runJob(bucket: Bucket): Promise<void> {
  await inDirectoryStorage(
    bucket.generation,
    bucket.bucketIndex,
    async (sql, _i, state) => {
      sql.exec(
        "UPDATE jobs SET next_run_at = ? WHERE kind = 'rotate-encryption' AND status = 'pending'",
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

async function restore(bucket: Bucket): Promise<void> {
  await overrideDirectoryEnv(bucket.generation, bucket.bucketIndex, {
    IDENTITY_MAIL_ENCRYPTION_KEYRING: undefined,
    DIRECTORY_KEY_COMMITMENT: undefined,
  });
}

describe("rotate-encryption (TC-keyRotation-005 / 019 / 027 / 037, and the encryption side of 004)", () => {
  it("005: the start is refused while the commitment carries a previous mapping generation, and while there is nothing to retire", async () => {
    const container = createTestContainer();
    const { email } = await registerTestUser(container);
    const bucket = await bucketOfEmail(email);
    const stub = directoryStubOf(bucket.generation, bucket.bucketIndex);
    try {
      await overrideDirectoryEnv(bucket.generation, bucket.bucketIndex, {
        IDENTITY_MAIL_ENCRYPTION_KEYRING: ROTATING_JSON,
        DIRECTORY_KEY_COMMITMENT: await commitmentJsonFor(forward),
      });
      expect(await stub.startRotateEncryption()).toMatchObject({
        ok: false,
        error: { code: "CONFIGURATION_ERROR" },
      });
      expect(await jobs(bucket)).toEqual([]);

      await overrideDirectoryEnv(bucket.generation, bucket.bucketIndex, {
        IDENTITY_MAIL_ENCRYPTION_KEYRING: undefined,
        DIRECTORY_KEY_COMMITMENT: undefined,
      });
      expect(await stub.startRotateEncryption()).toMatchObject({
        ok: false,
        error: { code: "CONFIGURATION_ERROR" },
      });
      expect(await jobs(bucket)).toEqual([]);
    } finally {
      await restore(bucket);
    }
  });

  it("019 / 027 / 004: one start, one job, every row re-sealed under the active generation, the checkpoint written and the stale one deleted; remap-chunk refused meanwhile", async () => {
    const container = createTestContainer();
    const email = uniqueEmail();
    await registerTestUser(container, { email });
    const bucket = await bucketOfEmail(email);
    const stub = directoryStubOf(bucket.generation, bucket.bucketIndex);
    try {
      await overrideDirectoryEnv(bucket.generation, bucket.bucketIndex, {
        IDENTITY_MAIL_ENCRYPTION_KEYRING: ROTATING_JSON,
        DIRECTORY_KEY_COMMITMENT: await commitmentJsonFor(forward),
      });
      // 004, encryption side: a previous encryption entry blocks the transfer.
      expect(
        await stub.remapChunk({
          active: ACTIVE,
          previous: PREVIOUS,
          limit: 10,
          afterCredentialId: null,
        }),
      ).toMatchObject({ ok: false, error: { code: "CONFIGURATION_ERROR" } });
      await overrideDirectoryEnv(bucket.generation, bucket.bucketIndex, {
        DIRECTORY_KEY_COMMITMENT: undefined,
      });

      const [before] = await rows(bucket, bucket.hmac);
      expect(before?.encryption_generation).toBe(1);
      // 027: a stale proof for the generation the rewrite adds rows to.
      await inDirectoryStorage(bucket.generation, bucket.bucketIndex, (sql) => {
        sql.exec(
          `INSERT INTO rotation_checkpoints (rotation_kind, bucket_index, generation, previous_count, scanned_at, conflict_count, last_conflict_at, last_conflict_credential_id)
             VALUES ('encryption', ?, 2, 0, 1, 0, NULL, NULL)`,
          bucket.bucketIndex,
        );
      });

      expect(await stub.startRotateEncryption()).toEqual({
        ok: true,
        value: { retiringGeneration: 1 },
      });
      const pending = await jobs(bucket);
      expect(pending).toHaveLength(1);
      expect(pending[0]).toMatchObject({ operation_key: "rotate-encryption" });
      expect(["pending", "done"]).toContain(pending[0]?.status);
      expect(JSON.parse(pending[0]?.payload ?? "{}")).toEqual({
        retiringGeneration: 1,
      });
      const armed = await inDirectoryStorage(
        bucket.generation,
        bucket.bucketIndex,
        (_s, _i, state) => state.storage.getAlarm(),
      );
      expect(armed).not.toBeNull();

      await runJob(bucket);
      expect((await jobs(bucket))[0]?.status).toBe("done");
      expect(await retiredCount(bucket)).toBe(0);
      const [after] = await rows(bucket, bucket.hmac);
      if (after === undefined || before === undefined) throw new Error("row");
      expect(after.encryption_generation).toBe(2);
      expect(after.encrypted_canonical).not.toBe(before.encrypted_canonical);
      const aad = { kind: "email" as const, credentialId: after.credential_id };
      const sealed = {
        ciphertext: after.encrypted_canonical,
        encryptionGeneration: after.encryption_generation,
        nonce: after.encryption_nonce,
      };
      expect(await openCanonical(rotating, aad, sealed)).toBe(email);
      expect(await openCanonical(g1Only, aad, sealed)).toBeNull();
      // 019 / 027: the retiring generation's checkpoint, the stale one gone.
      const cps = await checkpoints(bucket);
      expect(cps).toHaveLength(1);
      expect(cps[0]).toMatchObject({ generation: 1, previous_count: 0 });
      expect(cps[0]?.scanned_at).toBeGreaterThan(1);

      // The one entry point revives the done row rather than adding one.
      expect(await stub.startRotateEncryption()).toEqual({
        ok: true,
        value: { retiringGeneration: 1 },
      });
      const revived = await jobs(bucket);
      expect(revived).toHaveLength(1);
      expect(["pending", "done"]).toContain(revived[0]?.status);
    } finally {
      await restore(bucket);
    }
  });

  it("037 (partial): the rewrite is conditioned on the retiring generation — rows already at the active one are never selected or touched", async () => {
    // The read-then-write interleaving (delete and re-reserve the same
    // canonical between the two) is not reproducible from a test; what is
    // pinned is the statement's guard and that a second run rewrites nothing.
    const container = createTestContainer();
    const email = uniqueEmail();
    await registerTestUser(container, { email });
    const bucket = await bucketOfEmail(email);
    const stub = directoryStubOf(bucket.generation, bucket.bucketIndex);
    try {
      await overrideDirectoryEnv(bucket.generation, bucket.bucketIndex, {
        IDENTITY_MAIL_ENCRYPTION_KEYRING: ROTATING_JSON,
      });
      expect((await stub.startRotateEncryption()).ok).toBe(true);
      await runJob(bucket);
      expect(await retiredCount(bucket)).toBe(0);

      // A generation-1 row appears after the rotation: sealed under the
      // old key for its own credential id.
      const oldHmac = "f".repeat(63) + bucket.bucketIndex.toString(16);
      const sealed = await sealCanonical(
        g1Only,
        { kind: "email", credentialId: "old-cred" },
        "old@example.com",
      );
      await inDirectoryStorage(bucket.generation, bucket.bucketIndex, (sql) => {
        sql.exec(
          `INSERT INTO credential_mappings (credential_id, kind, hmac, generation, user_id, status, password_verifier, pending_verifier, change_state, change_origin, credential_version, encrypted_canonical, encryption_generation, encryption_nonce, failed_attempts, next_attempt_allowed_at, operation_id, candidate_user_id, reserved_until, saga_committed, locators, coordinator_locator, caller_token, created_at, updated_at)
             VALUES ('old-cred', 'email', ?, ?, 'u-old', 'active', NULL, NULL, NULL, NULL, 1, ?, 1, ?, 0, NULL, NULL, NULL, 0, 1, NULL, NULL, ?, 1, 1)`,
          oldHmac,
          bucket.generation,
          sealed.ciphertext,
          sealed.nonce,
          "c".repeat(40),
        );
      });
      const [g2Before] = await rows(bucket, bucket.hmac);
      expect(await retiredCount(bucket)).toBe(1);

      expect((await stub.startRotateEncryption()).ok).toBe(true);
      await runJob(bucket);
      expect(await retiredCount(bucket)).toBe(0);
      const [old] = await rows(bucket, oldHmac);
      expect(old?.encryption_generation).toBe(2);
      expect(
        await openCanonical(
          rotating,
          { kind: "email", credentialId: "old-cred" },
          {
            ciphertext: old?.encrypted_canonical ?? "",
            encryptionGeneration: 2,
            nonce: old?.encryption_nonce ?? "",
          },
        ),
      ).toBe("old@example.com");
      // The row already at generation 2 was outside the predicate.
      const [g2After] = await rows(bucket, bucket.hmac);
      expect(g2After).toEqual(g2Before);

      // A third run with nothing left rewrites nothing.
      expect((await stub.startRotateEncryption()).ok).toBe(true);
      await runJob(bucket);
      expect(await rows(bucket, oldHmac)).toEqual([old]);
      expect((await checkpoints(bucket))[0]).toMatchObject({
        generation: 1,
        previous_count: 0,
      });
    } finally {
      await inDirectoryStorage(bucket.generation, bucket.bucketIndex, (sql) => {
        sql.exec(
          "DELETE FROM credential_mappings WHERE credential_id = 'old-cred'",
        );
      });
      await restore(bucket);
    }
  });
});

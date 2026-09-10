import { describe, expect, it } from "vitest";
import { loginWithPassword } from "../../../application/identity/loginWithPassword";
import { PlainPassword } from "../../../domain/identity/valueObject";
import { openCanonical } from "../crypto/canonicalCipher";
import {
  activeKey,
  createEncryptionKeyring,
  type MappingKeyEntry,
  previousKey,
} from "../crypto/keyring";
import { deriveLocator } from "../crypto/locatorDerivation";
import { createIdentityGateway } from "../identityGateway";
import {
  bindings,
  commitmentJsonFor,
  directoryStubOf,
  inDirectoryStorage,
  inUserDataStorage,
  overrideDirectoryEnv,
  TEST_ENCRYPTION_KEY,
  twoGenerationKeyring,
  uniqueEmail,
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
  const { userId } = await registerTestUser(container, { email });
  const source = await deriveLocator(PREVIOUS, "email", email);
  const target = await deriveLocator(ACTIVE, "email", email);
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
    inDirectoryStorage(
      bucket.generation,
      bucket.bucketIndex,
      (sql) =>
        sql
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
  const remap = (
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
      limit: 10,
      afterCredentialId: null,
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
        remaining: 0,
        conflicts: 0,
        lastCredentialId: null,
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
      previous_count: 0,
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

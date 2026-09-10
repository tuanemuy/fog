import { runDurableObjectAlarm } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { linkSsoCredential } from "../../../application/identity/linkSsoCredential";
import { ssoCanonicalOf } from "../../../application/identity/registerOrLoginWithSso";
import { unlinkSsoCredential } from "../../../application/identity/unlinkSsoCredential";
import type { CredentialKind } from "../../../domain/identity/ports/credentialMappingRepository";
import { PlainPassword } from "../../../domain/identity/valueObject";
import {
  activeKey,
  type MappingKeyEntry,
  type MappingKeyring,
  previousKey,
} from "../crypto/keyring";
import { deriveLocator } from "../crypto/locatorDerivation";
import { createIdentityGateway } from "../identityGateway";
import {
  bindings,
  commitmentJsonFor,
  deliveryTuning,
  directoryStubOf,
  inDirectoryStorage,
  inUserDataStorage,
  overrideDirectoryEnv,
  testKeyring,
  twoGenerationKeyring,
  uniqueEmail,
  userDataStubOf,
} from "./helpers";
import {
  bucketOfEmail,
  createTestContainer,
  registerTestUser,
  TEST_PASSWORD,
} from "./testContainer";

type Bucket = Readonly<{ generation: number; bucketIndex: number }>;

const forward = twoGenerationKeyring("forward");
const rollback = twoGenerationKeyring("rollback");
const ACTIVE = activeKey(forward);
const PREVIOUS = previousKey(forward) as MappingKeyEntry;

function containerWith(keyring: MappingKeyring) {
  const base = createTestContainer();
  return {
    ...base,
    identityGateway: createIdentityGateway({
      bindings,
      keyring,
      clock: base.clock,
      tuning: base.identityTuning,
    }),
  };
}

async function commitBoth(
  keyring: MappingKeyring,
  buckets: readonly Bucket[],
): Promise<void> {
  const commitment = await commitmentJsonFor(keyring);
  for (const bucket of buckets) {
    await overrideDirectoryEnv(bucket.generation, bucket.bucketIndex, {
      DIRECTORY_KEY_COMMITMENT: commitment,
    });
  }
}

function mappingRow(bucket: Bucket, kind: CredentialKind, hmac: string) {
  return inDirectoryStorage(
    bucket.generation,
    bucket.bucketIndex,
    (sql) =>
      sql
        .exec<{
          credential_id: string;
          user_id: string | null;
          status: string;
          generation: number;
        }>(
          "SELECT credential_id, user_id, status, generation FROM credential_mappings WHERE kind = ? AND hmac = ?",
          kind,
          hmac,
        )
        .toArray()[0],
  );
}

function checkpoint(bucket: Bucket, generation: number) {
  return inDirectoryStorage(
    bucket.generation,
    bucket.bucketIndex,
    (sql) =>
      sql
        .exec<{ previous_count: number }>(
          "SELECT previous_count FROM rotation_checkpoints WHERE rotation_kind = 'remap' AND bucket_index = ? AND generation = ?",
          bucket.bucketIndex,
          generation,
        )
        .toArray()[0],
  );
}

function locatorsOf(userId: string, credentialId: string) {
  return inUserDataStorage(userId, (sql) =>
    sql
      .exec<{ generation: number; hmac: string }>(
        "SELECT generation, hmac FROM credential_locators WHERE credential_id = ? ORDER BY generation",
        credentialId,
      )
      .toArray(),
  );
}

function callerTokenOf(userId: string) {
  return inUserDataStorage(
    userId,
    (sql) =>
      sql
        .exec<{ caller_token: string }>("SELECT caller_token FROM account")
        .one().caller_token,
  );
}

function remap(
  source: Bucket,
  keys: { active: MappingKeyEntry; previous: MappingKeyEntry },
) {
  return directoryStubOf(source.generation, source.bucketIndex).remapChunk({
    ...keys,
    limit: 50,
    afterCredentialId: null,
  });
}

// Buckets and their env overrides outlive a test, so a single-generation
// registration first puts the bucket it will write back under a
// single-generation commitment.
async function registerSingleGeneration(email: string) {
  await commitBoth(testKeyring, [await bucketOfEmail(email)]);
  return registerTestUser(createTestContainer(), { email });
}

/** A password account with a linked SSO subject, and the subject's buckets under both keys. */
async function linkedAccount(container = createTestContainer()) {
  const email = uniqueEmail();
  const { userId } = await registerSingleGeneration(email);
  const subject = `sub-${email}`;
  const canonical = ssoCanonicalOf("google", subject);
  const source = await deriveLocator(PREVIOUS, "sso", canonical);
  const target = await deriveLocator(ACTIVE, "sso", canonical);
  await commitBoth(testKeyring, [source]);
  const { credentialId } = await linkSsoCredential({
    container,
    input: { userId, provider: "google", providerSubject: subject },
  });
  return { userId, email, credentialId, source, target };
}

describe("reservations during a rotation (TC-keyRotation-017 / 031)", () => {
  it("a new registration lands in the active generation; a request-path reservation aimed at the previous one is a SystemError with no row and no job", async () => {
    const email = uniqueEmail();
    const g1 = await deriveLocator(PREVIOUS, "email", email);
    const g2 = await deriveLocator(ACTIVE, "email", email);
    await commitBoth(forward, [g1, g2]);

    const rotating = containerWith(forward);
    const { userId } = await registerTestUser(rotating, { email });
    expect(await mappingRow(g2, "email", g2.hmac)).toMatchObject({
      user_id: userId,
      status: "active",
      generation: 2,
    });

    // 031: a reservation carrying a previous-generation coordinate.
    const base = createTestContainer();
    const credentialId = base.idGenerator.next();
    const operationId = base.idGenerator.next();
    const locator = {
      credentialId,
      kind: "email" as const,
      hmac: g1.hmac,
      generation: g1.generation,
      bucketIndex: g1.bucketIndex,
    };
    const refused = await directoryStubOf(
      g1.generation,
      g1.bucketIndex,
    ).reserveCredential({
      locator,
      dto: {
        saga: "signup",
        operationId,
        candidateUserId: base.idGenerator.next(),
        callerToken: base.tokenGenerator.next() + base.tokenGenerator.next(),
        canonical: email,
        passwordVerifier: await base.passwordHasher.hash(
          PlainPassword.create(TEST_PASSWORD),
        ),
        reservedUntil: new Date(Date.now() + 3_600_000),
        coordinator: { role: "coordinator", locators: [locator] },
      },
      resumeAt: new Date(Date.now() + 60_000),
    });
    expect(refused).toMatchObject({
      ok: false,
      error: { code: "CONFIGURATION_ERROR" },
    });
    expect(await mappingRow(g1, "email", g1.hmac)).toBeUndefined();
    const jobs = await inDirectoryStorage(
      g1.generation,
      g1.bucketIndex,
      (sql) =>
        sql
          .exec<{ n: number }>(
            "SELECT count(*) AS n FROM jobs WHERE json_extract(payload, '$.locator.credentialId') = ? OR status = 'poison'",
            credentialId,
          )
          .one().n,
    );
    expect(jobs).toBe(0);
  });
});

describe("roll-back and the retirement-proof invalidation (TC-keyRotation-020 / 027)", () => {
  it("a roll-back is the same transfer with the roles swapped, and the import into the re-activated generation deletes its stale checkpoint", async () => {
    const email = uniqueEmail();
    const g1 = await deriveLocator(PREVIOUS, "email", email);
    const g2 = await deriveLocator(ACTIVE, "email", email);
    const { userId } = await registerSingleGeneration(email);
    await commitBoth(forward, [g1, g2]);
    const moved = await remap(g1, { active: ACTIVE, previous: PREVIOUS });
    expect(moved).toMatchObject({ ok: true });
    expect(await mappingRow(g1, "email", g1.hmac)).toBeUndefined();
    expect(await checkpoint(g1, 1)).toBeDefined();
    const credentialId = (await mappingRow(g2, "email", g2.hmac))
      ?.credential_id as string;

    // 020: active = g1, previous = g2, driven from the g2 bucket.
    await commitBoth(rollback, [g1, g2]);
    const back = await remap(g2, {
      active: activeKey(rollback),
      previous: previousKey(rollback) as MappingKeyEntry,
    });
    expect(back).toMatchObject({ ok: true });
    expect(await mappingRow(g2, "email", g2.hmac)).toBeUndefined();
    expect(await mappingRow(g1, "email", g1.hmac)).toMatchObject({
      credential_id: credentialId,
      user_id: userId,
      generation: 1,
    });
    expect(await locatorsOf(userId, credentialId)).toEqual([
      { generation: 1, hmac: g1.hmac },
      { generation: 2, hmac: g2.hmac },
    ]);
    expect(await checkpoint(g2, 2)).toBeDefined();
    // 027 (import): the forward run's proof for g1 is gone.
    expect(await checkpoint(g1, 1)).toBeUndefined();
  });

  it("a reservation into a re-activated generation deletes its stale checkpoint too (027, the reservation path)", async () => {
    const email = uniqueEmail();
    const g1 = await deriveLocator(PREVIOUS, "email", email);
    const g2 = await deriveLocator(ACTIVE, "email", email);
    await registerSingleGeneration(email);
    await commitBoth(forward, [g1, g2]);
    expect(
      await remap(g1, { active: ACTIVE, previous: PREVIOUS }),
    ).toMatchObject({ ok: true });
    expect(await mappingRow(g1, "email", g1.hmac)).toBeUndefined();
    expect(await checkpoint(g1, 1)).toBeDefined();

    // g1 is active again, single-generation.
    await commitBoth(testKeyring, [g1]);
    let other = uniqueEmail();
    for (let i = 0; i < 400; i += 1) {
      if ((await bucketOfEmail(other)).bucketIndex === g1.bucketIndex) break;
      other = uniqueEmail();
    }
    expect((await bucketOfEmail(other)).bucketIndex).toBe(g1.bucketIndex);
    await registerSingleGeneration(other);
    expect(await checkpoint(g1, 1)).toBeUndefined();
  });
});

describe("an unlink and a transfer on the same credential (TC-keyRotation-010 / 024)", () => {
  it("010: after the unlink stashed the coordinates the transfer passes the row over, and the stashed deletion removes it from its generation", async () => {
    const container = createTestContainer();
    const { userId, credentialId, source, target } =
      await linkedAccount(container);
    await commitBoth(forward, [source, target]);
    const operationId = container.idGenerator.next();
    const begun = await userDataStubOf(userId).beginUnlink({
      dto: { operationId, credentialId },
      resumeAt: new Date(Date.now() + 60_000),
    });
    expect(begun.ok).toBe(true);
    expect(await locatorsOf(userId, credentialId)).toEqual([]);

    const answer = await remap(source, { active: ACTIVE, previous: PREVIOUS });
    expect(answer.ok).toBe(true);
    // Nothing was imported, so the destination may not even exist yet.
    await directoryStubOf(
      target.generation,
      target.bucketIndex,
    ).readDeliveryBacklog();
    expect(await mappingRow(target, "sso", target.hmac)).toBeUndefined();
    expect(await mappingRow(source, "sso", source.hmac)).toMatchObject({
      credential_id: credentialId,
      user_id: userId,
    });

    const stashed = await inUserDataStorage(
      userId,
      (sql) =>
        JSON.parse(
          sql
            .exec<{ target_locators: string }>(
              "SELECT target_locators FROM operations WHERE operation_id = ?",
              operationId,
            )
            .one().target_locators,
        ) as { credentialId: string; kind: CredentialKind; mapping: string }[],
    );
    expect(stashed).toHaveLength(1);
    const gateway = containerWith(forward).identityGateway;
    const callerToken = await callerTokenOf(userId);
    const target0 = stashed[0] as (typeof stashed)[number];
    expect(
      await gateway.deleteMapping(
        {
          credentialId: target0.credentialId,
          kind: target0.kind,
          mapping: target0.mapping,
        },
        { userId, callerToken },
      ),
    ).toEqual({ deleted: true, generation: 1 });
    expect(await mappingRow(source, "sso", source.hmac)).toBeUndefined();
    expect(await mappingRow(target, "sso", target.hmac)).toBeUndefined();
  });

  it("024: a round that was a no-op over two generations holds the record open and re-issues once after the interval; a single-generation unlink closes at once", async () => {
    const container = createTestContainer();
    const { userId, credentialId, source, target } =
      await linkedAccount(container);
    await commitBoth(forward, [source, target]);
    expect(
      await remap(source, { active: ACTIVE, previous: PREVIOUS }),
    ).toMatchObject({ ok: true });
    expect(await mappingRow(target, "sso", target.hmac)).toBeDefined();
    expect(await locatorsOf(userId, credentialId)).toHaveLength(2);
    // The copy is not there when the deletions arrive.
    await inDirectoryStorage(target.generation, target.bucketIndex, (sql) => {
      sql.exec(
        "DELETE FROM credential_mappings WHERE kind = 'sso' AND hmac = ?",
        target.hmac,
      );
    });

    const rotating = containerWith(forward);
    await unlinkSsoCredential({
      container: rotating,
      input: { userId, credentialId },
    });
    const record = () =>
      inUserDataStorage(userId, (sql) => {
        const op = sql
          .exec<{ phase: string; target_locators: string }>(
            "SELECT phase, target_locators FROM operations WHERE kind = 'unlink'",
          )
          .one();
        const job = sql
          .exec<{ status: string; next_run_at: number | null }>(
            "SELECT status, next_run_at FROM jobs WHERE operation_key = 'sweep-orphan-mapping'",
          )
          .one();
        return {
          phase: op.phase,
          targets: JSON.parse(op.target_locators) as {
            generation?: number;
            noopSince?: number;
          }[],
          job,
        };
      });
    const held = await record();
    expect(held.phase).toBe("deleting");
    expect(held.targets).toHaveLength(2);
    for (const t of held.targets) expect(typeof t.noopSince).toBe("number");
    expect(held.job.status).toBe("pending");

    // The interval has passed: the next round confirms.
    await inUserDataStorage(userId, async (sql, _i, state) => {
      const targets = (
        JSON.parse(
          sql
            .exec<{ target_locators: string }>(
              "SELECT target_locators FROM operations WHERE kind = 'unlink'",
            )
            .one().target_locators,
        ) as Record<string, unknown>[]
      ).map((t) => ({
        ...t,
        noopSince: Date.now() - deliveryTuning.deleteNoopReissueDelayMs - 1_000,
      }));
      sql.exec(
        "UPDATE operations SET target_locators = ? WHERE kind = 'unlink'",
        JSON.stringify(targets),
      );
      sql.exec(
        "UPDATE jobs SET next_run_at = ? WHERE operation_key = 'sweep-orphan-mapping'",
        Date.now() - 1_000,
      );
      await state.storage.setAlarm(Date.now() + 60_000);
    });
    expect(await runDurableObjectAlarm(userDataStubOf(userId))).toBe(true);
    const closed = await record();
    expect(closed.phase).toBe("done");
    expect(closed.job.status).toBe("done");

    // Single generation: confirmed in the request itself.
    const plain = await linkedAccount(container);
    await unlinkSsoCredential({
      container,
      input: { userId: plain.userId, credentialId: plain.credentialId },
    });
    const phase = await inUserDataStorage(
      plain.userId,
      (sql) =>
        sql
          .exec<{ phase: string }>(
            "SELECT phase FROM operations WHERE kind = 'unlink'",
          )
          .one().phase,
    );
    expect(phase).toBe("done");
  });
});

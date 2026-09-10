import {
  bindings,
  directoryStubOf,
  inDirectoryStorage,
  twoGenerationKeyring,
  uniqueEmail,
} from "@repo/core/adapters/cloudflare/__tests__/helpers";
import {
  bucketOfEmail,
  createTestContainer,
  registerTestUser,
  TEST_PASSWORD,
} from "@repo/core/adapters/cloudflare/__tests__/testContainer";
import { activeKey } from "@repo/core/adapters/cloudflare/crypto/keyring";
import { deriveLocator } from "@repo/core/adapters/cloudflare/crypto/locatorDerivation";
import type { DurableObjectBindings } from "@repo/core/adapters/cloudflare/doStubs";
import type { IdentityDirectoryDurableObject } from "@repo/core/adapters/cloudflare/identityDirectoryDurableObject";
import { createIdentityGateway } from "@repo/core/adapters/cloudflare/identityGateway";
import type { RequestContainer } from "@repo/core/application/di/types";
import { PASSWORD_RESET_REQUESTED } from "@repo/core/domain/identity/passwordResetRequested";
import { describe, expect, it } from "vitest";
import { loginWithPassword } from "../loginWithPassword";
import { requestPasswordReset } from "../requestPasswordReset";

type Bucket = Readonly<{ generation: number; bucketIndex: number }>;

const forward = twoGenerationKeyring("forward");

/** The request container as a rotation deploys it: the keyring carries g2 active and g1 previous. */
function rotatingContainer(
  overrides: Partial<DurableObjectBindings> = {},
): RequestContainer {
  const base = createTestContainer();
  return {
    ...base,
    identityGateway: createIdentityGateway({
      bindings: { ...bindings, ...overrides },
      keyring: forward,
      clock: base.clock,
      tuning: base.identityTuning,
    }),
  };
}

async function g2LocatorOf(email: string) {
  return deriveLocator(activeKey(forward), "email", email);
}

const MAPPING_COLUMNS =
  "credential_id, kind, hmac, generation, user_id, status, password_verifier, pending_verifier, change_state, change_origin, credential_version, encrypted_canonical, encryption_generation, encryption_nonce, failed_attempts, next_attempt_allowed_at, operation_id, candidate_user_id, reserved_until, saga_committed, locators, coordinator_locator, caller_token, created_at, updated_at";

type MappingRow = Record<string, SqlStorageValue> & {
  credential_id: string;
  credential_version: number;
  failed_attempts: number;
};

async function mappingIn(bucket: Bucket, hmac: string) {
  return inDirectoryStorage(
    bucket.generation,
    bucket.bucketIndex,
    (sql) =>
      sql
        .exec<MappingRow>(
          `SELECT ${MAPPING_COLUMNS} FROM credential_mappings WHERE kind = 'email' AND hmac = ?`,
          hmac,
        )
        .toArray()[0],
  );
}

/** Both-generations state by hand: the g1 row copied verbatim into the g2 bucket, `hmac` and `generation` alone renewed. */
async function copyRowToG2(email: string): Promise<void> {
  const source = await bucketOfEmail(email);
  const target = await g2LocatorOf(email);
  const row = await mappingIn(source, source.hmac);
  if (row === undefined) throw new Error("source row expected");
  const copy: Record<string, SqlStorageValue> = {
    ...row,
    hmac: target.hmac,
    generation: 2,
  };
  const columns = MAPPING_COLUMNS.split(", ");
  // The first gated RPC initialises the g2 bucket the copy lands in.
  expect(
    (
      await directoryStubOf(
        target.generation,
        target.bucketIndex,
      ).readDeliveryBacklog()
    ).ok,
  ).toBe(true);
  await inDirectoryStorage(target.generation, target.bucketIndex, (sql) => {
    sql.exec(
      `INSERT INTO credential_mappings (${MAPPING_COLUMNS}) VALUES (${columns.map(() => "?").join(", ")})`,
      ...columns.map((c) => copy[c] ?? null),
    );
  });
}

async function deleteRowInG1(email: string): Promise<void> {
  const source = await bucketOfEmail(email);
  await inDirectoryStorage(source.generation, source.bucketIndex, (sql) => {
    sql.exec(
      "DELETE FROM credential_mappings WHERE kind = 'email' AND hmac = ?",
      source.hmac,
    );
  });
}

async function resetArtifacts(bucket: Bucket, hmac: string) {
  return inDirectoryStorage(bucket.generation, bucket.bucketIndex, (sql) => ({
    outbox: sql
      .exec<{ type: string; payload: string }>(
        "SELECT type, payload FROM outbox_events WHERE substr(aggregate_id, 1, ?) = ?",
        hmac.length + 1,
        `${hmac}:`,
      )
      .toArray(),
    tokens: sql
      .exec<{ n: number }>(
        `SELECT count(*) AS n FROM password_reset_tokens
         WHERE credential_id IN (SELECT credential_id FROM credential_mappings WHERE kind = 'email' AND hmac = ?)`,
        hmac,
      )
      .one().n,
    windows: sql
      .exec<{ n: number }>(
        "SELECT count(*) AS n FROM reset_request_windows WHERE substr(window_key, 1, ?) = ?",
        hmac.length + 1,
        `${hmac}:`,
      )
      .one().n,
  }));
}

async function expectInvalidCredentials(
  promise: Promise<unknown>,
): Promise<void> {
  await expect(promise).rejects.toMatchObject({ code: "INVALID_CREDENTIALS" });
}

describe("lookup の世代順序 — active → previous → active re-probe", () => {
  it("035: a user whose row exists only in the previous generation logs in, and the write-back lands on that row", async () => {
    const email = uniqueEmail();
    const { userId } = await registerTestUser(createTestContainer(), { email });
    const container = rotatingContainer();

    await expect(
      loginWithPassword({
        container,
        input: { email, password: TEST_PASSWORD },
      }),
    ).resolves.toEqual({ userId });

    await expectInvalidCredentials(
      loginWithPassword({ container, input: { email, password: "wrong pw" } }),
    );
    const g1 = await bucketOfEmail(email);
    expect((await mappingIn(g1, g1.hmac))?.failed_attempts).toBe(1);
    const g2 = await g2LocatorOf(email);
    expect(await mappingIn(g2, g2.hmac)).toBeUndefined();
  });

  it("036: a reset request completes in the bucket the lookup hit — previous for the unmoved user, active for an unknown address", async () => {
    const email = uniqueEmail();
    await registerTestUser(createTestContainer(), { email });
    const container = rotatingContainer();

    await requestPasswordReset({ container, input: { email } });
    const g1 = await bucketOfEmail(email);
    const g2 = await g2LocatorOf(email);
    const inG1 = await resetArtifacts(g1, g1.hmac);
    expect(inG1.outbox).toHaveLength(1);
    expect(inG1.outbox[0]?.type).toBe(PASSWORD_RESET_REQUESTED);
    expect(inG1.tokens).toBe(1);
    expect(inG1.windows).toBe(1);
    const inG2 = await resetArtifacts(g2, g2.hmac);
    expect(inG2.outbox).toHaveLength(0);
    expect(inG2.windows).toBe(0);

    const unknown = uniqueEmail();
    await requestPasswordReset({ container, input: { email: unknown } });
    const unknownG1 = await bucketOfEmail(unknown);
    const unknownG2 = await g2LocatorOf(unknown);
    const decoy = await resetArtifacts(unknownG2, unknownG2.hmac);
    expect(decoy.outbox).toHaveLength(1);
    expect(decoy.outbox[0]?.type).toBe(PASSWORD_RESET_REQUESTED);
    expect(decoy.tokens).toBe(0);
    expect(decoy.windows).toBe(1);
    const nothing = await resetArtifacts(unknownG1, unknownG1.hmac);
    expect(nothing.outbox).toHaveLength(0);
    expect(nothing.windows).toBe(0);
  });

  it("016: with rows in both generations login passes on the active copy; a stale copy is refused fail-closed by the version check", async () => {
    const email = uniqueEmail();
    const { userId } = await registerTestUser(createTestContainer(), { email });
    await copyRowToG2(email);
    const container = rotatingContainer();

    await expect(
      loginWithPassword({
        container,
        input: { email, password: TEST_PASSWORD },
      }),
    ).resolves.toEqual({ userId });

    const g2 = await g2LocatorOf(email);
    await inDirectoryStorage(g2.generation, g2.bucketIndex, (sql) => {
      sql.exec(
        "UPDATE credential_mappings SET credential_version = 0 WHERE kind = 'email' AND hmac = ?",
        g2.hmac,
      );
    });
    await expectInvalidCredentials(
      loginWithPassword({
        container,
        input: { email, password: TEST_PASSWORD },
      }),
    );

    await inDirectoryStorage(g2.generation, g2.bucketIndex, (sql) => {
      sql.exec(
        "UPDATE credential_mappings SET credential_version = 1 WHERE kind = 'email' AND hmac = ?",
        g2.hmac,
      );
    });
    await expect(
      loginWithPassword({
        container,
        input: { email, password: TEST_PASSWORD },
      }),
    ).resolves.toEqual({ userId });
  });

  it("040: a transfer completing between the two misses is caught by the one re-probe of active", async () => {
    const email = uniqueEmail();
    const { userId } = await registerTestUser(createTestContainer(), { email });
    const g2 = await g2LocatorOf(email);
    const namespace = bindings.IDENTITY_DIRECTORY;
    const probes: string[] = [];
    let moved = false;

    // The active probe misses, and the row moves before that miss is
    // answered — so the previous probe misses too. A plain object stands in
    // for the stub: the login path calls these two methods and no other.
    type Probe = IdentityDirectoryDurableObject["resolveLoginCredential"];
    const interceptingStub = (name: string, stub: DurableObjectStub) => {
      const real = stub as unknown as IdentityDirectoryDurableObject;
      return {
        resolveLoginCredential: async (...args: Parameters<Probe>) => {
          probes.push(name);
          const answer = await real.resolveLoginCredential(...args);
          if (
            !moved &&
            answer.ok &&
            answer.value === null &&
            name === `dir:g${g2.generation}:b${g2.bucketIndex}`
          ) {
            moved = true;
            await copyRowToG2(email);
            await deleteRowInG1(email);
          }
          return answer;
        },
        recordAttemptOutcome: (
          ...args: Parameters<
            IdentityDirectoryDurableObject["recordAttemptOutcome"]
          >
        ) => real.recordAttemptOutcome(...args),
      };
    };
    const wrapped = {
      idFromName: (name: string) => namespace.idFromName(name),
      get: (id: DurableObjectId) =>
        interceptingStub(
          id.name ?? "",
          namespace.get(id) as unknown as DurableObjectStub,
        ),
    } as unknown as DurableObjectNamespace;

    const container = rotatingContainer({ IDENTITY_DIRECTORY: wrapped });
    await expect(
      loginWithPassword({
        container,
        input: { email, password: TEST_PASSWORD },
      }),
    ).resolves.toEqual({ userId });

    const g1 = await bucketOfEmail(email);
    expect(probes).toEqual([
      `dir:g${g2.generation}:b${g2.bucketIndex}`,
      `dir:g${g1.generation}:b${g1.bucketIndex}`,
      `dir:g${g2.generation}:b${g2.bucketIndex}`,
    ]);
    expect(await mappingIn(g1, g1.hmac)).toBeUndefined();
    expect((await mappingIn(g2, g2.hmac))?.failed_attempts).toBe(0);
  });
});

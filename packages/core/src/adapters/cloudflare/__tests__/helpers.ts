import { env, runInDurableObject } from "cloudflare:test";
import { createDeliveryTuning } from "@repo/core/application/delivery/tuning";
import { createIdentityTuning } from "@repo/core/application/identity/tuning";
import {
  createMappingKeyring,
  INITIAL_DIRECTORY_BUCKET_COUNT,
  INITIAL_KEY_GENERATION,
  keyDigestOf,
  type MappingKeyEntry,
} from "../crypto/keyring";
import { directoryBucketLocator } from "../crypto/locatorDerivation";
import type { DurableObjectBindings } from "../doStubs";
import { createExportGateway } from "../exportGateway";
import type { IdentityDirectoryDurableObject } from "../identityDirectoryDurableObject";
import { createIdentityGateway } from "../identityGateway";
import { createKnowledgeGateway } from "../knowledgeGateway";
import { createMemoGateway } from "../memoGateway";
import { createSearchGateway } from "../searchGateway";
import { createTrashGateway } from "../trashGateway";
import type { UserDataDurableObject } from "../userDataDurableObject";

let sequence = 0;

/** A fresh locator per test is what isolates the Durable Object suites. */
export function nextUserId(): string {
  sequence += 1;
  return `01950000-0000-7000-8000-${sequence.toString(16).padStart(12, "0")}`;
}

export function uniqueEmail(): string {
  sequence += 1;
  return `user-${sequence}-${Date.now().toString(36)}@example.com`;
}

export const TEST_ROUTING_SECRET =
  "test-directory-routing-secret-0123456789abcdef";

export const testKeyring = createMappingKeyring([
  {
    role: "active",
    generation: INITIAL_KEY_GENERATION,
    key: TEST_ROUTING_SECRET,
    bucketCount: INITIAL_DIRECTORY_BUCKET_COUNT,
  },
]);

export const bindings: DurableObjectBindings = {
  USER_DATA: env.USER_DATA as unknown as DurableObjectNamespace,
  IDENTITY_DIRECTORY:
    env.IDENTITY_DIRECTORY as unknown as DurableObjectNamespace,
};

export const deliveryTuning = createDeliveryTuning();

export function createTestGateways(now: () => Date = () => new Date()) {
  const identityTuning = createIdentityTuning();
  return {
    identityTuning,
    identityGateway: createIdentityGateway({
      bindings,
      keyring: testKeyring,
      clock: { now },
      tuning: identityTuning,
    }),
    memoGateway: createMemoGateway(bindings),
    knowledgeGateway: createKnowledgeGateway(bindings),
    searchGateway: createSearchGateway(bindings),
    trashGateway: createTrashGateway(bindings),
    exportGateway: createExportGateway(bindings),
  };
}

export function userDataStubOf(userId: string) {
  return env.USER_DATA.get(env.USER_DATA.idFromName(userId));
}

export function directoryStubOf(generation: number, bucketIndex: number) {
  return env.IDENTITY_DIRECTORY.get(
    env.IDENTITY_DIRECTORY.idFromName(
      directoryBucketLocator(generation, bucketIndex),
    ),
  );
}

/** Runs `fn` against the SQLite of the given User Data DO. */
export function inUserDataStorage<T>(
  userId: string,
  fn: (
    sql: SqlStorage,
    instance: UserDataDurableObject,
    state: DurableObjectState,
  ) => T,
): Promise<T> {
  return runInDurableObject(userDataStubOf(userId), (instance, state) =>
    fn(state.storage.sql, instance as UserDataDurableObject, state),
  );
}

export function inDirectoryStorage<T>(
  generation: number,
  bucketIndex: number,
  fn: (
    sql: SqlStorage,
    instance: IdentityDirectoryDurableObject,
    state: DurableObjectState,
  ) => T,
): Promise<T> {
  return runInDurableObject(
    directoryStubOf(generation, bucketIndex),
    (instance, state) =>
      fn(state.storage.sql, instance as IdentityDirectoryDurableObject, state),
  );
}

/**
 * Overrides entries of a live Durable Object instance's `env` — the
 * rotation suites deploy a commitment or a two-generation encryption
 * keyring to one bucket at a time this way, in either direction.
 *
 * `env` is the plain property `DurableObject`'s constructor assigns, and
 * the buckets read their keyring / commitment from it on every use rather
 * than caching, which is what makes this take effect at once. **Limit**:
 * the override lives on the instance and does not survive an eviction or
 * a reset; the pool keeps an instance alive for the duration of a test
 * file, which is the scope these suites need.
 */
export async function overrideDirectoryEnv(
  generation: number,
  bucketIndex: number,
  overrides: Record<string, string | undefined>,
): Promise<void> {
  await runInDurableObject(
    directoryStubOf(generation, bucketIndex),
    (instance) => {
      const target = instance as unknown as { env: Record<string, unknown> };
      target.env = { ...target.env, ...overrides };
    },
  );
}

/** The same seam for the migration plan a User Data object runs under: "deploying" a later version to one object. */
export async function overrideUserDataPlan(
  userId: string,
  plan: unknown,
): Promise<void> {
  await runInDurableObject(userDataStubOf(userId), (instance) => {
    (instance as unknown as { migrationPlan: unknown }).migrationPlan = plan;
  });
}

/** Generation 2 of the mapping key, for the rotation suites; the same bucket count as generation 1. */
export const TEST_ROUTING_SECRET_G2 =
  "test-directory-routing-secret-generation-2-abcdef";

/** What `vitest.config.do.ts` binds as `IDENTITY_MAIL_ENCRYPTION_KEY`; the suites that seal rows by hand need the same value. */
export const TEST_ENCRYPTION_KEY = env.IDENTITY_MAIL_ENCRYPTION_KEY;

export const TEST_ENCRYPTION_KEY_G2 =
  "test-identity-mail-encryption-key-generation-2-abcdef";

/** A two-generation keyring: `active` generation 2, `previous` generation 1 (the forward direction), or the reverse. */
export function twoGenerationKeyring(direction: "forward" | "rollback") {
  const g1 = {
    generation: INITIAL_KEY_GENERATION,
    key: TEST_ROUTING_SECRET,
    bucketCount: INITIAL_DIRECTORY_BUCKET_COUNT,
  };
  const g2 = {
    generation: 2,
    key: TEST_ROUTING_SECRET_G2,
    bucketCount: INITIAL_DIRECTORY_BUCKET_COUNT,
  };
  const [active, previous] = direction === "forward" ? [g2, g1] : [g1, g2];
  return createMappingKeyring([
    { role: "active", ...active },
    { role: "previous", ...previous },
  ]);
}

/** The commitment JSON for a keyring: digests in place of keys, the same role-tagged set. */
export async function commitmentJsonFor(keyring: {
  entries: readonly MappingKeyEntry[];
}): Promise<string> {
  return JSON.stringify(
    await Promise.all(
      keyring.entries.map(async (entry) => ({
        role: entry.role,
        generation: entry.generation,
        keyDigest: await keyDigestOf(entry.key),
        bucketCount: entry.bucketCount,
      })),
    ),
  );
}

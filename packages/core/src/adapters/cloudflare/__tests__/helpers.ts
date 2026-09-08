import { env, runInDurableObject } from "cloudflare:test";
import { createDeliveryTuning } from "@repo/core/application/delivery/tuning";
import { createIdentityTuning } from "@repo/core/application/identity/tuning";
import {
  createMappingKeyring,
  INITIAL_DIRECTORY_BUCKET_COUNT,
  INITIAL_KEY_GENERATION,
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

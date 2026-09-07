import type { RpcEnvelope } from "@repo/core/application/delivery/types";
import { SystemError, SystemErrorCode } from "@repo/core/application/errors";
import { directoryBucketLocator } from "./crypto/locatorDerivation";
import { rebuildRpcError } from "./rpcErrors";

/**
 * The namespaces as the request Worker holds them. Typed loosely on purpose:
 * the DO classes import this module, so naming them here would be a cycle.
 * The gateways cast the stub to the class they address.
 */
export type DurableObjectBindings = Readonly<{
  USER_DATA: DurableObjectNamespace;
  IDENTITY_DIRECTORY: DurableObjectNamespace;
}>;

/** `userId` → its User Data DO. Named stubs only: the DO reads its locator from `ctx.id.name`. */
export function userDataStub(
  namespace: DurableObjectNamespace,
  userId: string,
): DurableObjectStub {
  return namespace.get(namespace.idFromName(userId));
}

/** `(generation, bucketIndex)` → the Identity Directory bucket. */
export function directoryStub(
  namespace: DurableObjectNamespace,
  locator: Readonly<{ generation: number; bucketIndex: number }>,
): DurableObjectStub {
  return namespace.get(
    namespace.idFromName(
      directoryBucketLocator(locator.generation, locator.bucketIndex),
    ),
  );
}

/**
 * Unwraps the value envelope. An error the DO answered with is rebuilt into
 * the shared contract; a failure of the stub call itself (the object was
 * unreachable or died) never entered the envelope and becomes
 * `SystemError(DatabaseError)` here.
 */
export async function callDurableObject<T>(
  call: () => Promise<RpcEnvelope<T>>,
): Promise<T> {
  let envelope: RpcEnvelope<T>;
  try {
    envelope = await call();
  } catch (error) {
    throw new SystemError(
      SystemErrorCode.DatabaseError,
      "The Durable Object could not be reached",
      error,
    );
  }
  if (envelope.ok) return envelope.value;
  throw rebuildRpcError(envelope.error);
}

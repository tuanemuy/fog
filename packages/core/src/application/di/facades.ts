import type { LocatorRef } from "@repo/core/application/execution/jobs";
import type { CurrentUserView } from "@repo/core/application/identity/view";
import type { CredentialMappingKind } from "@repo/core/domain/identity/ports/credentialMappingRepository";
import type { RpcEnvelope } from "@repo/core/lib/rpcEnvelope";

/**
 * The RPC surface the request Worker sees, as an interface rather than as the
 * Durable Object class itself.
 *
 * Everything is primitives in, `RpcEnvelope<…>` out. The envelope is not a
 * stylistic choice: Workers RPC does not preserve a custom error class's
 * structural serialization contract, so a failure has to cross the boundary as
 * a value and be rebuilt on the far side (`application/rpc/restoreError.ts`).
 *
 * **The argument and result shapes are declared here too, and that is the
 * point.** They appear in these signatures, so they ride `RequestContainer`
 * into the usecases; a usecase written in types the adapter owns is an
 * `application → adapters` dependency reversal, whatever `import type` makes it
 * look like. Declaring them beside the interface puts the whole contract inward
 * of its implementations, and the Durable Object facades import *from here* —
 * which is the permitted direction.
 *
 * They belong in `di/` rather than in `lib/` because they are not structural
 * primitives: `InitializeAccountArgs` names `LocatorRef` and the facades name
 * `CurrentUserView`, both of which are layered types `lib/` may not reach.
 */

export interface UserDataFacade {
  getCurrentUser(
    userId: string,
    epoch: number,
  ): Promise<RpcEnvelope<CurrentUserView>>;

  changeTrashRetentionDays(
    userId: string,
    epoch: number,
    days: number,
  ): Promise<RpcEnvelope<CurrentUserView>>;

  initializeAccount(args: InitializeAccountArgs): Promise<RpcEnvelope<null>>;

  verifyLogin(
    args: VerifyLoginArgs,
  ): Promise<RpcEnvelope<{ sessionEpoch: number }>>;

  recordCredentialLocator(
    args: RecordCredentialLocatorArgs,
  ): Promise<RpcEnvelope<null>>;

  /** Operator diagnostic. Outside the migration gate by design. */
  readSchemaVersion(): Promise<RpcEnvelope<number>> | RpcEnvelope<number>;
}

export interface IdentityDirectoryFacade {
  lookupCredential(
    args: LookupCredentialArgs,
  ): Promise<RpcEnvelope<LookupCredentialResult>>;

  reportLoginResult(
    kind: CredentialMappingKind,
    hmac: string,
    ok: boolean,
  ): Promise<RpcEnvelope<null>>;

  reserveCredential(
    args: ReserveCredentialFacadeArgs,
  ): Promise<RpcEnvelope<null>>;

  activateReservation(
    kind: CredentialMappingKind,
    hmac: string,
    operationId: string,
    userId: string,
    callerToken: string,
  ): Promise<RpcEnvelope<null>>;

  cancelReservation(
    kind: CredentialMappingKind,
    hmac: string,
    operationId: string,
    callerToken: string,
  ): Promise<RpcEnvelope<null>>;

  checkPreviousGeneration(
    kind: CredentialMappingKind,
    hmac: string,
  ): Promise<RpcEnvelope<boolean>>;

  requestPasswordReset(
    kind: CredentialMappingKind,
    hmac: string,
  ): Promise<RpcEnvelope<null>>;

  // `listBucketUserIds` is **deliberately absent**. The Durable Object class
  // still exposes it as an operator diagnostic, but it enumerates every
  // `userId` in a bucket and a `userId` is what addresses a user's own Durable
  // Object — so it has no business on the interface the composition root hands
  // to request-path code.
}

export type InitializeAccountArgs = Readonly<{
  userId: string;
  operationId: string;
  payloadDigest: string;
  callerToken: string;
  targetLocators: readonly LocatorRef[];
}>;

export type VerifyLoginArgs = Readonly<{
  userId: string;
  credentialId: string;
  credentialVersion: number;
}>;

export type RecordCredentialLocatorArgs = Readonly<{
  operationId: string;
  payloadDigest: string;
  callerToken: string;
  credentialId: string;
  kind: "email" | "sso";
  hmac: string;
  generation: number;
  bucketIndex: number;
  credentialVersion: number;
  usableForLogin: boolean;
  label: string;
}>;

export type LookupCredentialArgs = Readonly<{
  kind: CredentialMappingKind;
  hmac: string;
  generation: number;
  bucketIndex: number;
}>;

/** Echoed back so a caller walking two generations knows which one answered. */
type UsedLocator = Readonly<{
  kind: CredentialMappingKind;
  hmac: string;
  generation: number;
  bucketIndex: number;
}>;

/**
 * What a bucket answers a locator with — a discriminated union, so that the
 * combinations that cannot occur cannot be written.
 *
 * As a flat record with four independently-nullable fields it could express
 * "holds a verifier but has no `credentialId`", which forces the caller into a
 * `?? ""` that becomes `CredentialId.create("")` deep inside the next RPC — a
 * `BusinessRuleError` escaping through the one usecase whose central contract
 * is that *every* failure looks like `ValidationError("INVALID_CREDENTIALS")`.
 *
 * `credentialVersion` and `usedLocator` sit on every arm because the uniform
 * answer has to be the same shape as a real one; `none` covers all four
 * levelled cases at once (no row, unactivated, mid-change, throttled).
 */
export type LookupCredentialResult =
  | Readonly<{
      /** An email mapping holding password verification material. */
      outcome: "password";
      userId: string;
      credentialId: string;
      passwordVerifier: string;
      credentialVersion: number;
      usedLocator: UsedLocator;
    }>
  | Readonly<{
      /**
       * A usable mapping that holds no password material — an SSO row, or an
       * SSO-only account's address reservation. It resolves a `userId` and is
       * never a password login.
       */
      outcome: "identity";
      userId: string;
      credentialId: string;
      credentialVersion: number;
      usedLocator: UsedLocator;
    }>
  | Readonly<{
      outcome: "none";
      credentialVersion: number;
      usedLocator: UsedLocator;
    }>;

export type ReserveCredentialFacadeArgs = Readonly<{
  kind: CredentialMappingKind;
  hmac: string;
  generation: number;
  credentialId: string;
  /**
   * The canonical credential in the clear — the **only** entry that takes one.
   *
   * The bucket has to store a reversible copy of the address, and neither side
   * can produce it alone: the request Worker holds the plaintext but no
   * encryption key, and the state Worker holds the key but derives no canonical
   * (`DIRECTORY_ROUTING_SECRET` is not distributed to it). So the plaintext
   * travels one hop inward and is sealed by the entry point before the
   * transaction opens.
   *
   * This is not what the non-exposure rule forbids: that bars a raw address
   * from a Durable Object *name*, and from logs, errors and URLs, while the
   * value here is an RPC argument inside the trust boundary, one per signup
   * rather than in bulk. **It must never be written as-is, logged or echoed in
   * an error** — the ciphertext is what reaches the row.
   */
  canonical: string;
  candidateUserId: string;
  operationId: string;
  callerToken: string;
  reservedUntil: number;
  isCoordinator: boolean;
  passwordVerifier?: string;
  locators?: readonly LocatorRef[];
  coordinatorLocator?: string;
}>;

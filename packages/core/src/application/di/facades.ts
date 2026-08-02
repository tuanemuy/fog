import type {
  LookupCredentialArgs,
  LookupCredentialResult,
  ReserveCredentialFacadeArgs,
} from "@repo/core/adapters/cloudflare/identityDirectory/facade";
import type {
  CurrentUserPayload,
  InitializeAccountArgs,
  RecordCredentialLocatorArgs,
  VerifyLoginArgs,
} from "@repo/core/adapters/cloudflare/userData/facade";
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
 * Living in `di/` keeps `RequestContainer` free of any dependency on the state
 * Worker's implementation modules while still naming the contract exactly.
 */

export interface UserDataFacade {
  getCurrentUser(
    userId: string,
    epoch: number,
  ): Promise<RpcEnvelope<CurrentUserPayload>>;

  changeTrashRetentionDays(
    userId: string,
    epoch: number,
    days: number,
  ): Promise<RpcEnvelope<CurrentUserPayload>>;

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

  /** Operator diagnostic. Outside the migration gate by design. */
  listBucketUserIds(
    cursor: string | null,
    limit: number,
  ): Promise<RpcEnvelope<readonly string[]>> | RpcEnvelope<readonly string[]>;
}

import type { CredentialLocatorRef } from "@repo/core/domain/identity/ports/credentialLocatorStore";
import type { JobKind } from "@repo/core/lib/jobKind";

/**
 * Argument shapes for the in-transaction side-effect registration points on a
 * `UnitOfWorkContext`.
 *
 * All primitives and plain objects — **no branded types**. These values are
 * written verbatim into `jobs` / `operations` / `migration_progress`, they
 * cross the RPC boundary where a brand would be erased anyway, and reading
 * them back out of a row could not restore a brand honestly.
 */

export type EnqueueJobArgs = Readonly<{
  kind: JobKind;
  /**
   * The job's identity. Re-enqueuing under the same key converges on the same
   * row — never a second one — under the three rules in `jobs/table.ts`.
   */
  operationKey: string;
  payload: unknown;
  nextRunAt: number;
  /**
   * Derived deterministically from `operationKey` by the caller. Only
   * `send-mail` reaches an external provider, so only it supplies one.
   */
  providerIdempotencyKey?: string;
}>;

export type OperationKind =
  | "signup"
  | "link"
  | "unlink"
  | "credential-change"
  | "withdrawal";

export type OperationPhase = "reserving" | "activating" | "done" | "terminated";

/**
 * One credential locator, as stashed in `operations.target_locators`.
 *
 * An alias, not a second declaration: the same five fields are what a domain
 * port has to name when a reservation row carries them, and the domain cannot
 * import this module. So the shape is declared inward, in
 * `domain/identity/ports/credentialLocatorStore.ts`, and this is the name the
 * application layer calls it by.
 *
 * Stored as an array, not a single value: during a routing-key rotation the
 * same credential has rows in two generations' buckets, and this is the only
 * reverse information an orphan-mapping sweep can use.
 */
export type LocatorRef = CredentialLocatorRef;

export type RecordOperationArgs = Readonly<{
  operationId: string;
  kind: OperationKind;
  payloadDigest: string;
  phase: OperationPhase;
  targetLocators?: readonly LocatorRef[];
}>;

/** An `operations` row, as read back by the phase guards. */
export type OperationRecord = Readonly<{
  operationId: string;
  kind: OperationKind;
  payloadDigest: string;
  phase: OperationPhase;
  targetLocators: readonly LocatorRef[];
  terminalReason: string | null;
}>;

export type OperationPatch = Readonly<{
  phase?: OperationPhase;
  targetLocators?: readonly LocatorRef[];
  terminalReason?: string;
}>;

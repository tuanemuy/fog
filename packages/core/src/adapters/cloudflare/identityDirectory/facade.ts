import type {
  IdentityDirectoryUnitOfWorkContext,
  UnitOfWorkProvider,
} from "@repo/core/application/execution/unitOfWork";
import type { CredentialMappingKind } from "@repo/core/domain/identity/ports/credentialMappingRepository";
import { CredentialId } from "@repo/core/domain/identity/valueObject";

/**
 * The Identity Directory bucket's RPC facade.
 *
 * ## Its share of the full entry table (`.thread/34/design.md` §5.1)
 *
 * | Entry | Class | Status |
 * |---|---|---|
 * | `lookup-credential` | (2) | implemented — accepts `kind: 'email'` **and** `'sso'` |
 * | `report-login-result` | (2) | implemented |
 * | `reserve-credential` | (2) | implemented |
 * | `request-password-reset` | (2) | implemented |
 * | `lookup-credential-by-locator` | (2) | **not implemented** — password change phase 0 → #12 |
 * | `report-verify-result` | (2) | **not implemented** → #12 |
 * | `begin-credential-change` | (2) / (3-d) | **not implemented** → #12 |
 * | `consume-reset-token` | (2) | **not implemented** — reset completion → #12 |
 * | `activate-reservation` | (3-a) | implemented |
 * | `cancel-reservation` | (3-a) | implemented |
 * | `promote-verifier` | (3-a) | **not implemented**, including the `'advanced'`-only guard → #12 |
 * | `propagate-saga-committed` | (3-a) | **not implemented** → #45 |
 * | `check-previous-generation` | (3-c) | implemented |
 * | `read-own-canonical` | (3-b) | **not implemented** — settings-screen address display → #12 |
 * | `delete-mapping` | (3-b) | **not implemented** → #12 / #45. It is the *only* deletion path used by withdrawal step 3, unlink step 3 and `sweep-orphan-mapping` — which is precisely why `account.caller_token` is not cleared before a withdrawal completes (AC-27 iii). Without that note the next issue has to rediscover the reason. |
 * | `purge-user-mappings` | (3-c) | **not implemented** — operator last resort → #45 |
 * | `rotate-encryption` start | (3-c) | **not implemented** → #44 |
 * | `list-bucket-user-ids` | (3-c) | implemented on the DO class, deliberately outside `runRpcEntry` |
 *
 * Every entry takes primitives and rebuilds value objects inside, and none of
 * them touches raw SQL — the same two rules as the User Data facade.
 */

export type IdentityDirectoryFacadeDeps = Readonly<{
  uow: UnitOfWorkProvider<IdentityDirectoryUnitOfWorkContext>;
}>;

export type LookupCredentialArgs = Readonly<{
  kind: CredentialMappingKind;
  hmac: string;
  generation: number;
  bucketIndex: number;
}>;

export type LookupCredentialResult = Readonly<{
  userId: string | null;
  credentialId: string | null;
  /** `null` for an SSO row, and for every uniform-answer case. */
  passwordVerifier: string | null;
  credentialVersion: number;
  usedLocator: Readonly<{
    kind: CredentialMappingKind;
    hmac: string;
    generation: number;
    bucketIndex: number;
  }>;
}>;

export type ReserveCredentialFacadeArgs = Readonly<{
  kind: CredentialMappingKind;
  hmac: string;
  generation: number;
  credentialId: string;
  candidateUserId: string;
  operationId: string;
  callerToken: string;
  reservedUntil: number;
  isCoordinator: boolean;
  passwordVerifier?: string;
  locators?: readonly unknown[];
  coordinatorLocator?: string;
}>;

/**
 * Class (2), login step 3 and reset resolution.
 *
 * **Answers unconditionally and levels the answer.** Four situations all
 * produce the same "no usable material" shape: no row at all, a row whose
 * `status` is not `'active'`, a row with a change in flight, and a row still
 * inside its throttle window.
 *
 * - The `status` condition is not optional. A signup's phase-1a reservation row
 *   already carries `passwordVerifier`, so omitting it would hand an
 *   unactivated signup's verification material to an unauthenticated caller.
 * - `changeState` is treated as one condition covering both `'pending'` and
 *   `'advanced'`: while a change is mid-flight neither the old nor the new
 *   password may sign in (fail closed).
 *
 * `kind: 'sso'` rows are accepted here — that is what makes "resolve a `userId`
 * from an SSO provider and subject" work. They hold no `passwordVerifier`, so
 * there is no work to level; what comes back is the identity fields.
 */
export function lookupCredential(
  deps: IdentityDirectoryFacadeDeps,
  args: LookupCredentialArgs,
  now: number,
): LookupCredentialResult {
  const usedLocator = {
    kind: args.kind,
    hmac: args.hmac,
    generation: args.generation,
    bucketIndex: args.bucketIndex,
  };
  return deps.uow.run((ctx) => {
    const mapping = ctx.credentialMappingRepository.findByLocatorKey(
      args.kind,
      args.hmac,
    );
    const usable =
      mapping !== null &&
      mapping.status === "active" &&
      mapping.changeState === null &&
      (mapping.nextAttemptAllowedAt === null ||
        mapping.nextAttemptAllowedAt <= now);

    if (!usable || mapping === null) {
      return {
        userId: null,
        credentialId: null,
        passwordVerifier: null,
        credentialVersion: 0,
        usedLocator,
      };
    }
    return {
      userId: mapping.userId,
      credentialId: mapping.credentialId,
      passwordVerifier: mapping.passwordVerifier,
      credentialVersion: mapping.credentialVersion,
      usedLocator,
    };
  });
}

/**
 * Class (2), login step 7.
 *
 * Issued on **both** the success and the failure path, and completed before the
 * response goes out: making the failure report asynchronous would let a caller
 * dodge the counter by dropping the connection, which is the entire point of
 * the counter.
 *
 * A locator naming no row here updates nothing and still reports success, so an
 * unregistered canonical is answered exactly like a registered one.
 */
export function reportLoginResult(
  deps: IdentityDirectoryFacadeDeps,
  kind: CredentialMappingKind,
  hmac: string,
  ok: boolean,
): void {
  deps.uow.run((ctx) => {
    ctx.credentialMappingStore.reportResult(kind, hmac, ok);
  });
}

/**
 * Class (2), signup phase 1a / 1b.
 *
 * The reservation row and its follow-up jobs go into **one** `transactionSync`.
 * That is what the whole `CredentialMappingStore` port exists for: without a
 * write path on the context, this would have to reach for raw SQL or open its
 * own transaction, and either way the Directory would have no unit of work at
 * all (ADR-012).
 *
 * `sweep-reservations` is enqueued by whichever bucket wrote a row — cleanup
 * only runs where the row is. `resume-signup` is enqueued by the coordinator
 * alone: if every bucket drove the saga forward, phase 3 would advance
 * independently in each and one of them could reach phase 4 while another is
 * still behind.
 */
export function reserveCredential(
  deps: IdentityDirectoryFacadeDeps,
  args: ReserveCredentialFacadeArgs,
  now: number,
): void {
  const credentialId = CredentialId.create(args.credentialId);
  deps.uow.run((ctx) => {
    ctx.credentialMappingStore.reserve({
      kind: args.kind,
      hmac: args.hmac,
      generation: args.generation,
      credentialId,
      candidateUserId: args.candidateUserId,
      operationId: args.operationId,
      callerToken: args.callerToken,
      reservedUntil: args.reservedUntil,
      // Spread-conditionally rather than passing `undefined`: with
      // `exactOptionalPropertyTypes`, "absent" and "present as undefined" are
      // different, and absent is what "this credential has no verifier" means.
      ...(args.passwordVerifier === undefined
        ? {}
        : { passwordVerifier: args.passwordVerifier }),
      ...(args.locators === undefined ? {} : { locators: args.locators }),
      ...(args.coordinatorLocator === undefined
        ? {}
        : { coordinatorLocator: args.coordinatorLocator }),
    });
    // A per-bucket constant key, so repeated signups converge on one row under
    // the enqueue rules. Without this enqueue point the TTL sweep falls to
    // `done` while the bucket is idle and nothing revives it when the next
    // reservation appears.
    ctx.enqueueJob({
      kind: "sweep-reservations",
      operationKey: "sweep-reservations",
      payload: {},
      nextRunAt: args.reservedUntil,
    });
    if (args.isCoordinator) {
      ctx.enqueueJob({
        kind: "resume-signup",
        operationKey: `resume-signup:${args.operationId}`,
        payload: { operationId: args.operationId },
        nextRunAt: now + RESUME_SIGNUP_DELAY_MS,
      });
    }
  });
}

/** Class (3-a), signup phase 3. */
export function activateReservation(
  deps: IdentityDirectoryFacadeDeps,
  kind: CredentialMappingKind,
  hmac: string,
  operationId: string,
  userId: string,
): void {
  deps.uow.run((ctx) => {
    ctx.credentialMappingStore.activate(kind, hmac, operationId, userId);
  });
}

/** Class (3-a), loser compensation. `status`-independent, so `callerToken`-bound. */
export function cancelReservation(
  deps: IdentityDirectoryFacadeDeps,
  kind: CredentialMappingKind,
  hmac: string,
  operationId: string,
  callerToken: string,
): void {
  deps.uow.run((ctx) => {
    ctx.credentialMappingStore.cancel(kind, hmac, operationId, callerToken);
  });
}

/** Class (3-c). One bit, no side effect, no extra binding. */
export function checkPreviousGeneration(
  deps: IdentityDirectoryFacadeDeps,
  kind: CredentialMappingKind,
  hmac: string,
): boolean {
  return deps.uow.run((ctx) =>
    ctx.credentialMappingRepository.checkPreviousGeneration(kind, hmac),
  );
}

/**
 * Class (2), reset request.
 *
 * **A job row is written every time** — registered or not, SSO-only or not,
 * throttled or not. Identical row count, identical `setAlarm`, identical
 * response, so the four cases cannot be told apart by any observable. The
 * difference is confined to the payload: only a mapping that actually holds a
 * password verifier gets a token id, and a job with no recipient completes
 * having sent nothing.
 *
 * The decision is "does it hold verification material", not "does a credential
 * exist": an SSO-only account has an email mapping, and it must be treated
 * exactly like an unregistered address.
 */
export function requestPasswordReset(
  deps: IdentityDirectoryFacadeDeps,
  kind: CredentialMappingKind,
  hmac: string,
  now: number,
): void {
  deps.uow.run((ctx) => {
    const mapping = ctx.credentialMappingRepository.findByLocatorKey(
      kind,
      hmac,
    );
    const eligible =
      mapping !== null &&
      mapping.status === "active" &&
      mapping.changeState === null &&
      mapping.passwordVerifier !== null &&
      (mapping.lastResetRequestedAt === null ||
        mapping.lastResetRequestedAt + RESET_THROTTLE_MS <= now);

    const tokenId =
      eligible && mapping !== null
        ? ctx.resetTokenStore.issue(mapping.credentialId, new Date(now))
        : null;
    if (mapping !== null) {
      ctx.credentialMappingStore.recordResetRequested(kind, hmac, now);
    }

    // The payload carries the token *id*, never the token itself: the row is
    // readable by anyone who can read the job table, and the send derives the
    // link from the id at the last moment.
    ctx.enqueueJob({
      kind: "send-mail",
      operationKey: `send-mail:${kind}:${hmac}`,
      payload: { tokenId },
      nextRunAt: now,
      providerIdempotencyKey: `send-mail:${kind}:${hmac}`,
    });
  });
}

/** How long a coordinator waits before a stalled signup is driven forward. */
const RESUME_SIGNUP_DELAY_MS = 30_000;

/** Reset-request throttle window. The operational value is #38's. */
const RESET_THROTTLE_MS = 60_000;

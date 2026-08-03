import type {
  LookupCredentialArgs,
  LookupCredentialResult,
  ReserveCredentialFacadeArgs,
} from "@repo/core/application/di/facades";
import type {
  IdentityDirectoryUnitOfWorkContext,
  UnitOfWorkProvider,
} from "@repo/core/application/execution/unitOfWork";
import {
  holdsPasswordVerifier,
  isResetRequestAllowed,
  isUsableForLogin,
} from "@repo/core/domain/identity/credentialMappingRules";
import type { CredentialMappingKind } from "@repo/core/domain/identity/ports/credentialMappingRepository";
import type { SealedCanonical } from "@repo/core/domain/identity/ports/credentialMappingStore";
import type { ResetTokenIssueMaterial } from "@repo/core/domain/identity/ports/passwordResetTokenPort";
import { CredentialId } from "@repo/core/domain/identity/valueObject";
import {
  RESET_REQUEST_WINDOW_MS,
  RESET_TOKEN_TTL_MS,
} from "@repo/core/lib/jobBudgets";
import { sendMailOperationKey } from "./resetRequestKeys";

/**
 * The Identity Directory bucket's RPC facade.
 *
 * ## Its share of the full entry table
 *
 * | Entry | Class | Status |
 * |---|---|---|
 * | `lookup-credential` | (2) | implemented — accepts `kind: 'email'` **and** `'sso'` |
 * | `report-login-result` | (2) | implemented |
 * | `reserve-credential` | (2) | implemented |
 * | `request-password-reset` | (2) | implemented |
 * | `lookup-credential-by-locator` | (2) | **not implemented** — password change phase 0 |
 * | `report-verify-result` | (2) | **not implemented** |
 * | `begin-credential-change` | (2) / (3-d) | **not implemented** |
 * | `consume-reset-token` | (2) | **not implemented** — reset completion |
 * | `activate-reservation` | (3-a) | implemented |
 * | `cancel-reservation` | (3-a) | implemented |
 * | `promote-verifier` | (3-a) | **not implemented**, including the `'advanced'`-only guard |
 * | `propagate-saga-committed` | (3-a) | **not implemented** |
 * | `check-previous-generation` | (3-c) | implemented |
 * | `read-own-canonical` | (3-b) | **not implemented** — settings-screen address display |
 * | `delete-mapping` | (3-b) | **not implemented**. It is the *only* deletion path used by withdrawal step 3, unlink step 3 and `sweep-orphan-mapping` — which is precisely why `account.caller_token` is not cleared before a withdrawal completes (AC-27 iii). |
 * | `purge-user-mappings` | (3-c) | **not implemented** — operator last resort |
 * | `rotate-encryption` start | (3-c) | **not implemented** |
 * | `list-bucket-user-ids` | (3-c) | implemented on the DO class, deliberately outside `runRpcEntry` |
 *
 * Every entry takes primitives and rebuilds value objects inside, and none of
 * them touches raw SQL — the same two rules as the User Data facade.
 *
 * The argument and result shapes live in `application/di/facades.ts` for the
 * reason spelled out there and in the User Data facade: they ride the
 * `IdentityDirectoryFacade` interface into the usecases, so declaring them
 * here would write a usecase in an adapter-owned type.
 */

export type IdentityDirectoryFacadeDeps = Readonly<{
  uow: UnitOfWorkProvider<IdentityDirectoryUnitOfWorkContext>;
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
 * there is no work to level; what comes back is the `'identity'` arm.
 *
 * The three conditions are `domain/identity/credentialMappingRules.ts`'s, not
 * this module's: the same rule decides the reset request below and the send
 * job's recipient, and three copies of it is three places to amend.
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
    // A row with no `userId` is a reservation that never activated, which
    // `isUsableForLogin` has already excluded; the check is what carries that
    // into the type.
    if (
      mapping === null ||
      !isUsableForLogin(mapping, now) ||
      mapping.userId === null
    ) {
      return { outcome: "none", credentialVersion: 0, usedLocator };
    }
    const identity = {
      userId: mapping.userId,
      credentialId: mapping.credentialId,
      credentialVersion: mapping.credentialVersion,
      usedLocator,
    };
    return holdsPasswordVerifier(mapping)
      ? {
          outcome: "password",
          ...identity,
          passwordVerifier: mapping.passwordVerifier,
        }
      : { outcome: "identity", ...identity };
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
 * all.
 *
 * `sweep-reservations` is enqueued by whichever bucket wrote a row — cleanup
 * only runs where the row is. `resume-signup` is enqueued by the coordinator
 * alone: if every bucket drove the saga forward, phase 3 would advance
 * independently in each and one of them could reach phase 4 while another is
 * still behind.
 *
 * `sealed` is a parameter rather than something derived here, and that is the
 * whole shape of the writer: encryption is WebCrypto and therefore
 * asynchronous, `run`'s callback is type-rejected from being asynchronous, so
 * the ciphertext has to exist before this function is entered.
 */
export function reserveCredential(
  deps: IdentityDirectoryFacadeDeps,
  args: ReserveCredentialFacadeArgs,
  sealed: SealedCanonical,
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
      sealedCanonical: sealed,
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

/**
 * Class (3-a), signup phase 3.
 *
 * Takes the `callerToken` as well as the `operationId`: `operationId` is a value
 * the design permits in unauthenticated logs, so binding a write to knowledge of
 * it alone would turn a logged value into a capability — the reason
 * `recordCredentialLocator` and `cancelReservation` are `callerToken`-bound is
 * exactly the same one.
 */
export function activateReservation(
  deps: IdentityDirectoryFacadeDeps,
  kind: CredentialMappingKind,
  hmac: string,
  operationId: string,
  userId: string,
  callerToken: string,
): void {
  deps.uow.run((ctx) => {
    ctx.credentialMappingStore.activate(
      kind,
      hmac,
      operationId,
      userId,
      callerToken,
    );
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
 *
 * ## The window, and why the token and the mail share one
 *
 * `operationKey` carries `floor(now / RESET_REQUEST_WINDOW_MS)` and the issue
 * throttle decides eligibility on the same number. Letting the two differ
 * breaks: with a one-minute throttle and a `done` row that refuses re-enqueues
 * for a day, the second request of an hour issues a fresh token — deleting the
 * live one the user is holding — and then collides with the finished row, so no
 * mail goes out and the working link is gone. Sharing the number makes that
 * impossible: eligibility requires the request's window to be
 * strictly past the last request's, so an eligible request always lands on an
 * `operationKey` no row exists for yet.
 *
 * `recordResetRequested` therefore runs on **every** request, eligible or not
 * and registered or not: it is what puts the last request's window on the row,
 * and an unregistered locator names no row so the statement writes nothing.
 *
 * `material` is minted by the entry point **unconditionally** and discarded
 * here when the request is not eligible — two WebCrypto operations are a
 * measurable amount of work, so making them conditional would answer "is this
 * address registered?" through a timing channel. `providerIdempotencyKey`
 * arrives the same way, for the same reason it cannot be computed here: it is a
 * SHA-256 and a `run()` callback is type-rejected from being asynchronous.
 *
 * ## Two job rows, always the same two
 *
 * `send-mail` carries the request; `sweep-reset-tokens` is what eventually
 * removes the rows this path writes — consumed rows keep a `change_auth_token`,
 * and a bucket is shared by many users under one 10 GB cap, so a table nothing
 * ever deletes from is not an option. Both are enqueued whatever the four cases
 * decide, so the row count, the digests and the armed alarm stay identical
 * across them; `sweep-reset-tokens` has a per-bucket constant key, so repeated
 * requests converge on one row and it re-arms itself from `min(expires_at)`
 * thereafter.
 */
export function requestPasswordReset(
  deps: IdentityDirectoryFacadeDeps,
  kind: CredentialMappingKind,
  hmac: string,
  now: number,
  material: ResetTokenIssueMaterial,
  providerIdempotencyKey: string,
): void {
  deps.uow.run((ctx) => {
    const mapping = ctx.credentialMappingRepository.findByLocatorKey(
      kind,
      hmac,
    );
    const eligible =
      mapping !== null &&
      isResetRequestAllowed(mapping, now, RESET_REQUEST_WINDOW_MS);

    if (eligible && mapping !== null) {
      ctx.resetTokenStore.issue(mapping.credentialId, material, new Date(now));
    }
    ctx.credentialMappingStore.recordResetRequested(kind, hmac, now);

    // **The payload is the request's own input and nothing else.** It carries
    // no token, no token id and no derived state, for two reasons that both
    // have to hold. The row is readable by anyone who can read the job table
    // and survives in the recovery log after pruning, so a secret on it is a
    // secret at rest. And a payload that varied with the outcome would make
    // `enqueueJob`'s digest rule reject the second request of a burst against a
    // *registered* address while accepting it against an unregistered one —
    // handing back exactly the enumeration oracle the uniform path exists to
    // close. The send resolves everything it needs from this bucket's own rows.
    ctx.enqueueJob({
      kind: "send-mail",
      operationKey: sendMailOperationKey(kind, hmac, now),
      payload: { kind, hmac },
      nextRunAt: now,
      providerIdempotencyKey,
    });
    ctx.enqueueJob({
      kind: "sweep-reset-tokens",
      operationKey: "sweep-reset-tokens",
      payload: {},
      // The TTL of the token this request may have just issued. Convergence
      // only ever pulls a pending row earlier, so an already-armed sweep keeps
      // its earlier time and re-arms itself on the real `min(expires_at)` when
      // it runs.
      nextRunAt: now + RESET_TOKEN_TTL_MS,
    });
  });
}

/** How long a coordinator waits before a stalled signup is driven forward. */
const RESUME_SIGNUP_DELAY_MS = 30_000;

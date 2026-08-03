import type {
  InitializeAccountArgs,
  RecordCredentialLocatorArgs,
  VerifyLoginArgs,
} from "@repo/core/application/di/facades";
import {
  ConflictError,
  ForbiddenError,
  NotFoundError,
  UnauthorizedError,
} from "@repo/core/application/errors";
import type {
  UnitOfWorkProvider,
  UserDataUnitOfWorkContext,
} from "@repo/core/application/execution/unitOfWork";
import type { CurrentUserView } from "@repo/core/application/identity/view";
import { User } from "@repo/core/domain/identity/entity";
import type { AccountState } from "@repo/core/domain/identity/ports/accountStore";
import {
  CredentialId,
  TrashRetentionDays,
  UserId,
} from "@repo/core/domain/identity/valueObject";
import { CHUNK_BUDGETS } from "@repo/core/lib/jobBudgets";

/**
 * The User Data DO's usecase facade.
 *
 * ## The full RPC-entry table (`.thread/34/design.md` §5.1)
 *
 * The design's table has 26 rows: one class-(1) row, 11 class-(2) rows and 14
 * class-(3) rows. The class-(1) row is a *category* — "every user-data usecase
 * facade" — not a named entry, so the named entries number 11 + 14 = 25, of
 * which #37 implements 12 and leaves 13 to later issues. Rows belonging to the
 * Identity Directory are listed in that class's facade.
 *
 * | Entry | Class | Status |
 * |---|---|---|
 * | user-data usecase facades (category) | (1) | #37 implements `getCurrentUser` / `changeTrashRetentionDays`; memo / knowledge / search / trash / export / AI connections are #2–#10, #13 |
 * | `initialize-account` | (2) | implemented |
 * | `verify-login` | (2) | implemented |
 * | `exchange-authz-code` | (2) | **not implemented** — OAuth token endpoint → #13 |
 * | `advance-credential-change` | (3-d) | **not implemented** → #12 |
 * | `record-credential-locator` | (3-d) | implemented (signup phase 4; the rotation caller's protocol is #44) |
 * | `abandon-account` | (3-a) | **not implemented** — issued only by the automatic recovery → #45 |
 * | `read-schema-version` | (3-c) | implemented, and deliberately outside `runRpcEntry` |
 *
 * ## Two rules every entry here obeys
 *
 * 1. **Primitives only.** Brands exist at the type level and structured clone
 *    erases them, so a signature naming `Email` would have the type system
 *    assert a validation that never happened. Value objects are rebuilt inside,
 *    and *that reconstruction is* the second of the two validation points.
 * 2. **No raw SQL.** Everything goes through the unit of work, which is what
 *    makes the set of in-transaction writes countable.
 *
 * ## Where the argument and result shapes live
 *
 * Not here. `application/di/facades.ts` declares them alongside the
 * `UserDataFacade` interface these functions realise, because they travel on
 * that interface into `RequestContainer` and from there into the usecases —
 * and a usecase written in a type this module owns is a reversed dependency
 * (ADR-071). `CurrentUserView` is likewise the application's outbound DTO,
 * which this entry projects onto rather than restating.
 */

export type UserDataFacadeDeps = Readonly<{
  uow: UnitOfWorkProvider<UserDataUnitOfWorkContext>;
}>;

/**
 * Class (1): the epoch guard.
 *
 * `sessionEpoch` is the sole authority on revocation, and this is where it is
 * consulted — the request Worker's cookie check proves only that a token was
 * signed by us, never that it is still current.
 */
function requireActiveSession(
  account: AccountState | null,
  epoch: number,
): void {
  if (account === null || account.status !== "active") {
    throw new ForbiddenError(
      "ACCOUNT_NOT_ACTIVE",
      "This account cannot be used",
    );
  }
  if (account.sessionEpoch !== epoch) {
    throw new UnauthorizedError(
      "SESSION_REVOKED",
      "This session is no longer valid",
    );
  }
}

export function getCurrentUser(
  deps: UserDataFacadeDeps,
  userId: string,
  epoch: number,
): CurrentUserView {
  const id = UserId.create(userId);
  return deps.uow.run((ctx) => {
    requireActiveSession(ctx.accountStore.find(), epoch);
    const found = ctx.userSettingsRepository.find();
    if (found === null) {
      throw new NotFoundError("USER_NOT_FOUND", `User not found: ${id}`);
    }
    return toCurrentUserView(found.entity);
  });
}

export function changeTrashRetentionDays(
  deps: UserDataFacadeDeps,
  userId: string,
  epoch: number,
  days: number,
  now: number,
): CurrentUserView {
  UserId.create(userId);
  const retentionDays = TrashRetentionDays.create(days);

  return deps.uow.run((ctx) => {
    requireActiveSession(ctx.accountStore.find(), epoch);
    const found = ctx.userSettingsRepository.find();
    if (found === null) {
      throw new NotFoundError("USER_NOT_FOUND", `User not found: ${userId}`);
    }
    const next = User.changeTrashRetentionDays(
      found.entity,
      retentionDays,
      new Date(now),
    );
    // Identity, not equality: re-posting the current value must not burn an OCC
    // round trip against a concurrent writer.
    if (next === found.entity) return toCurrentUserView(found.entity);

    ctx.userSettingsRepository.save(next, found.expectedVersion);
    // Recomputing every trashed item's `purge_after` belongs to the *same*
    // transaction as the settings change; the job below only carries the tail
    // of the work when there is more of it than one transaction can afford.
    // The job is enqueued unconditionally rather than only when a tail remains,
    // because it also owns the re-arm: a shortened window has to pull the next
    // wake-up forward, and a lengthened one has to push it back, and only the
    // job's own completion may move an alarm later.
    ctx.recalcTrashPurgeAfter(
      retentionDays,
      CHUNK_BUDGETS["purge-trash"].chunkRowLimit,
    );
    ctx.enqueueJob({
      kind: "purge-trash",
      operationKey: "purge-trash",
      payload: {},
      nextRunAt: now,
    });
    return toCurrentUserView(next);
  });
}

/**
 * Class (2), signup phase 2.
 *
 * The predicate is the pair of the `account` row and the `operations` row, not
 * the `account` row alone — four branches, and collapsing any of them breaks
 * something specific:
 *
 * - no `account` row → initialise;
 * - `account` row but no matching `operations` row → refuse, because this is a
 *   write aimed at somebody else's Durable Object;
 * - matching row, same digest → succeed as a no-op, which is where a re-send
 *   after a lost response lands;
 * - matching row, different digest → `ConflictError`.
 *
 * Refusing unconditionally on branch two would never reach branches three and
 * four, and phase 2 would stop being idempotent.
 */
export function initializeAccount(
  deps: UserDataFacadeDeps,
  args: InitializeAccountArgs,
  now: number,
): void {
  const id = UserId.create(args.userId);

  deps.uow.run((ctx) => {
    const account = ctx.accountStore.find();
    if (account !== null) {
      const operation = ctx.findOperation(args.operationId);
      if (operation === null) {
        throw new ForbiddenError(
          "OPERATION_NOT_RECOGNISED",
          "This account was not initialised by the operation supplied",
        );
      }
      if (operation.payloadDigest !== args.payloadDigest) {
        throw new ConflictError(
          "OPERATION_PAYLOAD_MISMATCH",
          "The same operation id was replayed with a different payload",
        );
      }
      return;
    }

    ctx.recordOperation({
      operationId: args.operationId,
      kind: "signup",
      payloadDigest: args.payloadDigest,
      phase: "activating",
      targetLocators: args.targetLocators,
    });
    ctx.accountStore.initialize(args.callerToken, new Date(now));
    ctx.userSettingsRepository.insert(User.initialize({ id }, new Date(now)));
  });
}

/**
 * Class (2), login step 5.
 *
 * Three checks, all inside the DO the caller already had to reach, so they cost
 * no extra round trip:
 *
 * 1. the account is `active`;
 * 2. **reachability** — a locator row for that `credentialId` exists. This is
 *    what fails closed on an orphan mapping (the Directory still maps the
 *    credential but this side has unlinked it), and it is the condition that
 *    lets the design do without a central account-home lookup;
 * 3. **every** locator row for that credential agrees on `credentialVersion`.
 *    Between the Directory read and this call a credential-change saga can
 *    complete, which would otherwise mint a session on a password that has just
 *    been retired. "Every" is meaningful because `credentialVersion` is managed
 *    per credential across all generations — two generations disagreeing is
 *    itself the drift to fail on.
 *
 * The epoch guard does not apply: login is what *issues* the token, so there is
 * no token yet to compare against.
 */
export function verifyLogin(
  deps: UserDataFacadeDeps,
  args: VerifyLoginArgs,
): { sessionEpoch: number } {
  UserId.create(args.userId);
  const credentialId = CredentialId.create(args.credentialId);

  return deps.uow.run((ctx) => {
    const account = ctx.accountStore.find();
    if (account === null || account.status !== "active") {
      throw new ForbiddenError(
        "ACCOUNT_NOT_ACTIVE",
        "This account cannot be used",
      );
    }
    const locators = ctx.credentialLocatorStore
      .list()
      .filter((locator) => locator.credentialId === credentialId);
    if (locators.length === 0) {
      throw new UnauthorizedError(
        "CREDENTIAL_NOT_REACHABLE",
        "That credential is not registered on this account",
      );
    }
    if (
      locators.some(
        (locator) => locator.credentialVersion !== args.credentialVersion,
      )
    ) {
      throw new UnauthorizedError(
        "CREDENTIAL_VERSION_MISMATCH",
        "That credential changed while signing in; please try again",
      );
    }
    return { sessionEpoch: account.sessionEpoch };
  });
}

/**
 * Class (3-d), signup phase 4.
 *
 * **The two effects are written in one transaction, and must never be split
 * into two RPCs.** Splitting them creates a stable intermediate state in which
 * the locator row exists (so login's reachability check passes) while the
 * operation still reads `activating` — and a `resume-signup` that lands in
 * `poison` makes that state permanent. An account in it can then be destroyed
 * by `abandon-account`, whose safety argument rests on only ever reaching
 * signups that have no way in.
 *
 * The binding is `callerToken`, not `operationId`: the design permits
 * `operationId` in unauthenticated logs, so binding a write to knowledge of it
 * alone would turn a logged value into a capability.
 */
export function recordCredentialLocator(
  deps: UserDataFacadeDeps,
  args: RecordCredentialLocatorArgs,
): void {
  const credentialId = CredentialId.create(args.credentialId);

  deps.uow.run((ctx) => {
    if (!ctx.accountStore.matchCallerToken(args.callerToken)) {
      throw new ForbiddenError(
        "CALLER_NOT_BOUND",
        "The caller is not bound to this account",
      );
    }
    const operation = ctx.findOperation(args.operationId);
    if (operation === null) {
      throw new ForbiddenError(
        "OPERATION_NOT_RECOGNISED",
        "No such operation on this account",
      );
    }
    if (operation.payloadDigest !== args.payloadDigest) {
      throw new ConflictError(
        "OPERATION_PAYLOAD_MISMATCH",
        "The same operation id was replayed with a different payload",
      );
    }

    ctx.credentialLocatorStore.record({
      credentialId,
      kind: args.kind,
      hmac: args.hmac,
      generation: args.generation,
      bucketIndex: args.bucketIndex,
      credentialVersion: args.credentialVersion,
      usableForLogin: args.usableForLogin,
      label: args.label,
    });
    ctx.updateOperation(args.operationId, { phase: "done" });
  });
}

function toCurrentUserView(user: User): CurrentUserView {
  return {
    userId: user.id,
    credentials: user.credentials.map((credential) => ({
      credentialId: credential.credentialId,
      kind: credential.kind,
      label: credential.label,
      usableForLogin: credential.usableForLogin,
    })),
    trashRetentionDays: user.trashRetentionDays,
  };
}

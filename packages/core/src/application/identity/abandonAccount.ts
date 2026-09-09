import { SystemError, SystemErrorCode } from "../errors";
import type { UserDataUnitOfWorkContext } from "../execution/unitOfWork";
import { CALLER_TOKEN_MIN_LENGTH } from "./callerToken";
import { FINALIZE_WITHDRAWAL_OPERATION_KEY } from "./jobKeys";

export type AbandonAccountDto = Readonly<{
  operationId: string;
  callerToken: string;
}>;

/**
 * The three answers of `abandon-account` (`spec/recovery/index.md`).
 * `abandoned` — the account is (now) on its way out; `already-completed` —
 * the saga this cleanup belongs to finished, nothing may be abandoned;
 * `nothing-to-abandon` — there is no account or no record for this saga.
 */
export type AbandonAccountResult =
  | "abandoned"
  | "already-completed"
  | "nothing-to-abandon";

type OperationRow = Readonly<{ kind: string; phase: string }>;

/**
 * Stage S2 of the signup cleanup, inside the User Data object. The six
 * checks run in the spec's order and that order is load-bearing: the
 * status check (2) precedes the binding check (3) so that an account
 * whose caller token is already gone (withdrawal completed) still
 * answers `abandoned` rather than refusing; the record check (5) is what
 * keeps a completed signup from ever being abandoned. Step (1), the
 * uninitialised object, is the facade's — it answers before the gate.
 *
 * `beginDeletion` is the same write as a withdrawal's start, and the
 * `finalize-withdrawal` row it enqueues converges on the object's one
 * constant key, whichever of the two entry points wrote it first.
 */
export function abandonAccountProcedure(
  ctx: UserDataUnitOfWorkContext,
  sql: SqlStorage,
  dto: AbandonAccountDto,
  now: Date,
): AbandonAccountResult {
  const account = ctx.accountStore.find();
  if (account === null) return "nothing-to-abandon";
  if (account.status !== "active") return "abandoned";
  const bound = sql
    .exec<{ caller_token: string | null }>(
      "SELECT caller_token FROM account LIMIT 1",
    )
    .toArray()[0]?.caller_token;
  if (
    typeof bound !== "string" ||
    bound.length < CALLER_TOKEN_MIN_LENGTH ||
    dto.callerToken.length < CALLER_TOKEN_MIN_LENGTH ||
    !constantTimeEqual(bound, dto.callerToken)
  ) {
    // Not a configuration fault: the material this cleanup carries names
    // another saga's account, or the binding is gone. The code is what an
    // operator triages on, so it says so.
    throw new SystemError(
      SystemErrorCode.DataIntegrityError,
      "abandon-account: the caller binding does not match",
    );
  }
  const operation = sql
    .exec<OperationRow>(
      "SELECT kind, phase FROM operations WHERE operation_id = ?",
      dto.operationId,
    )
    .toArray()[0];
  if (operation === undefined || operation.kind !== "signup") {
    return "nothing-to-abandon";
  }
  if (operation.phase === "done") return "already-completed";
  ctx.accountStore.beginDeletion();
  ctx.enqueueJob({
    operationKey: FINALIZE_WITHDRAWAL_OPERATION_KEY,
    kind: "finalize-withdrawal",
    payload: {},
    nextRunAt: now,
  });
  return "abandoned";
}

function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}

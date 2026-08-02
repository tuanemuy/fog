import { one } from "../../sql/exec";
import type { IdentityDirectoryJobContext, JobHandler } from "../registry";
import type { JobRow } from "../table";

/**
 * The coordinator bucket's watch over a signup saga — class (C).
 *
 * ## What it does today, and what it deliberately does not
 *
 * The saga's phases 1b → 4 are cross-Durable-Object calls. #37 confines the
 * Durable-Object selection point to the request Worker's composition root, so a
 * bucket holds no way to reach another DO and the *re-drive* half of this job
 * cannot be written without moving that boundary. What is implemented here is
 * the half that needs no stubs: observe the coordinator's reservation row, let
 * a saga that finished settle quietly, and take an abandoned one to the uniform
 * terminus. See `.thread/37/adr.md` ADR-031.
 *
 * ## The terminus writes nothing away
 *
 * `poison` + `terminal_reason` is where an abandoned signup stops, and the
 * reservation row is left exactly as it is — `locators`, `candidate_user_id`
 * and `caller_token` are the only reverse information a rollback will have, and
 * #45 is the issue that consumes them. Deleting them here would remove the
 * evidence before anything read it. Expired reservations are reclaimed by
 * `sweep-reservations`, which is a different question from whether the saga
 * itself can still advance.
 */

function readOperationId(row: JobRow): string | null {
  const payload = JSON.parse(row.payload) as { operationId?: unknown } | null;
  return typeof payload?.operationId === "string" ? payload.operationId : null;
}

export const resumeSignup: JobHandler<IdentityDirectoryJobContext> = async (
  context,
  row,
) => {
  const { sql, now } = context;
  const operationId = readOperationId(row);
  if (operationId === null) {
    return { kind: "terminal", reason: "RESUME_SIGNUP_PAYLOAD_INVALID" };
  }

  // The coordinator is the one reservation of the operation that points at no
  // other bucket; every follower row carries `coordinator_locator`.
  const coordinator = one<{
    status: string;
    reserved_until: number;
    saga_committed: number | null;
  }>(
    sql,
    `SELECT status, reserved_until, saga_committed
       FROM credential_mappings
      WHERE operation_id = ? AND coordinator_locator IS NULL`,
    operationId,
  );

  // Gone: compensated by the loser path, or already swept. Either way there is
  // nothing left to drive.
  if (coordinator === null) return { kind: "done" };
  // Phase 3 promoted it, so the saga got past the point this job watches.
  if (coordinator.status === "active" || coordinator.saga_committed !== null) {
    return { kind: "done" };
  }
  // Still inside its TTL: look again when it runs out rather than declaring a
  // saga stalled while the request that owns it is merely slow.
  if (coordinator.reserved_until > now) {
    return { kind: "rearm", nextRunAt: coordinator.reserved_until };
  }
  return { kind: "terminal", reason: "SIGNUP_RESERVATION_EXPIRED" };
};

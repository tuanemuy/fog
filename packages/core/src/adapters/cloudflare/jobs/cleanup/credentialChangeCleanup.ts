import type { ResumeCredentialChangePayload } from "@repo/core/application/identity/credentialChangeProcedures";
import { decodeMapping } from "../../crypto/locatorDerivation";
import type { JobHandler, JobRow } from "../../jobRunner";

/**
 * Whether a `resume-credential-change` row has a cleanup stage right
 * now: only while its mapping is still `pending` under this very saga.
 * `advanced` has no stage (the change is applied; forward is the only
 * way), and a row another operation took over has nothing of ours to
 * roll back.
 */
export function credentialChangeHasCleanup(
  row: JobRow,
  sql: SqlStorage,
): boolean {
  const payload = JSON.parse(row.payload) as ResumeCredentialChangePayload;
  const locator = decodeMapping(
    payload.coordinate.kind,
    payload.coordinate.mapping,
  );
  if (locator === null) return false;
  const state = sql
    .exec<{ change_state: string | null; operation_id: string | null }>(
      "SELECT change_state, operation_id FROM credential_mappings WHERE kind = ? AND hmac = ?",
      locator.kind,
      locator.hmac,
    )
    .toArray()[0];
  return (
    state !== undefined &&
    state.change_state === "pending" &&
    state.operation_id === payload.operationId
  );
}

/**
 * C1 of `spec/recovery/index.md`: one local write that drops the pending
 * verifier and the change marks, guarded on `change_state = 'pending'`
 * and this saga's `operation_id`, in the transaction that marks the job
 * `done`. Zero rows (a later change replaced it) is success. No RPC,
 * and nothing about `sessionEpoch` / `credentialVersion` /
 * `password_verifier` moves.
 */
export function createCredentialChangeCleanupHandler(): JobHandler {
  return async ({ payload }) => {
    const { operationId, coordinate } =
      payload as ResumeCredentialChangePayload;
    const locator = decodeMapping(coordinate.kind, coordinate.mapping);
    if (locator === null) return { kind: "poison", reason: "material-lost" };
    return {
      kind: "finished",
      commit: (tx) => {
        tx.exec(
          `UPDATE credential_mappings
           SET pending_verifier = NULL, change_state = NULL, change_origin = NULL, operation_id = NULL
           WHERE kind = ? AND hmac = ? AND change_state = 'pending' AND operation_id = ?`,
          locator.kind,
          locator.hmac,
          operationId,
        );
        return undefined;
      },
    };
  };
}

import {
  ConflictError,
  SystemError,
  SystemErrorCode,
} from "@repo/core/application/errors";
import type {
  RecordOperationInput,
  UpdateOperationInput,
} from "@repo/core/application/execution/unitOfWork";
import { canonicalPayloadDigest } from "../payloadDigest";
import { updateMatchedRow } from "../rowRunner";

/**
 * `recordOperation` — creates the row a saga records its progress on.
 *
 * Idempotency of a re-sent RPC is what this table exists for: the same
 * `operation_id` with the same payload writes nothing the second time,
 * and with a different payload raises `ConflictError`. Unlike `jobs`,
 * that comparison is **not** scoped to any status — the column definition
 * carries no state qualifier, so it holds for the whole life of the row.
 *
 * The operation id is minted server-side. Cross-request idempotency keys
 * never come from the client.
 */
export function writeRecordedOperation(
  sql: SqlStorage,
  input: RecordOperationInput,
  now: number,
): void {
  const digest = canonicalPayloadDigest(input.payload);
  const existing = sql
    .exec<{ payload_digest: string }>(
      "SELECT payload_digest FROM operations WHERE operation_id = ?",
      input.operationId,
    )
    .toArray()[0];

  if (existing) {
    if (existing.payload_digest !== digest) {
      throw new ConflictError(
        "OPERATION_PAYLOAD_MISMATCH",
        `Operation ${input.operationId} was already recorded with a different payload`,
      );
    }
    return;
  }

  sql.exec(
    `INSERT INTO operations (operation_id, kind, payload_digest, phase, target_locators, terminal_reason, created_at)
     VALUES (?, ?, ?, ?, ?, NULL, ?)`,
    input.operationId,
    input.kind,
    digest,
    input.phase,
    input.targetLocators ? JSON.stringify(input.targetLocators) : null,
    now,
  );
}

/**
 * `updateOperation` — advances the phase and writes the terminal reason.
 *
 * `phase` is the only column every call writes. The two nullable columns
 * are addressed the same way: omitting one leaves the stored value alone
 * and passing an explicit value replaces it, so a call that only advances
 * the phase erases neither. `terminal_reason` is on those terms because a
 * termination already recorded is what an operator reads, and
 * `target_locators` because it is the material a later recovery reads and
 * the idempotency material against double issuance
 * (`spec/recovery/index.md`) — which is also why `null` clears only
 * `terminal_reason`: the locators have no clearing form at all.
 */
export function writeUpdatedOperation(
  sql: SqlStorage,
  input: UpdateOperationInput,
): void {
  const assignments = ["phase = ?"];
  const bindings: SqlStorageValue[] = [input.phase];

  if (input.terminalReason !== undefined) {
    assignments.push("terminal_reason = ?");
    bindings.push(input.terminalReason);
  }
  if (input.targetLocators !== undefined) {
    assignments.push("target_locators = ?");
    bindings.push(JSON.stringify(input.targetLocators));
  }

  const matched = updateMatchedRow(
    sql,
    `UPDATE operations SET ${assignments.join(", ")} WHERE operation_id = ?`,
    ...bindings,
    input.operationId,
  );

  if (!matched) {
    throw new SystemError(
      SystemErrorCode.DataIntegrityError,
      `Operation ${input.operationId} does not exist`,
    );
  }
}

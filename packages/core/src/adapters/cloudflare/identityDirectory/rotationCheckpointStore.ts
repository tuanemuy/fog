import type {
  RotationCheckpoint,
  RotationCheckpointStore,
  RotationKind,
} from "@repo/core/domain/identity/ports/rotationCheckpointStore";
import { one, run, type Sql } from "../sql/exec";

/**
 * `rotation_checkpoints`, keyed by `(rotation_kind, bucket_index, generation)`.
 *
 * **Nothing writes here yet** — the transfer procedure that would is not
 * implemented. The store exists so the table has the single write path the
 * non-aggregate-store roster claims it has, rather than being listed with no
 * way to reach it.
 */
export function createRotationCheckpointStore(
  sql: Sql,
): RotationCheckpointStore {
  return {
    record(checkpoint: RotationCheckpoint): void {
      run(
        sql,
        `INSERT INTO rotation_checkpoints (
           rotation_kind, bucket_index, generation, previous_count, scanned_at,
           conflict_count, last_conflict_at, last_conflict_credential_id
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (rotation_kind, bucket_index, generation) DO UPDATE SET
           previous_count = excluded.previous_count,
           scanned_at = excluded.scanned_at,
           conflict_count = excluded.conflict_count,
           last_conflict_at = excluded.last_conflict_at,
           last_conflict_credential_id = excluded.last_conflict_credential_id`,
        checkpoint.rotationKind,
        checkpoint.bucketIndex,
        checkpoint.generation,
        checkpoint.previousCount,
        checkpoint.scannedAt,
        checkpoint.conflictCount,
        checkpoint.lastConflictAt,
        checkpoint.lastConflictCredentialId,
      );
    },

    find(
      rotationKind: RotationKind,
      bucketIndex: number,
      generation: number,
    ): RotationCheckpoint | null {
      const row = one<{
        rotation_kind: string;
        bucket_index: number;
        generation: number;
        previous_count: number;
        scanned_at: number;
        conflict_count: number;
        last_conflict_at: number | null;
        last_conflict_credential_id: string | null;
      }>(
        sql,
        `SELECT rotation_kind, bucket_index, generation, previous_count,
                scanned_at, conflict_count, last_conflict_at,
                last_conflict_credential_id
           FROM rotation_checkpoints
          WHERE rotation_kind = ? AND bucket_index = ? AND generation = ?`,
        rotationKind,
        bucketIndex,
        generation,
      );
      if (row === null) return null;
      return {
        rotationKind: row.rotation_kind as RotationKind,
        bucketIndex: row.bucket_index,
        generation: row.generation,
        previousCount: row.previous_count,
        scannedAt: row.scanned_at,
        conflictCount: row.conflict_count,
        lastConflictAt: row.last_conflict_at,
        lastConflictCredentialId: row.last_conflict_credential_id,
      };
    },
  };
}

import type {
  RotationCheckpoint,
  RotationCheckpointStore,
  RotationKind,
} from "@repo/core/application/execution/unitOfWork";

type CheckpointRow = Readonly<{
  rotation_kind: RotationKind;
  bucket_index: number;
  generation: number;
  previous_count: number;
  scanned_at: number;
  conflict_count: number;
  last_conflict_at: number | null;
  last_conflict_credential_id: string | null;
}>;

const SELECT = `SELECT rotation_kind, bucket_index, generation, previous_count, scanned_at, conflict_count, last_conflict_at, last_conflict_credential_id
  FROM rotation_checkpoints`;

function toCheckpoint(row: CheckpointRow): RotationCheckpoint {
  return {
    rotationKind: row.rotation_kind,
    bucketIndex: row.bucket_index,
    generation: row.generation,
    previousCount: row.previous_count,
    scannedAt: row.scanned_at,
    conflictCount: row.conflict_count,
    lastConflictAt: row.last_conflict_at,
    lastConflictCredentialId: row.last_conflict_credential_id,
  };
}

/**
 * `rotation_checkpoints` — this module is the only one that writes the
 * table (`spec/database/index.md`; TC-keyRotation-022 scans for it).
 * The bucket outside the unit of work reads it through {@link readRotationCheckpoint}.
 */
export function createRotationCheckpointStore(
  sql: SqlStorage,
): RotationCheckpointStore {
  return {
    replace(checkpoint) {
      sql.exec(
        `INSERT INTO rotation_checkpoints
           (rotation_kind, bucket_index, generation, previous_count, scanned_at, conflict_count, last_conflict_at, last_conflict_credential_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
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
    delete(rotationKind, bucketIndex, generation) {
      sql.exec(
        "DELETE FROM rotation_checkpoints WHERE rotation_kind = ? AND bucket_index = ? AND generation = ?",
        rotationKind,
        bucketIndex,
        generation,
      );
    },
    read(rotationKind, bucketIndex, generation) {
      return readRotationCheckpoint(sql, rotationKind, bucketIndex, generation);
    },
  };
}

/** The read the `read-rotation-checkpoint` entry answers with; `null` is "not yet scanned". */
export function readRotationCheckpoint(
  sql: SqlStorage,
  rotationKind: RotationKind,
  bucketIndex: number,
  generation: number,
): RotationCheckpoint | null {
  const row = sql
    .exec<CheckpointRow>(
      `${SELECT} WHERE rotation_kind = ? AND bucket_index = ? AND generation = ?`,
      rotationKind,
      bucketIndex,
      generation,
    )
    .toArray()[0];
  return row ? toCheckpoint(row) : null;
}

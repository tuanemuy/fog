export type RotationKind = "remap" | "encryption";

export type RotationCheckpoint = Readonly<{
  rotationKind: RotationKind;
  bucketIndex: number;
  generation: number;
  /** Rows still carrying the previous generation at the time of the scan. */
  previousCount: number;
  scannedAt: number;
  conflictCount: number;
  lastConflictAt: number | null;
  lastConflictCredentialId: string | null;
}>;

/**
 * Per-bucket progress of a key rotation, keyed by
 * `(rotationKind, bucketIndex, generation)` — an upsert, not an append.
 *
 * **Nothing in #37 writes here.** The writer is the transfer procedure, which
 * #44 designs; the columns and the write path exist now so that the retirement
 * argument ("no row of the previous generation remains") has somewhere to land
 * when it arrives.
 */
export interface RotationCheckpointStore {
  record(checkpoint: RotationCheckpoint): void;
  find(
    rotationKind: RotationKind,
    bucketIndex: number,
    generation: number,
  ): RotationCheckpoint | null;
}

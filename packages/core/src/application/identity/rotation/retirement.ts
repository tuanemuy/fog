import type {
  RotationCheckpoint,
  RotationKind,
} from "../../execution/unitOfWork";

/**
 * The retirement condition (RI-7 of `spec/rotation/index.md`): a
 * generation may leave the keyring only when, **for that `rotationKind`**,
 * a checkpoint of that generation exists for every bucket `0 ..
 * bucketCount - 1` and each says `previousCount = 0`. One bucket missing
 * or non-zero and it does not hold.
 *
 * `bucketCount` is the caller's to choose correctly, and the choice
 * differs by kind: for `remap` it is the **retiring** generation's own
 * bucket count (its buckets are the ones being emptied); for
 * `encryption` it is the **active mapping generation's**, since that is
 * where the rows live. Counting with the other side's number either
 * leaves buckets unscanned or asks for checkpoints no bucket will ever
 * write.
 *
 * Filtering by kind is not optional: the two rotations share the table,
 * and a `previousCount = 0` written by `rotate-encryption` would
 * otherwise vouch for the mapping key.
 */
export function isRetired(
  checkpoints: readonly RotationCheckpoint[],
  rotationKind: RotationKind,
  generation: number,
  bucketCount: number,
): boolean {
  if (!Number.isInteger(bucketCount) || bucketCount < 1) return false;
  const byBucket = new Map<number, RotationCheckpoint>();
  for (const checkpoint of checkpoints) {
    if (
      checkpoint.rotationKind !== rotationKind ||
      checkpoint.generation !== generation
    ) {
      continue;
    }
    byBucket.set(checkpoint.bucketIndex, checkpoint);
  }
  for (let index = 0; index < bucketCount; index += 1) {
    const checkpoint = byBucket.get(index);
    if (checkpoint === undefined || checkpoint.previousCount !== 0) {
      return false;
    }
  }
  return true;
}

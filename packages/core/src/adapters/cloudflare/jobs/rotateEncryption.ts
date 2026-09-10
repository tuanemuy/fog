import { SystemError, SystemErrorCode } from "@repo/core/application/errors";
import type {
  IdentityDirectoryUnitOfWorkContext,
  UnitOfWorkRunner,
} from "@repo/core/application/execution/unitOfWork";
import type { CredentialKind } from "@repo/core/domain/identity/ports/credentialMappingRepository";
import { openCanonical, sealCanonical } from "../crypto/canonicalCipher";
import {
  activeKey,
  type EncryptionKeyring,
  previousKey,
} from "../crypto/keyring";
import type { JobHandler } from "../jobRunner";
import { updateMatchedRow } from "../rowRunner";

type SealedRow = Readonly<{
  kind: CredentialKind;
  hmac: string;
  credential_id: string;
  encrypted_canonical: string;
  encryption_generation: number;
  encryption_nonce: string;
}>;

export type RotateEncryptionDeps = Readonly<{
  encryptionKeyring: () => EncryptionKeyring;
  bucket: () => { generation: number; bucketIndex: number };
  runUnitOfWork: UnitOfWorkRunner<IdentityDirectoryUnitOfWorkContext>;
}>;

/**
 * `rotate-encryption`: every row still sealed under a retired encryption
 * generation is opened and sealed again under the active one
 * (`spec/rotation/index.md`, メール暗号鍵ローテーション). The crypto is
 * asynchronous and runs before the chunk's transaction; the transaction
 * holds only the rewrites, the proof invalidation and the checkpoint.
 *
 * **Each rewrite is conditioned on the row's encryption generation.** The
 * input gate opens between the read and the write, and in that gap the
 * row can be deleted and the same canonical reserved again as a new row
 * with a new `credential_id` — whose AAD the old ciphertext does not
 * carry. Without the condition the rewrite would land on that new row
 * and make it undecryptable for good; with it, zero rows is that row's
 * completion.
 *
 * Each chunk's transaction deletes `(encryption, index, active)` — the
 * active generation's rows are what the rewrite adds to — and replaces
 * `(encryption, index, retiring)` with the count left. The row ends
 * `done` in the transaction that writes `previousCount = 0`. No previous
 * entry in the keyring means nothing to rotate: `done` at once.
 *
 * A chunk that decrypts none of its rows cannot make progress and is a
 * failure, not a yield: retrying would spin on the same rows.
 */
export function createRotateEncryptionHandler(
  deps: RotateEncryptionDeps,
): JobHandler {
  return async ({ storage, now, tuning }) => {
    const keyring = deps.encryptionKeyring();
    const previous = previousKey(keyring);
    if (previous === null) return { kind: "finished" };
    const active = activeKey(keyring);
    const bucket = deps.bucket();
    const sql = storage.sql;

    for (let i = 0; i < tuning.jobsMaxChunkIterations; i += 1) {
      const rows = sql
        .exec<SealedRow>(
          `SELECT kind, hmac, credential_id, encrypted_canonical, encryption_generation, encryption_nonce
           FROM credential_mappings WHERE encryption_generation != ? LIMIT ?`,
          active.generation,
          tuning.jobsMaxRowsPerChunk,
        )
        .toArray();

      const rewrites: Array<{
        row: SealedRow;
        ciphertext: string;
        nonce: string;
      }> = [];
      for (const row of rows) {
        const aad = { kind: row.kind, credentialId: row.credential_id };
        const canonical = await openCanonical(keyring, aad, {
          ciphertext: row.encrypted_canonical,
          encryptionGeneration: row.encryption_generation,
          nonce: row.encryption_nonce,
        });
        if (canonical === null) continue;
        const sealed = await sealCanonical(keyring, aad, canonical);
        rewrites.push({
          row,
          ciphertext: sealed.ciphertext,
          nonce: sealed.nonce,
        });
      }
      if (rows.length > 0 && rewrites.length === 0) {
        throw new SystemError(
          SystemErrorCode.DataIntegrityError,
          "rotate-encryption: none of the remaining rows can be decrypted",
        );
      }

      const remaining = await deps.runUnitOfWork((ctx) => {
        for (const rewrite of rewrites) {
          updateMatchedRow(
            sql,
            `UPDATE credential_mappings
               SET encrypted_canonical = ?, encryption_generation = ?, encryption_nonce = ?, updated_at = ?
             WHERE kind = ? AND hmac = ? AND encryption_generation = ?`,
            rewrite.ciphertext,
            active.generation,
            rewrite.nonce,
            now,
            rewrite.row.kind,
            rewrite.row.hmac,
            rewrite.row.encryption_generation,
          );
        }
        if (rewrites.length > 0) {
          ctx.rotationCheckpointStore.delete(
            "encryption",
            bucket.bucketIndex,
            active.generation,
          );
        }
        const left = sql
          .exec<{ n: number }>(
            "SELECT count(*) AS n FROM credential_mappings WHERE encryption_generation != ?",
            active.generation,
          )
          .one().n;
        ctx.rotationCheckpointStore.replace({
          rotationKind: "encryption",
          bucketIndex: bucket.bucketIndex,
          generation: previous.generation,
          previousCount: left,
          scannedAt: now,
          conflictCount: 0,
          lastConflictAt: null,
          lastConflictCredentialId: null,
        });
        return left;
      });
      if (remaining === 0) return { kind: "finished" };
    }
    return { kind: "yield", nextRunAt: new Date(now) };
  };
}

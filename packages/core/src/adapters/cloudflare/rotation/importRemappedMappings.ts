import {
  SystemError,
  SystemErrorCode,
  ValidationError,
} from "@repo/core/application/errors";
import type {
  IdentityDirectoryUnitOfWorkContext,
  UnitOfWorkRunner,
} from "@repo/core/application/execution/unitOfWork";
import {
  type ImportOutcome,
  judgeCanonicalRow,
  type MappingRowDto,
} from "@repo/core/application/identity/rotation/transfer";
import type { Logger } from "@repo/core/application/ports/logger";
import { openCanonical } from "../crypto/canonicalCipher";
import {
  activeKey,
  type EncryptionKeyring,
  type KeyCommitment,
  type MappingKeyEntry,
  verifyKeyEntryAgainstCommitment,
} from "../crypto/keyring";
import { deriveLocator } from "../crypto/locatorDerivation";
import { failureLabel } from "../rowRunner";
import {
  IMPORT_ROWS_PER_CALL,
  insertMappingRowIfAbsent,
  overwriteMappingRowIfUnchanged,
  readMappingRowByKey,
} from "./mappingRows";

export type ImportRemappedMappingsInput = Readonly<{
  active: MappingKeyEntry;
  rows: readonly MappingRowDto[];
}>;

export type ImportDeps = Readonly<{
  sql: SqlStorage;
  bucket: Readonly<{ generation: number; bucketIndex: number }>;
  encryptionKeyring: EncryptionKeyring;
  commitment: KeyCommitment | null;
  runUnitOfWork: UnitOfWorkRunner<IdentityDirectoryUnitOfWorkContext>;
  logger: Logger;
}>;

function refuse(message: string): never {
  throw new SystemError(SystemErrorCode.ConfigurationError, message);
}

/**
 * `import-remapped-mappings` — the destination bucket's acceptance of
 * transferred rows (`spec/rotation/index.md`, RPC エントリの全数).
 *
 * Entry-level guards, each one `SystemError` in the envelope: (i) the
 * injected active entry matches this bucket's commitment; (ii) this
 * bucket **is** the active generation. Per-row, and never an error:
 * (iii) the **self-check** — the row's canonical decrypts under this
 * bucket's key (AAD included) and re-HMACs under the injected active key
 * to the row's own `hmac` and to this bucket's index; (iv) the row's
 * encryption generation is the active one. A row failing either answers
 * `rejected` and the others go on. The self-check is the authority that
 * does not depend on reach control: whoever lacks the encryption key or
 * a key that passes the commitment cannot build a row that passes it.
 *
 * A row that passes is judged against what the bucket holds — the five
 * verdicts of `judgeCanonicalRow` — and written under predicate 1 where
 * a write is due; a CAS miss on (c) / (d) collapses to (b). (v) The
 * write's transaction also deletes the retirement checkpoints of the two
 * generations the row belongs to.
 *
 * The decrypt and the HMAC are asynchronous and happen before the
 * transaction; the judgement is re-read inside it.
 */
export async function importRemappedMappings(
  deps: ImportDeps,
  input: ImportRemappedMappingsInput,
): Promise<ImportOutcome[]> {
  if (deps.commitment === null) {
    refuse("This Identity Directory holds no key commitment");
  }
  await verifyKeyEntryAgainstCommitment(
    input.active,
    deps.commitment,
    "active",
  );
  if (deps.bucket.generation !== input.active.generation) {
    refuse("This bucket is not the active mapping-key generation");
  }
  if (input.rows.length > IMPORT_ROWS_PER_CALL) {
    throw new ValidationError(
      "TOO_MANY_ROWS",
      `import-remapped-mappings takes at most ${IMPORT_ROWS_PER_CALL} rows per call`,
    );
  }
  const activeEncryptionGeneration = activeKey(
    deps.encryptionKeyring,
  ).generation;

  const outcomes: ImportOutcome[] = [];
  for (const row of input.rows) {
    outcomes.push(
      await importOne(deps, input.active, row, activeEncryptionGeneration),
    );
  }
  return outcomes;
}

async function importOne(
  deps: ImportDeps,
  active: MappingKeyEntry,
  row: MappingRowDto,
  activeEncryptionGeneration: number,
): Promise<ImportOutcome> {
  if (row.encryptionGeneration !== activeEncryptionGeneration)
    return "rejected";
  const canonical = await openCanonical(
    deps.encryptionKeyring,
    { kind: row.kind, credentialId: row.credentialId },
    {
      ciphertext: row.encryptedCanonical,
      encryptionGeneration: row.encryptionGeneration,
      nonce: row.encryptionNonce,
    },
  );
  if (canonical === null) return "rejected";
  const derived = await deriveLocator(active, row.kind, canonical);
  if (
    derived.hmac !== row.hmac ||
    derived.bucketIndex !== deps.bucket.bucketIndex ||
    row.generation !== active.generation
  ) {
    return "rejected";
  }

  try {
    return await deps.runUnitOfWork((ctx) => {
      const sql = deps.sql;
      // Two passes at most: a conditional insert that misses means a row
      // appeared since the judgement, and the second pass judges it.
      for (let pass = 0; pass < 2; pass += 1) {
        const existing = readMappingRowByKey(sql, row.kind, row.hmac);
        const verdict = judgeCanonicalRow(existing, row);
        let landed = false;
        if (verdict === "a") {
          landed = insertMappingRowIfAbsent(sql, row);
          if (!landed) continue;
        } else if (verdict === "c" || verdict === "d") {
          landed = overwriteMappingRowIfUnchanged(
            sql,
            row,
            existing?.credentialVersion ?? row.credentialVersion,
          );
          if (!landed) return "b";
        }
        if (landed) {
          ctx.rotationCheckpointStore.delete(
            "remap",
            deps.bucket.bucketIndex,
            active.generation,
          );
          ctx.rotationCheckpointStore.delete(
            "encryption",
            deps.bucket.bucketIndex,
            row.encryptionGeneration,
          );
        }
        return verdict;
      }
      return "rejected";
    });
  } catch (error) {
    // Per-row tolerance: a row that cannot be written is left to the next
    // chunk (`spec/rotation/index.md`, 行単位の失敗). The log names the
    // credential id, which is not secret, and never the row.
    deps.logger.warn("import-remapped-mappings: row not accepted", {
      credentialId: row.credentialId,
      cause: failureLabel(error, "import failed"),
    });
    return "rejected";
  }
}

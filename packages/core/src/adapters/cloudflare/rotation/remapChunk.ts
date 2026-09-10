import { SystemError, SystemErrorCode } from "@repo/core/application/errors";
import type {
  IdentityDirectoryUnitOfWorkContext,
  UnitOfWorkRunner,
} from "@repo/core/application/execution/unitOfWork";
import {
  credentialLabelOf,
  usableForLoginOf,
} from "@repo/core/application/identity/credentialLabel";
import type { RecordRemappedLocatorResult } from "@repo/core/application/identity/rotation/recordRemappedLocator";
import {
  authenticationStateUnchanged,
  type ImportOutcome,
  type MappingRowDto,
  type RemapChunkResult,
} from "@repo/core/application/identity/rotation/transfer";
import type { Logger } from "@repo/core/application/ports/logger";
import { openCanonical } from "../crypto/canonicalCipher";
import {
  activeKey,
  type EncryptionKeyring,
  type KeyCommitment,
  type MappingKeyEntry,
  previousKey,
  verifyKeyEntryAgainstCommitment,
} from "../crypto/keyring";
import { deriveLocator, encodeMapping } from "../crypto/locatorDerivation";
import { failureLabel } from "../rowRunner";
import {
  countMappingRows,
  deleteSourceRowIfUnchanged,
  readMappingRowByKey,
  selectMappingRowsAfter,
} from "./mappingRows";

export type RemapChunkInput = Readonly<{
  active: MappingKeyEntry;
  previous: MappingKeyEntry;
  /** Rows scanned per call — the ceiling is on rows read, not rows moved. */
  limit: number;
  /** Exclusive; the previous answer's `lastCredentialId`, or `null` to start from the top. */
  afterCredentialId: string | null;
}>;

export type RemapChunkDeps = Readonly<{
  storage: DurableObjectStorage;
  bucket: Readonly<{ generation: number; bucketIndex: number }>;
  encryptionKeyring: EncryptionKeyring;
  commitment: KeyCommitment | null;
  runUnitOfWork: UnitOfWorkRunner<IdentityDirectoryUnitOfWorkContext>;
  /** s3: the account's reverse-index write, over RPC to its User Data DO. */
  recordRemappedLocator: (
    userId: string,
    input: {
      callerToken: string;
      locator: {
        credentialId: string;
        kind: "email" | "sso";
        mapping: string;
        credentialVersion: number;
        usableForLogin: boolean;
        label: string;
      };
    },
  ) => Promise<RecordRemappedLocatorResult>;
  /** s4: the destination bucket's import, over RPC. */
  importRow: (
    destination: { generation: number; bucketIndex: number },
    active: MappingKeyEntry,
    row: MappingRowDto,
  ) => Promise<ImportOutcome>;
  now: () => number;
  logger: Logger;
}>;

function refuse(message: string): never {
  throw new SystemError(SystemErrorCode.ConfigurationError, message);
}

/**
 * `remap-chunk` — one chunk of a mapping-key transfer, driven from the
 * source bucket (`spec/rotation/index.md`, 1クレデンシャルの移送).
 *
 * The entry-level guards, each a `SystemError` in the envelope: (i) both
 * injected entries match this bucket's commitment; (ii) this bucket is the
 * committed `previous` generation — only the generation being retired may
 * be a source; (iii) the serialisation guard — no `previous` in the
 * encryption keyring, no row whose encryption generation is not the
 * active one, no `rotate-encryption` row that is not `done`.
 *
 * Then, per scanned row and in this order: s1 pass over anything that is
 * not an `active` row with no change in flight; s2 decrypt and re-HMAC
 * under the injected active key, outside any transaction; s3 record the
 * new-generation reverse-index row at the account **before** any copy
 * exists, and stop on `skipped`; s4 re-read the row, pass over a changed
 * authentication state, and hand the copy to the destination; s5 delete
 * the source under predicate 2, tokens with it; s6, once per chunk, the
 * checkpoint snapshot. A row whose RPC failed is left for the next chunk.
 *
 * The scan advances from `afterCredentialId` and the answer carries the
 * last id scanned, so a caller that keeps passing it back reaches the
 * rows behind any wall of pass-overs; a caller that loses it starts from
 * the top and converges anyway.
 */
export async function runRemapChunk(
  deps: RemapChunkDeps,
  input: RemapChunkInput,
): Promise<RemapChunkResult> {
  if (deps.commitment === null) {
    refuse("This Identity Directory holds no key commitment");
  }
  await verifyKeyEntryAgainstCommitment(
    input.active,
    deps.commitment,
    "active",
  );
  await verifyKeyEntryAgainstCommitment(
    input.previous,
    deps.commitment,
    "previous",
  );
  if (deps.bucket.generation !== input.previous.generation) {
    refuse("This bucket is not the mapping-key generation being retired");
  }
  const sql = deps.storage.sql;
  const activeEncryption = activeKey(deps.encryptionKeyring);
  if (previousKey(deps.encryptionKeyring) !== null) {
    refuse(
      "An encryption-key rotation is open: the keyring holds a previous entry",
    );
  }
  if (
    sql
      .exec<{ n: number }>(
        "SELECT count(*) AS n FROM credential_mappings WHERE encryption_generation != ?",
        activeEncryption.generation,
      )
      .one().n > 0
  ) {
    refuse(
      "An encryption-key rotation is open: rows remain under a retired encryption generation",
    );
  }
  if (
    sql
      .exec<{ n: number }>(
        "SELECT count(*) AS n FROM jobs WHERE kind = 'rotate-encryption' AND status != 'done'",
      )
      .one().n > 0
  ) {
    refuse("An encryption-key rotation is open: its job has not finished");
  }

  const limit = Math.max(1, Math.floor(input.limit));
  const rows = selectMappingRowsAfter(sql, input.afterCredentialId, limit);
  let processed = 0;
  let skipped = 0;
  let conflicts = 0;
  let lastConflictAt: number | null = null;
  let lastConflictCredentialId: string | null = null;

  for (const row of rows) {
    try {
      const outcome = await transferOne(deps, input.active, row);
      if (outcome === "processed") processed += 1;
      else if (outcome === "conflict") {
        conflicts += 1;
        lastConflictAt = deps.now();
        lastConflictCredentialId = row.credentialId;
      } else skipped += 1;
    } catch (error) {
      skipped += 1;
      deps.logger.warn("remap-chunk: row left for the next chunk", {
        credentialId: row.credentialId,
        cause: failureLabel(error, "transfer failed"),
      });
    }
  }

  // s6: the snapshot. `previousCount` is whatever remains, pass-overs
  // included; the conflict columns are this chunk's re-detections.
  const remaining = countMappingRows(sql);
  const scannedAt = deps.now();
  await deps.runUnitOfWork((ctx) => {
    ctx.rotationCheckpointStore.replace({
      rotationKind: "remap",
      bucketIndex: deps.bucket.bucketIndex,
      generation: deps.bucket.generation,
      previousCount: remaining,
      scannedAt,
      conflictCount: conflicts,
      lastConflictAt,
      lastConflictCredentialId,
    });
    return undefined;
  });

  const last = rows[rows.length - 1];
  return {
    processed,
    skipped,
    remaining,
    conflicts,
    lastCredentialId: rows.length < limit || !last ? null : last.credentialId,
  };
}

type RowOutcome = "processed" | "skipped" | "conflict";

async function transferOne(
  deps: RemapChunkDeps,
  active: MappingKeyEntry,
  row: MappingRowDto,
): Promise<RowOutcome> {
  // s1
  if (row.status !== "active" || row.changeState !== null) return "skipped";
  if (row.userId === null) return "skipped";

  // s2
  const canonical = await openCanonical(
    deps.encryptionKeyring,
    { kind: row.kind, credentialId: row.credentialId },
    {
      ciphertext: row.encryptedCanonical,
      encryptionGeneration: row.encryptionGeneration,
      nonce: row.encryptionNonce,
    },
  );
  if (canonical === null) return "skipped";
  const target = await deriveLocator(active, row.kind, canonical);

  // s3
  const recorded = await deps.recordRemappedLocator(row.userId, {
    callerToken: row.callerToken,
    locator: {
      credentialId: row.credentialId,
      kind: row.kind,
      mapping: encodeMapping(target),
      credentialVersion: row.credentialVersion,
      usableForLogin: usableForLoginOf(row.kind, row.passwordVerifier),
      label: credentialLabelOf(row.kind, canonical),
    },
  });
  if (recorded !== "recorded") return "skipped";

  // s4
  const reread = readMappingRowByKey(deps.storage.sql, row.kind, row.hmac);
  if (!authenticationStateUnchanged(row, reread) || reread === null) {
    return "skipped";
  }
  const copy: MappingRowDto = {
    ...reread,
    hmac: target.hmac,
    generation: active.generation,
  };
  const verdict = await deps.importRow(
    { generation: active.generation, bucketIndex: target.bucketIndex },
    active,
    copy,
  );
  if (verdict === "e") return "conflict";
  if (verdict === "rejected") return "skipped";

  // s5
  const deleted = deps.storage.transactionSync(() =>
    deleteSourceRowIfUnchanged(deps.storage.sql, reread),
  );
  return deleted ? "processed" : "skipped";
}

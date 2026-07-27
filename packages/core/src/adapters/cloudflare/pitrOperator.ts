import { type AccountAuthority, assertRestoreAuthority } from "./pitrPolicy";

export type UserDataPitrTarget = Readonly<{
  kind: "user-data";
  accountId: string;
}>;

export type IdentityDirectoryPitrTarget = Readonly<{
  kind: "identity-directory";
  generation: string;
  bucket: number;
}>;

export type PitrTarget = UserDataPitrTarget | IdentityDirectoryPitrTarget;

export type CanonicalUserDataTarget = Readonly<{
  kind: "user-data";
  accountId: string;
  objectName: string;
}>;

export type CanonicalPitrTarget =
  | CanonicalUserDataTarget
  | IdentityDirectoryPitrTarget;

export type DirectoryReconciliation = Readonly<{
  complete: boolean;
  scanned: number;
  tombstoned: number;
  conflicts: number;
  cursor: string | null;
}>;

export type PitrRestoreProof = Readonly<{
  id: string;
  previousSessionId: string;
  undoBookmark: string;
}>;

export type PitrReceipt = Readonly<{
  version: 2;
  target: CanonicalPitrTarget;
  restoreBookmark: string;
  undoBookmark: string;
  proof: PitrRestoreProof;
  authority?: AccountAuthority;
  reconcileCursor?: string | null;
  reconciliationTotals?: Readonly<{
    scanned: number;
    tombstoned: number;
    conflictsObserved: number;
  }>;
}>;

export type PitrObject = Readonly<{
  getCurrentBookmark(): Promise<string>;
  prepareRestoreProof(proofId: string): Promise<{ sessionId: string }>;
  scheduleRestore(bookmark: string): Promise<string>;
  restartSession(): Promise<void>;
  verifyRestoredSession(
    bookmark: string,
    proof: PitrRestoreProof,
  ): Promise<string>;
  reconcileDirectoryAuthority?(
    cursor?: string,
  ): Promise<DirectoryReconciliation>;
}>;

export type PitrOperatorDependencies = Readonly<{
  resolveUserData(accountId: string): Promise<
    Readonly<{
      objectName: string;
      authority: AccountAuthority;
      object: PitrObject;
    }>
  >;
  resolveDirectory(target: IdentityDirectoryPitrTarget): PitrObject;
}>;

async function resolveTarget(
  target: PitrTarget,
  dependencies: PitrOperatorDependencies,
): Promise<
  Readonly<{
    target: CanonicalPitrTarget;
    object: PitrObject;
    authority?: AccountAuthority;
  }>
> {
  if (target.kind === "identity-directory") {
    return { target, object: dependencies.resolveDirectory(target) };
  }
  const resolved = await dependencies.resolveUserData(target.accountId);
  assertRestoreAuthority(resolved.authority, resolved.authority);
  return {
    target: {
      kind: "user-data",
      accountId: target.accountId,
      objectName: resolved.objectName,
    },
    object: resolved.object,
    authority: resolved.authority,
  };
}

async function resolveReceiptTarget(
  receipt: PitrReceipt,
  dependencies: PitrOperatorDependencies,
): Promise<
  Readonly<{
    object: PitrObject;
    authority?: AccountAuthority;
  }>
> {
  if (receipt.target.kind === "identity-directory") {
    return { object: dependencies.resolveDirectory(receipt.target) };
  }
  const resolved = await dependencies.resolveUserData(receipt.target.accountId);
  if (resolved.objectName !== receipt.target.objectName) {
    throw new Error("USER_DATA_TARGET_AUTHORITY_CHANGED");
  }
  if (receipt.authority === undefined) {
    throw new Error("PITR_AUTHORITY_RECEIPT_REQUIRED");
  }
  assertRestoreAuthority(receipt.authority, resolved.authority);
  return { object: resolved.object, authority: resolved.authority };
}

export async function readPitrBookmark(
  target: PitrTarget,
  dependencies: PitrOperatorDependencies,
): Promise<string> {
  const resolved = await resolveTarget(target, dependencies);
  return resolved.object.getCurrentBookmark();
}

export async function schedulePitrRestore(
  target: PitrTarget,
  bookmark: string,
  dependencies: PitrOperatorDependencies,
): Promise<PitrReceipt> {
  const resolved = await resolveTarget(target, dependencies);
  const proofId = crypto.randomUUID();
  const prepared = await resolved.object.prepareRestoreProof(proofId);
  const undoBookmark = await resolved.object.scheduleRestore(bookmark);
  return {
    version: 2,
    target: resolved.target,
    restoreBookmark: bookmark,
    undoBookmark,
    proof: {
      id: proofId,
      previousSessionId: prepared.sessionId,
      undoBookmark,
    },
    ...(resolved.authority === undefined
      ? {
          reconcileCursor: null,
          reconciliationTotals: {
            scanned: 0,
            tombstoned: 0,
            conflictsObserved: 0,
          },
        }
      : { authority: resolved.authority }),
  };
}

export async function restartPitrTarget(
  receipt: PitrReceipt,
  dependencies: PitrOperatorDependencies,
): Promise<void> {
  const resolved = await resolveReceiptTarget(receipt, dependencies);
  await resolved.object.restartSession();
  throw new Error("PITR_RESTART_DID_NOT_ABORT");
}

export function isExpectedPitrRestartError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  if (error.message === "PITR_RESTART_REQUESTED") return true;
  return (
    error.message.includes("Durable Object") &&
    error.message.includes("abort") &&
    error.message.endsWith("PITR_RESTART_REQUESTED")
  );
}

export async function verifyPitrRestore(
  receipt: PitrReceipt,
  dependencies: PitrOperatorDependencies,
): Promise<
  Readonly<{
    currentBookmark: string;
    reconciliation?: DirectoryReconciliation;
    receipt?: PitrReceipt;
  }>
> {
  const resolved = await resolveReceiptTarget(receipt, dependencies);
  const currentBookmark = await resolved.object.verifyRestoredSession(
    receipt.restoreBookmark,
    receipt.proof,
  );
  if (receipt.target.kind === "identity-directory") {
    const reconcile = resolved.object.reconcileDirectoryAuthority;
    if (reconcile === undefined) {
      throw new Error("DIRECTORY_RECONCILIATION_UNAVAILABLE");
    }
    const reconciliation = await reconcile(
      receipt.reconcileCursor ?? undefined,
    );
    const previous = receipt.reconciliationTotals ?? {
      scanned: 0,
      tombstoned: 0,
      conflictsObserved: 0,
    };
    const totals = {
      scanned: previous.scanned + reconciliation.scanned,
      tombstoned: previous.tombstoned + reconciliation.tombstoned,
      conflictsObserved: previous.conflictsObserved + reconciliation.conflicts,
    };
    const retryCursor =
      reconciliation.conflicts > 0
        ? (receipt.reconcileCursor ?? null)
        : reconciliation.cursor;
    const effectiveReconciliation = {
      ...reconciliation,
      complete: reconciliation.complete && reconciliation.conflicts === 0,
      cursor: retryCursor,
    };
    return {
      currentBookmark,
      reconciliation: effectiveReconciliation,
      receipt: {
        ...receipt,
        reconcileCursor: retryCursor,
        reconciliationTotals: totals,
      },
    };
  }
  return { currentBookmark };
}

export async function schedulePitrUndo(
  receipt: PitrReceipt,
  dependencies: PitrOperatorDependencies,
): Promise<PitrReceipt> {
  return schedulePitrRestore(
    receipt.target,
    receipt.undoBookmark,
    dependencies,
  );
}

import { type AccountAuthority, assertRestoreAuthority } from "./pitrPolicy";

export type UserDataPitrTarget = Readonly<{
  kind: "user-data";
  accountId: string;
}>;

export type IdentityDirectoryPitrTarget = Readonly<{
  kind: "identity-directory";
  shard: string;
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

export type PitrReceipt = Readonly<{
  version: 1;
  target: CanonicalPitrTarget;
  restoreBookmark: string;
  undoBookmark: string;
  authority?: AccountAuthority;
  reconcileCursor?: string | null;
}>;

export type PitrObject = Readonly<{
  getCurrentBookmark(): Promise<string>;
  scheduleRestore(bookmark: string): Promise<string>;
  restartSession(): Promise<void>;
  verifyRestoredSession(bookmark: string): Promise<string>;
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
  resolveDirectory(shard: string): PitrObject;
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
    return { target, object: dependencies.resolveDirectory(target.shard) };
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
    return { object: dependencies.resolveDirectory(receipt.target.shard) };
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
  const undoBookmark = await resolved.object.scheduleRestore(bookmark);
  return {
    version: 1,
    target: resolved.target,
    restoreBookmark: bookmark,
    undoBookmark,
    ...(resolved.authority === undefined
      ? { reconcileCursor: null }
      : { authority: resolved.authority }),
  };
}

export async function restartPitrTarget(
  receipt: PitrReceipt,
  dependencies: PitrOperatorDependencies,
): Promise<void> {
  const resolved = await resolveReceiptTarget(receipt, dependencies);
  await resolved.object.restartSession();
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
  );
  if (receipt.target.kind === "identity-directory") {
    const reconcile = resolved.object.reconcileDirectoryAuthority;
    if (reconcile === undefined) {
      throw new Error("DIRECTORY_RECONCILIATION_UNAVAILABLE");
    }
    const reconciliation = await reconcile(
      receipt.reconcileCursor ?? undefined,
    );
    return {
      currentBookmark,
      reconciliation,
      receipt: {
        ...receipt,
        reconcileCursor: reconciliation.cursor,
      },
    };
  }
  return { currentBookmark };
}

export async function schedulePitrUndo(
  receipt: PitrReceipt,
  dependencies: PitrOperatorDependencies,
): Promise<PitrReceipt> {
  const resolved = await resolveReceiptTarget(receipt, dependencies);
  const redoBookmark = await resolved.object.scheduleRestore(
    receipt.undoBookmark,
  );
  return {
    ...receipt,
    restoreBookmark: receipt.undoBookmark,
    undoBookmark: redoBookmark,
    ...(receipt.target.kind === "identity-directory"
      ? { reconcileCursor: null }
      : {}),
  };
}

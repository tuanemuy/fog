import {
  type AccountAuthority,
  assertRestorableClass,
  assertRestoreAuthority,
  type RestorableDurableObjectClass,
} from "./pitrPolicy";

export type PitrTarget = Readonly<{
  className: string;
  objectName: string;
  accountId: string;
}>;

export type PitrObject = Readonly<{
  getCurrentBookmark(): Promise<string>;
  scheduleRestore(bookmark: string): Promise<string>;
}>;

export type PitrOperatorDependencies = Readonly<{
  readAccountAuthority(accountId: string): Promise<AccountAuthority>;
  resolveTarget(
    className: RestorableDurableObjectClass,
    objectName: string,
  ): PitrObject;
}>;

export async function readPitrBookmark(
  target: PitrTarget,
  dependencies: PitrOperatorDependencies,
): Promise<string> {
  assertRestorableClass(target.className);
  const authority = await dependencies.readAccountAuthority(target.accountId);
  assertRestoreAuthority(authority, authority);
  return dependencies
    .resolveTarget(target.className, target.objectName)
    .getCurrentBookmark();
}

export async function schedulePitrRestore(
  target: PitrTarget & Readonly<{ bookmark: string }>,
  dependencies: PitrOperatorDependencies,
): Promise<Readonly<{ undoBookmark: string }>> {
  assertRestorableClass(target.className);
  const before = await dependencies.readAccountAuthority(target.accountId);
  assertRestoreAuthority(before, before);
  const undoBookmark = await dependencies
    .resolveTarget(target.className, target.objectName)
    .scheduleRestore(target.bookmark);
  const after = await dependencies.readAccountAuthority(target.accountId);
  assertRestoreAuthority(before, after);
  return { undoBookmark };
}

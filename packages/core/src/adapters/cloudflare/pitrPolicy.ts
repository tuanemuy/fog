export type RestorableDurableObjectClass =
  | "UserDataDurableObject"
  | "IdentityDirectoryDurableObject";

export type AccountAuthority = Readonly<{
  status: "pending" | "active" | "deleting" | "deleted";
  epoch: number;
}>;

export function assertRestorableClass(
  className: string,
): asserts className is RestorableDurableObjectClass {
  if (className === "AccountHomeDurableObject") {
    throw new Error("ACCOUNT_HOME_RESTORE_FORBIDDEN");
  }
  if (
    className !== "UserDataDurableObject" &&
    className !== "IdentityDirectoryDurableObject"
  ) {
    throw new Error("UNKNOWN_DURABLE_OBJECT_CLASS");
  }
}

export function assertRestoreAuthority(
  before: AccountAuthority,
  after: AccountAuthority,
): void {
  if (
    before.status !== "active" ||
    after.status !== "active" ||
    before.epoch !== after.epoch
  ) {
    throw new Error("ACCOUNT_AUTHORITY_CHANGED_DURING_RESTORE");
  }
}

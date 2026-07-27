import { describe, expect, it } from "vitest";
import { assertRestorableClass, assertRestoreAuthority } from "../pitrPolicy";

describe("PITR operator policy", () => {
  it("refuses Account Home restores", () => {
    expect(() => assertRestorableClass("AccountHomeDurableObject")).toThrow(
      "ACCOUNT_HOME_RESTORE_FORBIDDEN",
    );
  });

  it("requires the current Account Home epoch before and after restore", () => {
    expect(() =>
      assertRestoreAuthority(
        { status: "active", epoch: 2 },
        { status: "deleting", epoch: 3 },
      ),
    ).toThrow("ACCOUNT_AUTHORITY_CHANGED_DURING_RESTORE");
    expect(() =>
      assertRestoreAuthority(
        { status: "active", epoch: 2 },
        { status: "active", epoch: 2 },
      ),
    ).not.toThrow();
  });
});

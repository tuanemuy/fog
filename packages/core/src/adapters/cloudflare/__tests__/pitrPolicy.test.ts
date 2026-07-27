import { describe, expect, it } from "vitest";
import {
  readPitrBookmark,
  restartPitrTarget,
  schedulePitrRestore,
  schedulePitrUndo,
  type DirectoryReconciliation,
  type PitrObject,
  verifyPitrRestore,
} from "../pitrOperator";
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

describe("PITR operator workflow", () => {
  function object(
    sequence: string[],
    reconciliation: DirectoryReconciliation = {
      complete: true,
      scanned: 3,
      tombstoned: 1,
      conflicts: 0,
      cursor: null,
    },
  ): PitrObject {
    return {
      async getCurrentBookmark() {
        sequence.push("bookmark");
        return "current";
      },
      async scheduleRestore(bookmark) {
        sequence.push(`schedule:${bookmark}`);
        return "undo";
      },
      async restartSession() {
        sequence.push("restart");
      },
      async verifyRestoredSession(bookmark) {
        sequence.push(`verify:${bookmark}`);
        return "restored-current";
      },
      async reconcileDirectoryAuthority() {
        sequence.push("reconcile-directory");
        return reconciliation;
      },
    };
  }

  it("derives User Data object identity from Account Home and verifies after restart", async () => {
    const sequence: string[] = [];
    const targetObject = object(sequence);
    const dependencies = {
      async resolveUserData(accountId: string) {
        sequence.push(`authority:${accountId}`);
        return {
          objectName: "canonical-user-data",
          authority: { status: "active" as const, epoch: 4 },
          object: targetObject,
        };
      },
      resolveDirectory() {
        throw new Error("not used");
      },
    };
    await expect(
      readPitrBookmark(
        { kind: "user-data", accountId: "account" },
        dependencies,
      ),
    ).resolves.toBe("current");
    const receipt = await schedulePitrRestore(
      { kind: "user-data", accountId: "account" },
      "old",
      dependencies,
    );
    expect(receipt.target).toEqual({
      kind: "user-data",
      accountId: "account",
      objectName: "canonical-user-data",
    });
    await restartPitrTarget(receipt, dependencies);
    await expect(verifyPitrRestore(receipt, dependencies)).resolves.toEqual({
      currentBookmark: "restored-current",
    });
    expect(sequence).toEqual([
      "authority:account",
      "bookmark",
      "authority:account",
      "schedule:old",
      "authority:account",
      "restart",
      "authority:account",
      "verify:old",
    ]);
  });

  it("fails closed when canonical User Data ownership changes", async () => {
    const targetObject = object([]);
    const names = ["canonical-user-data", "different-user-data"];
    const dependencies = {
      async resolveUserData() {
        return {
          objectName: names.shift() ?? "different-user-data",
          authority: { status: "active" as const, epoch: 1 },
          object: targetObject,
        };
      },
      resolveDirectory() {
        return targetObject;
      },
    };
    const receipt = await schedulePitrRestore(
      { kind: "user-data", accountId: "account" },
      "old",
      dependencies,
    );
    await expect(verifyPitrRestore(receipt, dependencies)).rejects.toThrow(
      "USER_DATA_TARGET_AUTHORITY_CHANGED",
    );
  });

  it("reconciles every restored Directory shard before reporting verification", async () => {
    const sequence: string[] = [];
    const targetObject = object(sequence);
    const dependencies = {
      async resolveUserData() {
        throw new Error("not used");
      },
      resolveDirectory(shard: string) {
        sequence.push(`directory:${shard}`);
        return targetObject;
      },
    };
    const receipt = await schedulePitrRestore(
      { kind: "identity-directory", shard: "generation-1:bucket-7" },
      "old",
      dependencies,
    );
    await restartPitrTarget(receipt, dependencies);
    const verified = await verifyPitrRestore(receipt, dependencies);
    expect(verified.reconciliation).toMatchObject({
      complete: true,
      scanned: 3,
      tombstoned: 1,
      cursor: null,
    });
    const undo = await schedulePitrUndo(receipt, dependencies);
    expect(undo.restoreBookmark).toBe("undo");
    expect(sequence).toContain("reconcile-directory");
    expect(sequence.at(-1)).toBe("schedule:undo");
  });

  it("returns an incomplete Directory cursor in the resumable receipt", async () => {
    const targetObject = object([], {
      complete: false,
      scanned: 100,
      tombstoned: 0,
      conflicts: 0,
      cursor: "opaque-next",
    });
    const dependencies = {
      async resolveUserData() {
        throw new Error("not used");
      },
      resolveDirectory() {
        return targetObject;
      },
    };
    const receipt = await schedulePitrRestore(
      { kind: "identity-directory", shard: "generation-1:bucket-7" },
      "old",
      dependencies,
    );
    await expect(
      verifyPitrRestore(receipt, dependencies),
    ).resolves.toMatchObject({
      reconciliation: { complete: false, cursor: "opaque-next" },
      receipt: { reconcileCursor: "opaque-next" },
    });
  });
});

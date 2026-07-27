import { describe, expect, it } from "vitest";
import { assertRestorableClass, assertRestoreAuthority } from "../pitrPolicy";
import { readPitrBookmark, schedulePitrRestore } from "../pitrOperator";

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
  it("rejects Account Home before resolving a target or reading authority", async () => {
    let calls = 0;
    const dependencies = {
      async readAccountAuthority() {
        calls += 1;
        return { status: "active" as const, epoch: 1 };
      },
      resolveTarget() {
        calls += 1;
        return {
          async getCurrentBookmark() {
            calls += 1;
            return "bookmark";
          },
          async scheduleRestore() {
            calls += 1;
            return "undo";
          },
        };
      },
    };
    await expect(
      schedulePitrRestore(
        {
          className: "AccountHomeDurableObject",
          objectName: "opaque",
          accountId: "account",
          bookmark: "bookmark",
        },
        dependencies,
      ),
    ).rejects.toThrow("ACCOUNT_HOME_RESTORE_FORBIDDEN");
    expect(calls).toBe(0);
  });

  it("checks authority before and after scheduling restore", async () => {
    const sequence: string[] = [];
    const authorities = [
      { status: "active" as const, epoch: 4 },
      { status: "active" as const, epoch: 4 },
    ];
    await expect(
      schedulePitrRestore(
        {
          className: "UserDataDurableObject",
          objectName: "opaque",
          accountId: "account",
          bookmark: "bookmark",
        },
        {
          async readAccountAuthority() {
            sequence.push("authority");
            const authority = authorities.shift();
            if (authority === undefined) throw new Error("missing authority");
            return authority;
          },
          resolveTarget() {
            sequence.push("resolve");
            return {
              async getCurrentBookmark() {
                return "current";
              },
              async scheduleRestore(bookmark) {
                sequence.push(`restore:${bookmark}`);
                return "undo";
              },
            };
          },
        },
      ),
    ).resolves.toEqual({ undoBookmark: "undo" });
    expect(sequence).toEqual([
      "authority",
      "resolve",
      "restore:bookmark",
      "authority",
    ]);
  });

  it("fails closed when authority changes and supports bookmark reads", async () => {
    const target = {
      className: "IdentityDirectoryDurableObject",
      objectName: "opaque",
      accountId: "account",
    };
    const authorities = [
      { status: "active" as const, epoch: 1 },
      { status: "deleting" as const, epoch: 2 },
    ];
    const dependencies = {
      async readAccountAuthority() {
        const authority = authorities.shift();
        if (authority === undefined)
          return { status: "active" as const, epoch: 1 };
        return authority;
      },
      resolveTarget() {
        return {
          async getCurrentBookmark() {
            return "current";
          },
          async scheduleRestore() {
            return "undo";
          },
        };
      },
    };
    await expect(
      schedulePitrRestore({ ...target, bookmark: "old" }, dependencies),
    ).rejects.toThrow("ACCOUNT_AUTHORITY_CHANGED_DURING_RESTORE");
    await expect(readPitrBookmark(target, dependencies)).resolves.toBe(
      "current",
    );
  });
});

import { describe, expect, it, vi } from "vitest";
import {
  isTrashEmpty,
  isTrashRestoreDisabled,
  partialTrashMessage,
  runTrashPurgeMutation,
} from "./trashMutation";

describe("empty trash client reconciliation", () => {
  it("invalidates after a typed partial success and reports the remaining count", async () => {
    const invalidate = vi.fn(async () => {});
    const result = await runTrashPurgeMutation(
      async () => ({ status: "partial", deletedCount: 3, remainingCount: 2 }),
      invalidate,
    );
    expect(invalidate).toHaveBeenCalledOnce();
    expect(partialTrashMessage(result)).toContain("残り2件");
  });

  it("invalidates even when the server fails after committing progress", async () => {
    const invalidate = vi.fn(async () => {});
    await expect(
      runTrashPurgeMutation(async () => {
        throw new Error("storage failure");
      }, invalidate),
    ).rejects.toThrow("storage failure");
    expect(invalidate).toHaveBeenCalledOnce();
  });

  it("does not present a purging-only backlog as an empty trash", () => {
    expect(isTrashEmpty(0, 1)).toBe(false);
    expect(isTrashEmpty(0, 0)).toBe(true);
  });

  it("keeps restore disabled while either the item or its topic is purging", () => {
    expect(isTrashRestoreDisabled(true, false)).toBe(true);
    expect(isTrashRestoreDisabled(false, true)).toBe(true);
    expect(isTrashRestoreDisabled(false, false)).toBe(false);
  });
});

import { isBusinessRuleError } from "@repo/core/domain/error";
import { describe, expect, it } from "vitest";
import { isValidationError } from "../../errors";
import type { ShowMemoDto } from "../gateway";
import { TIMELINE_DEFAULT_LIMIT } from "../getTimeline";
import { showMemoInTimeline } from "../showMemoInTimeline";
import { EMPTY_WINDOW, memoContainer } from "./memoContainer";

const NOT_FOUND = {
  ...EMPTY_WINDOW,
  targetState: "notFound",
  targetMemoId: "",
} as const;

describe("showMemoInTimeline", () => {
  it("defaults the limit and passes the memo id through", async () => {
    const calls: [string, ShowMemoDto][] = [];
    const container = memoContainer({
      showMemoInTimeline: async (userId, input) => {
        calls.push([userId, input]);
        return { ...NOT_FOUND, targetMemoId: input.memoId };
      },
    });

    await showMemoInTimeline({
      container,
      input: { userId: "user-1", memoId: "memo-1" },
    });
    expect(calls).toEqual([
      ["user-1", { memoId: "memo-1", limit: TIMELINE_DEFAULT_LIMIT }],
    ]);
  });

  it("rejects a limit outside the bounds before reaching the gateway", async () => {
    const container = memoContainer({
      showMemoInTimeline: async () => {
        throw new Error("must not be reached");
      },
    });
    await expect(
      showMemoInTimeline({
        container,
        input: { userId: "user-1", memoId: "memo-1", limit: 101 },
      }),
    ).rejects.toSatisfy(isValidationError);
  });

  it("rejects an empty memo id (the MemoId non-empty rule)", async () => {
    const container = memoContainer({
      showMemoInTimeline: async () => {
        throw new Error("must not be reached");
      },
    });
    await expect(
      showMemoInTimeline({
        container,
        input: { userId: "user-1", memoId: "   " },
      }),
    ).rejects.toSatisfy(isBusinessRuleError);
  });
});

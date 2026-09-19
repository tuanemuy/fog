import {
  NotFoundError,
  SystemError,
  SystemErrorCode,
} from "@repo/core/application/errors";
import { screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { renderWithRouter } from "@/components/__tests__/renderWithRouter";
import { MemoHistoryFeed } from "@/components/memoHistory/MemoHistoryFeed";

const mocks = vi.hoisted(() => ({
  requireUserId: vi.fn<() => Promise<string>>(),
  loadRevisions: vi.fn<(userId: string, memoId: string) => Promise<unknown>>(),
}));

vi.mock("@tanstack/react-start", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@tanstack/react-start")>()),
  useServerFn: (fn: unknown) => fn,
}));

vi.mock("@/components/memoHistory/actions", () => ({
  diffMemoRevisionsFn: vi.fn(),
  rollbackMemoFn: vi.fn(),
}));

vi.mock("@/presentation/currentUser", () => ({
  requireUserId: mocks.requireUserId,
}));

// The guard's redaction and logging are the middleware's tests; here it
// only has to let the failure through as the leaf sees it.
vi.mock("@/presentation/errorResponseMiddleware", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("@/presentation/errorResponseMiddleware")
  >()),
  guardStreamedRender: (load: () => Promise<unknown>) => load(),
}));

vi.mock("@/presentation/serverAction", () => ({
  serverData: () => mocks.loadRevisions,
}));

afterEach(() => {
  vi.clearAllMocks();
});

const USER_ID = "01950000-0000-7000-8000-000000000001";

describe("MemoHistoryFeed", () => {
  it("draws the history of a memo that exists", async () => {
    mocks.requireUserId.mockResolvedValue(USER_ID);
    mocks.loadRevisions.mockResolvedValue({
      memoId: "m1",
      latestRevisionNumber: 1,
      revisions: [
        {
          revisionNumber: 1,
          actor: { kind: "user" },
          createdAt: new Date("2026-07-20T01:00:00Z"),
        },
      ],
    });
    await renderWithRouter(await MemoHistoryFeed({ memoId: "m1" }), {
      path: "/memos/$memoId/history",
    });
    expect(screen.getByRole("list", { name: "履歴" })).toBeTruthy();
    expect(screen.queryByText("メモが見つかりません")).toBeNull();
    expect(mocks.loadRevisions).toHaveBeenCalledWith(USER_ID, "m1");
  });

  it("draws 「メモが見つかりません」 and the way back to the timeline for a notFound", async () => {
    mocks.requireUserId.mockResolvedValue(USER_ID);
    mocks.loadRevisions.mockRejectedValue(
      new NotFoundError("MEMO_NOT_FOUND", "The memo was not found"),
    );
    const { expectInternalHrefsToResolve } = await renderWithRouter(
      await MemoHistoryFeed({ memoId: "missing" }),
      { path: "/memos/$memoId/history" },
    );
    const sentence = screen.getByText("メモが見つかりません");
    expect(sentence.tagName).toBe("P");
    expect(screen.queryByRole("heading")).toBeNull();
    expect(
      screen.getByRole("link", { name: "タイムラインへ" }).getAttribute("href"),
    ).toBe("/");
    expect(expectInternalHrefsToResolve()).toEqual(["/"]);
    expect(screen.queryByRole("list", { name: "履歴" })).toBeNull();
  });

  it("lets any other failure through to the route's error boundary", async () => {
    mocks.requireUserId.mockResolvedValue(USER_ID);
    mocks.loadRevisions.mockRejectedValue(
      new SystemError(SystemErrorCode.DatabaseError, "down"),
    );
    await expect(MemoHistoryFeed({ memoId: "any" })).rejects.toThrow("down");
  });
});

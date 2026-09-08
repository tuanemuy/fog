import type {
  RevisionDiffView,
  RevisionSummaryView,
} from "@repo/core/application/memo/view";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { renderWithRouter } from "@/components/__tests__/renderWithRouter";
import { RevisionHistory } from "@/components/memoHistory/RevisionHistory";
import { AppServerError } from "@/presentation/errorResponse";
import { formatDateTime } from "@/presentation/time";

const mocks = vi.hoisted(() => ({
  diffMemoRevisionsFn:
    vi.fn<
      (input: {
        data: {
          memoId: string;
          baseRevisionNumber: number;
          targetRevisionNumber: number;
        };
      }) => Promise<unknown>
    >(),
  rollbackMemoFn:
    vi.fn<
      (input: {
        data: { memoId: string; targetRevisionNumber: number };
      }) => Promise<unknown>
    >(),
}));

vi.mock("@tanstack/react-start", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@tanstack/react-start")>()),
  useServerFn: (fn: unknown) => fn,
}));

vi.mock("@/components/memoHistory/actions", () => ({
  diffMemoRevisionsFn: mocks.diffMemoRevisionsFn,
  rollbackMemoFn: mocks.rollbackMemoFn,
}));

afterEach(() => {
  vi.clearAllMocks();
});

const AT = [
  new Date("2026-07-20T01:00:00Z"),
  new Date("2026-07-20T02:00:00Z"),
  new Date("2026-07-20T03:00:00Z"),
] as const;

const THREE: RevisionSummaryView[] = [
  { revisionNumber: 1, actor: { kind: "user" }, createdAt: AT[0] },
  {
    revisionNumber: 2,
    actor: { kind: "aiClient", clientName: "Claude" },
    createdAt: AT[1],
  },
  { revisionNumber: 3, actor: { kind: "user" }, createdAt: AT[2] },
];

function revisionView(revisionNumber: number, body: string) {
  return {
    revisionNumber,
    body,
    actor: { kind: "user" } as const,
    createdAt: AT[0],
  };
}

function rows() {
  return within(
    screen.getByRole("list", { name: "リビジョン一覧" }),
  ).getAllByRole("listitem");
}

function row(n: number) {
  return within(rows()[n - 1] as HTMLElement).getByRole("button");
}

function diffLines(kind: "added" | "removed" | "context") {
  return [
    ...document.querySelectorAll(`.fog-diff-line.${kind} .fog-diff-text`),
  ].map((el) => el.textContent);
}

function render(revisions: RevisionSummaryView[]) {
  return renderWithRouter(
    <RevisionHistory memoId="m1" revisions={revisions} />,
    { path: "/memos/$memoId/history" },
  );
}

describe("RevisionHistory with one revision", () => {
  it("shows the row without selection or rollback", async () => {
    await render([THREE[0] as RevisionSummaryView]);
    const items = rows();
    expect(items).toHaveLength(1);
    expect(within(items[0] as HTMLElement).queryByRole("button")).toBeNull();
    expect(document.querySelector("[aria-pressed]")).toBeNull();
    expect(screen.queryByRole("button", { name: "この内容に戻す" })).toBeNull();
    expect(screen.queryByText("比較元のリビジョンを選んでください")).toBeNull();
  });
});

describe("RevisionHistory two-point selection", () => {
  it("lists ascending with who and when", async () => {
    await render(THREE);
    const items = rows();
    expect(items).toHaveLength(3);
    expect(items[0]?.textContent).toContain(formatDateTime(AT[0]));
    expect(items[0]?.textContent).toContain("あなた · リビジョン 1");
    expect(items[1]?.textContent).toContain("Claude · リビジョン 2");
    expect(items[2]?.textContent).toContain("あなた · リビジョン 3");
    expect(screen.getByText("比較元のリビジョンを選んでください")).toBeTruthy();
  });

  it("takes the first click as base, the second as target, and draws the diff", async () => {
    mocks.diffMemoRevisionsFn.mockResolvedValue({
      base: revisionView(1, "a\nold"),
      target: revisionView(3, "a\nnew"),
    } satisfies RevisionDiffView);
    await render(THREE);

    fireEvent.click(row(1));
    expect(row(1).getAttribute("aria-pressed")).toBe("true");
    expect(within(row(1)).getByText("比較元")).toBeTruthy();
    expect(screen.getByRole("button", { name: "この内容に戻す" })).toBeTruthy();
    expect(mocks.diffMemoRevisionsFn).not.toHaveBeenCalled();
    expect(screen.getByText("比較先のリビジョンを選んでください")).toBeTruthy();

    fireEvent.click(row(3));
    expect(within(row(3)).getByText("比較先")).toBeTruthy();
    expect(mocks.diffMemoRevisionsFn).toHaveBeenCalledWith({
      data: { memoId: "m1", baseRevisionNumber: 1, targetRevisionNumber: 3 },
    });
    await waitFor(() => expect(diffLines("removed")).toEqual(["old"]));
    expect(diffLines("added")).toEqual(["new"]);
    expect(diffLines("context")).toEqual(["a"]);
    expect(screen.getByText("リビジョン 1 → リビジョン 3 の差分")).toBeTruthy();

    // Clicking the target again clears it and the diff.
    fireEvent.click(row(3));
    expect(row(3).getAttribute("aria-pressed")).toBe("false");
    expect(screen.queryByRole("region", { name: "差分" })).toBeNull();
    expect(screen.getByRole("button", { name: "この内容に戻す" })).toBeTruthy();

    // Clicking the base clears both.
    fireEvent.click(row(1));
    expect(row(1).getAttribute("aria-pressed")).toBe("false");
    expect(screen.queryByRole("button", { name: "この内容に戻す" })).toBeNull();

    // 2 then 3: the first is the base, the second the target.
    fireEvent.click(row(2));
    fireEvent.click(row(3));
    expect(mocks.diffMemoRevisionsFn).toHaveBeenLastCalledWith({
      data: { memoId: "m1", baseRevisionNumber: 2, targetRevisionNumber: 3 },
    });
    expect(within(row(2)).getByText("比較元")).toBeTruthy();
    expect(within(row(3)).getByText("比較先")).toBeTruthy();
  });

  it("treats a diff of the wrong shape as a system error", async () => {
    mocks.diffMemoRevisionsFn.mockResolvedValue({ status: 500 });
    await render(THREE);
    fireEvent.click(row(1));
    fireEvent.click(row(2));
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toBe("システムエラーが発生しました");
    expect(document.querySelector(".fog-diff-view")).toBeNull();
  });
});

describe("RevisionHistory rollback", () => {
  async function openConfirm() {
    fireEvent.click(row(1));
    fireEvent.click(screen.getByRole("button", { name: "この内容に戻す" }));
    return screen.findByRole("dialog", { name: "この内容に戻しますか？" });
  }

  it("rolls back to the base and returns to the memo's position", async () => {
    mocks.rollbackMemoFn.mockResolvedValue({
      result: "rolledBack",
      memo: { id: "m1" },
    });
    const { router } = await render(THREE);
    const dialog = await openConfirm();
    fireEvent.click(within(dialog).getByRole("button", { name: "戻す" }));
    expect(mocks.rollbackMemoFn).toHaveBeenCalledWith({
      data: { memoId: "m1", targetRevisionNumber: 1 },
    });
    await waitFor(() => expect(router.state.location.pathname).toBe("/"));
    expect(router.state.location.search).toMatchObject({ memo: "m1" });
  });

  it("says so when the content is already the same and stays", async () => {
    mocks.rollbackMemoFn.mockResolvedValue({
      result: "unchanged",
      memo: { id: "m1" },
    });
    const { router } = await render(THREE);
    const before = router.state.location.pathname;
    const dialog = await openConfirm();
    fireEvent.click(within(dialog).getByRole("button", { name: "戻す" }));
    const status = await screen.findByRole("status");
    expect(status.textContent).toBe("現在の内容は既にこのリビジョンと同じです");
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(router.state.location.pathname).toBe(before);
    expect(router.state.location.search).not.toHaveProperty("memo");
  });

  it("reports a rejection", async () => {
    mocks.rollbackMemoFn.mockRejectedValue(
      new AppServerError({
        kind: "notFound",
        code: "MEMO_NOT_FOUND",
        message: "x",
      }),
    );
    await render(THREE);
    const dialog = await openConfirm();
    fireEvent.click(within(dialog).getByRole("button", { name: "戻す" }));
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toBe("対象が見つかりません");
  });

  it("does nothing when the confirmation is cancelled", async () => {
    await render(THREE);
    const dialog = await openConfirm();
    fireEvent.click(within(dialog).getByRole("button", { name: "キャンセル" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(mocks.rollbackMemoFn).not.toHaveBeenCalled();
  });
});

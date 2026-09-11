import type {
  RevisionDiffView,
  RevisionSummaryView,
} from "@repo/core/application/memo/view";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { renderWithRouter } from "@/components/__tests__/renderWithRouter";
import { RevisionHistory } from "@/components/memoHistory/RevisionHistory";
import { ToastProvider, ToastRegion } from "@/components/ui/Toast";
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
const TIME = AT.map(formatDateTime);

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
  return within(screen.getByRole("list", { name: "履歴" })).getAllByRole(
    "listitem",
  );
}

function row(n: number) {
  return within(rows()[n - 1] as HTMLElement).getByRole("button");
}

function diffRegion() {
  return screen.getByRole("region", { name: /の差分$/ });
}

function linesOf(role: "deletion" | "insertion") {
  return within(diffRegion())
    .queryAllByRole(role)
    .map((el) => el.textContent);
}

function render(revisions: RevisionSummaryView[]) {
  return renderWithRouter(
    <ToastProvider>
      <RevisionHistory memoId="m1" revisions={revisions} />
      <ToastRegion />
    </ToastProvider>,
    { path: "/memos/$memoId/history" },
  );
}

// The frame's toast region: the one live region that announces additions
// only (`aria-atomic="false"`), unlike the busy diff box.
function toasts() {
  const region = screen
    .getAllByRole("status")
    .find((el) => el.getAttribute("aria-atomic") === "false");
  if (region === undefined) throw new Error("no toast region");
  return within(region);
}

describe("RevisionHistory with one revision", () => {
  it("shows the row without selection or rollback", async () => {
    await render([THREE[0] as RevisionSummaryView]);
    const items = rows();
    expect(items).toHaveLength(1);
    expect(items[0]?.textContent).toContain(TIME[0]);
    expect(within(items[0] as HTMLElement).queryByRole("button")).toBeNull();
    expect(document.querySelector("[aria-pressed]")).toBeNull();
    expect(screen.queryByRole("button", { name: "この内容に戻す" })).toBeNull();
  });
});

describe("RevisionHistory two-point selection", () => {
  it("lists ascending under 履歴 with when and who, each row a toggle", async () => {
    await render(THREE);
    expect(
      screen.getByRole("heading", { level: 2, name: "履歴" }),
    ).toBeTruthy();
    const items = rows();
    expect(items).toHaveLength(3);
    expect(items.map((item) => item.textContent)).toEqual([
      `${TIME[0]}あなた`,
      `${TIME[1]}Claude`,
      `${TIME[2]}あなた`,
    ]);
    expect(row(1).getAttribute("aria-pressed")).toBe("false");
    expect(screen.queryByRole("button", { name: "この内容に戻す" })).toBeNull();
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
    expect(screen.getByText(`比較元 · ${TIME[0]}`)).toBeTruthy();
    expect(mocks.diffMemoRevisionsFn).not.toHaveBeenCalled();
    expect(screen.queryByRole("region", { name: /の差分$/ })).toBeNull();

    fireEvent.click(row(3));
    expect(within(row(3)).getByText("比較先")).toBeTruthy();
    expect(within(row(2)).queryByText("比較先")).toBeNull();
    expect(mocks.diffMemoRevisionsFn).toHaveBeenCalledWith({
      data: { memoId: "m1", baseRevisionNumber: 1, targetRevisionNumber: 3 },
    });
    await waitFor(() => expect(linesOf("deletion")).toEqual(["old"]));
    expect(linesOf("insertion")).toEqual(["new"]);
    const context = within(diffRegion()).getByText("a");
    expect(context.closest("del, ins")).toBeNull();
    expect(
      screen.getByRole("region", {
        name: `${TIME[0]} → ${TIME[2]} の差分`,
      }),
    ).toBeTruthy();

    // Clicking the target again clears it and the diff.
    fireEvent.click(row(3));
    expect(row(3).getAttribute("aria-pressed")).toBe("false");
    expect(screen.queryByRole("region", { name: /の差分$/ })).toBeNull();
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

  it("lays Sk lines over the diff box while the two versions load", async () => {
    let resolve: (value: unknown) => void = () => {};
    mocks.diffMemoRevisionsFn.mockReturnValue(
      new Promise((r) => {
        resolve = r;
      }),
    );
    await render(THREE);
    fireEvent.click(row(1));
    fireEvent.click(row(2));
    const busy = await within(diffRegion()).findByRole("status");
    expect(busy.getAttribute("aria-busy")).toBe("true");
    expect(busy.textContent).toContain("差分を読み込み中");
    expect(within(diffRegion()).queryByRole("deletion")).toBeNull();

    resolve({
      base: revisionView(1, "old"),
      target: revisionView(2, "new"),
    } satisfies RevisionDiffView);
    await waitFor(() => expect(linesOf("deletion")).toEqual(["old"]));
    expect(within(diffRegion()).queryByRole("status")).toBeNull();
  });

  it("treats a diff of the wrong shape as a system error, and 再試行 fetches again", async () => {
    mocks.diffMemoRevisionsFn.mockResolvedValueOnce({ status: 500 });
    await render(THREE);
    fireEvent.click(row(1));
    fireEvent.click(row(2));
    const alert = await within(diffRegion()).findByRole("alert");
    expect(
      within(alert).getByText("システムエラーが発生しました"),
    ).toBeTruthy();
    expect(within(diffRegion()).queryByRole("deletion")).toBeNull();

    mocks.diffMemoRevisionsFn.mockResolvedValueOnce({
      base: revisionView(1, "old"),
      target: revisionView(2, "new"),
    } satisfies RevisionDiffView);
    fireEvent.click(within(alert).getByRole("button", { name: "再試行" }));
    expect(mocks.diffMemoRevisionsFn).toHaveBeenCalledTimes(2);
    expect(mocks.diffMemoRevisionsFn).toHaveBeenLastCalledWith({
      data: { memoId: "m1", baseRevisionNumber: 1, targetRevisionNumber: 2 },
    });
    await waitFor(() => expect(linesOf("deletion")).toEqual(["old"]));
    expect(within(diffRegion()).queryByRole("alert")).toBeNull();
  });
});

describe("RevisionHistory rollback", () => {
  async function openConfirm() {
    fireEvent.click(row(1));
    fireEvent.click(screen.getByRole("button", { name: "この内容に戻す" }));
    return screen.findByRole("dialog", { name: "この内容に戻しますか？" });
  }

  it("names the base by its time in the confirmation", async () => {
    await render(THREE);
    const dialog = await openConfirm();
    expect(dialog.textContent).toContain(
      `${TIME[0]} の内容で新しいリビジョンを作ります。これまでの履歴は残ります。`,
    );
  });

  it("rolls back to the base, returns to the memo's position and says so in a toast", async () => {
    mocks.rollbackMemoFn.mockResolvedValue({
      result: "rolledBack",
      memo: { id: "m1" },
    });
    const { router } = await render(THREE);
    const dialog = await openConfirm();
    expect(toasts().queryByText(`${TIME[0]} の内容に戻しました`)).toBeNull();
    fireEvent.click(within(dialog).getByRole("button", { name: "戻す" }));
    expect(mocks.rollbackMemoFn).toHaveBeenCalledWith({
      data: { memoId: "m1", targetRevisionNumber: 1 },
    });
    await waitFor(() => expect(router.state.location.pathname).toBe("/"));
    expect(router.state.location.search).toMatchObject({ memo: "m1" });
    expect(
      await toasts().findByText(`${TIME[0]} の内容に戻しました`),
    ).toBeTruthy();
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("says in a toast when the content is already the same, and stays", async () => {
    mocks.rollbackMemoFn.mockResolvedValue({
      result: "unchanged",
      memo: { id: "m1" },
    });
    const { router } = await render(THREE);
    const before = router.state.location.pathname;
    const dialog = await openConfirm();
    fireEvent.click(within(dialog).getByRole("button", { name: "戻す" }));
    expect(
      await toasts().findByText("現在の内容は既にこのリビジョンと同じです"),
    ).toBeTruthy();
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(router.state.location.pathname).toBe(before);
    expect(router.state.location.search).not.toHaveProperty("memo");
    expect(toasts().queryByText(`${TIME[0]} の内容に戻しました`)).toBeNull();
  });

  it("reports a rejection under the button, not in a toast", async () => {
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
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(toasts().queryByText("対象が見つかりません")).toBeNull();
    expect(screen.getByRole("button", { name: "この内容に戻す" })).toBeTruthy();
  });

  it("does nothing when the confirmation is cancelled", async () => {
    await render(THREE);
    const dialog = await openConfirm();
    fireEvent.click(within(dialog).getByRole("button", { name: "キャンセル" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(mocks.rollbackMemoFn).not.toHaveBeenCalled();
  });
});

import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { renderWithRouter } from "@/components/__tests__/renderWithRouter";
import { DocumentActions } from "@/components/documents/DocumentActions";
import { AppShell } from "@/components/layout/AppShell";
import { AppServerError } from "@/presentation/errorResponse";

const mocks = vi.hoisted(() => ({
  trashDocumentFn:
    vi.fn<(input: { data: { documentId: string } }) => Promise<unknown>>(),
}));

vi.mock("@tanstack/react-start", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@tanstack/react-start")>()),
  useServerFn: (fn: unknown) => fn,
}));

vi.mock("@/components/documents/actions", () => ({
  createDocumentFn: vi.fn(),
  editDocumentFn: vi.fn(),
  trashDocumentFn: mocks.trashDocumentFn,
  rollbackDocumentFn: vi.fn(),
  diffDocumentRevisionsFn: vi.fn(),
}));

afterEach(() => {
  vi.clearAllMocks();
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const SYSTEM_ERROR = new AppServerError({
  kind: "system",
  code: "X",
  message: "x",
  retryable: false,
});

async function draw() {
  const rendered = await renderWithRouter(
    <AppShell>
      <DocumentActions documentId="d1" topicId="t1" />
      <p>本文</p>
    </AppShell>,
    { path: "/documents/$documentId" },
  );
  const header = screen.getByRole("banner");
  // The header's slot is portalled into once the header has mounted.
  const del = await within(header).findByRole("button", { name: "削除" });
  return { ...rendered, header, del };
}

async function confirmDelete(del: HTMLElement) {
  fireEvent.click(del);
  fireEvent.click(
    within(screen.getByRole("dialog", { name: "削除しますか？" })).getByRole(
      "button",
      { name: "削除" },
    ),
  );
}

describe("DocumentActions", () => {
  it("puts edit, history and delete into the header as icons, the two links resolving", async () => {
    const { header, del, expectInternalHrefsToResolve } = await draw();
    const edit = within(header).getByRole("link", { name: "編集" });
    const history = within(header).getByRole("link", { name: "履歴を表示" });
    expect(edit.getAttribute("href")).toBe("/documents/d1/edit");
    expect(history.getAttribute("href")).toBe("/documents/d1/history");
    for (const control of [edit, history, del]) {
      expect(control.textContent).toBe("");
      expect(control.querySelector("svg")).not.toBeNull();
    }
    expect(screen.getByRole("main").contains(del)).toBe(false);
    expectInternalHrefsToResolve();
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("asks before deleting and does nothing on cancel", async () => {
    const { del } = await draw();
    fireEvent.click(del);
    const dialog = screen.getByRole("dialog", { name: "削除しますか？" });
    expect(dialog.textContent).toContain(
      "このドキュメントはゴミ箱に移動します。ゴミ箱から元に戻せます。",
    );
    fireEvent.click(within(dialog).getByRole("button", { name: "キャンセル" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(mocks.trashDocumentFn).not.toHaveBeenCalled();
  });

  it("trashes on confirm, reconciles before leaving for the topic and says so in a toast", async () => {
    const trash = deferred<unknown>();
    mocks.trashDocumentFn.mockReturnValue(trash.promise);
    const { router, del } = await draw();
    const navigate = vi.spyOn(router, "navigate");
    const invalidate = vi.spyOn(router, "invalidate");
    await confirmDelete(del);
    expect(mocks.trashDocumentFn).toHaveBeenCalledWith({
      data: { documentId: "d1" },
    });
    expect(screen.getByRole("status").textContent).toBe("");
    trash.resolve({ deleted: true });
    await waitFor(() =>
      expect(navigate).toHaveBeenCalledWith({
        to: "/topics/$topicId",
        params: { topicId: "t1" },
      }),
    );
    expect(screen.getByRole("status").textContent).toBe(
      "ドキュメントを削除しました",
    );
    // The topic screen is cached with this document still on it, so the
    // reconciliation has to land before the navigation reads that cache.
    expect(invalidate.mock.invocationCallOrder[0]).toBeLessThan(
      navigate.mock.invocationCallOrder[0] ?? 0,
    );
  });

  it("shows the failure at the head of the sheet, stays, and retries the confirmed delete", async () => {
    mocks.trashDocumentFn.mockRejectedValueOnce(SYSTEM_ERROR);
    mocks.trashDocumentFn.mockResolvedValueOnce({ deleted: true });
    const { router, del } = await draw();
    const navigate = vi.spyOn(router, "navigate");
    await confirmDelete(del);
    const alert = await screen.findByRole("alert");
    expect(
      within(alert).getByText("システムエラーが発生しました"),
    ).toBeTruthy();
    const sheet = screen.getByRole("main");
    expect(sheet.contains(alert)).toBe(true);
    expect(
      alert.compareDocumentPosition(screen.getByText("本文")) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(navigate).not.toHaveBeenCalled();
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(screen.getByRole("status").textContent).toBe("");

    fireEvent.click(within(alert).getByRole("button", { name: "再試行" }));
    expect(screen.queryByRole("dialog")).toBeNull();
    await waitFor(() => expect(mocks.trashDocumentFn).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(navigate).toHaveBeenCalledTimes(1));
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("treats a resolved value of the wrong shape as a system error", async () => {
    mocks.trashDocumentFn.mockResolvedValue({ status: 500, unhandled: true });
    const { router, del } = await draw();
    const navigate = vi.spyOn(router, "navigate");
    await confirmDelete(del);
    const alert = await screen.findByRole("alert");
    expect(
      within(alert).getByText("システムエラーが発生しました"),
    ).toBeTruthy();
    expect(navigate).not.toHaveBeenCalled();
  });
});

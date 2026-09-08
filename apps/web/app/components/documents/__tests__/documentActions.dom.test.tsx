import { fireEvent, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { renderWithRouter } from "@/components/__tests__/renderWithRouter";
import { DocumentActions } from "@/components/documents/DocumentActions";
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

async function draw() {
  return renderWithRouter(<DocumentActions documentId="d1" topicId="t1" />, {
    path: "/documents/$documentId",
  });
}

describe("DocumentActions", () => {
  it("links to the editor and the history, and both resolve", async () => {
    const { expectInternalHrefsToResolve } = await draw();
    expect(
      screen.getByRole("link", { name: "編集" }).getAttribute("href"),
    ).toBe("/documents/d1/edit");
    expect(
      screen.getByRole("link", { name: "履歴" }).getAttribute("href"),
    ).toBe("/documents/d1/history");
    expectInternalHrefsToResolve();
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("asks before deleting and does nothing on cancel", async () => {
    await draw();
    fireEvent.click(screen.getByRole("button", { name: "削除" }));
    const dialog = screen.getByRole("dialog", {
      name: "ドキュメントを削除しますか？",
    });
    expect(dialog).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "キャンセル" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(mocks.trashDocumentFn).not.toHaveBeenCalled();
  });

  it("trashes on confirm and leaves for the topic", async () => {
    const trash = deferred<unknown>();
    mocks.trashDocumentFn.mockReturnValue(trash.promise);
    const { router } = await draw();
    const navigate = vi.spyOn(router, "navigate");
    fireEvent.click(screen.getByRole("button", { name: "削除" }));
    fireEvent.click(
      screen.getByRole("dialog").querySelector(".fog-danger") as HTMLElement,
    );
    expect(mocks.trashDocumentFn).toHaveBeenCalledWith({
      data: { documentId: "d1" },
    });
    trash.resolve({ deleted: true });
    await waitFor(() =>
      expect(navigate).toHaveBeenCalledWith({
        to: "/topics/$topicId",
        params: { topicId: "t1" },
      }),
    );
  });

  it("shows the failure and stays when the delete is rejected", async () => {
    mocks.trashDocumentFn.mockRejectedValue(
      new AppServerError({
        kind: "system",
        code: "X",
        message: "x",
        retryable: false,
      }),
    );
    const { router } = await draw();
    const navigate = vi.spyOn(router, "navigate");
    fireEvent.click(screen.getByRole("button", { name: "削除" }));
    fireEvent.click(
      screen.getByRole("dialog").querySelector(".fog-danger") as HTMLElement,
    );
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toBe("システムエラーが発生しました");
    expect(navigate).not.toHaveBeenCalled();
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });

  it("treats a resolved value of the wrong shape as a system error", async () => {
    mocks.trashDocumentFn.mockResolvedValue({ status: 500, unhandled: true });
    const { router } = await draw();
    const navigate = vi.spyOn(router, "navigate");
    fireEvent.click(screen.getByRole("button", { name: "削除" }));
    fireEvent.click(
      screen.getByRole("dialog").querySelector(".fog-danger") as HTMLElement,
    );
    expect((await screen.findByRole("alert")).textContent).toBe(
      "システムエラーが発生しました",
    );
    expect(navigate).not.toHaveBeenCalled();
  });
});

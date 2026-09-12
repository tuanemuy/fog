import type { DocumentRevisionMetaView } from "@repo/core/application/knowledge/view";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { renderWithRouter } from "@/components/__tests__/renderWithRouter";
import { toastRegion, withToasts } from "@/components/__tests__/toastFrame";
import { DocumentRevisionHistory } from "@/components/documents/DocumentRevisionHistory";
import { AppServerError } from "@/presentation/errorResponse";
import { formatDateTime } from "@/presentation/time";

const mocks = vi.hoisted(() => ({
  diffDocumentRevisionsFn:
    vi.fn<(input: { data: unknown }) => Promise<unknown>>(),
  rollbackDocumentFn: vi.fn<(input: { data: unknown }) => Promise<unknown>>(),
}));

vi.mock("@tanstack/react-start", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@tanstack/react-start")>()),
  useServerFn: (fn: unknown) => fn,
}));

vi.mock("@/components/documents/actions", () => ({
  createDocumentFn: vi.fn(),
  editDocumentFn: vi.fn(),
  trashDocumentFn: vi.fn(),
  rollbackDocumentFn: mocks.rollbackDocumentFn,
  diffDocumentRevisionsFn: mocks.diffDocumentRevisionsFn,
}));

afterEach(() => {
  vi.clearAllMocks();
});

const AT = [
  new Date("2026-09-08T01:00:00.000Z"),
  new Date("2026-09-08T02:00:00.000Z"),
  new Date("2026-09-08T03:00:00.000Z"),
] as const;
const TIME = AT.map(formatDateTime);

function revision(
  n: number,
  actor: DocumentRevisionMetaView["actor"],
  changeReason: string,
): DocumentRevisionMetaView {
  return {
    revisionNumber: n,
    actor,
    changeReason,
    createdAt: AT[n - 1] as Date,
  };
}

const THREE = [
  revision(1, { kind: "user" }, "作成"),
  revision(2, { kind: "aiClient", clientName: "Claude" }, "要約を追加"),
  revision(3, { kind: "user" }, "手動編集"),
];

function diffOf(base: number, target: number, titles = ["同じ", "同じ"]) {
  return {
    base: {
      revisionNumber: base,
      title: titles[0],
      body: "a\nold",
      actor: { kind: "user" },
      changeReason: "x",
      createdAt: AT[0],
    },
    target: {
      revisionNumber: target,
      title: titles[1],
      body: "a\nnew",
      actor: { kind: "user" },
      changeReason: "y",
      createdAt: AT[0],
    },
  };
}

async function draw(revisions: readonly DocumentRevisionMetaView[]) {
  return renderWithRouter(
    withToasts(
      <DocumentRevisionHistory
        documentId="d1"
        title="設計メモ"
        latestRevision={revisions[revisions.length - 1]?.revisionNumber ?? 1}
        revisions={revisions}
      />,
    ),
    { path: "/documents/$documentId/history" },
  );
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

const toasts = () => within(toastRegion());

describe("DocumentRevisionHistory", () => {
  it("heads the sheet with the document's title, then 履歴", async () => {
    await draw(THREE);
    const h1 = screen.getByRole("heading", { level: 1 });
    expect(h1.textContent).toBe("設計メモ");
    expect(
      screen.getByRole("heading", { level: 2, name: "履歴" }),
    ).toBeTruthy();
    expect(screen.queryByRole("link")).toBeNull();
  });

  it("draws a single revision without selection or rollback", async () => {
    await draw([THREE[0] as DocumentRevisionMetaView]);
    expect(rows()).toHaveLength(1);
    expect(within(rows()[0] as HTMLElement).queryByRole("button")).toBeNull();
    expect(document.querySelectorAll("[aria-pressed]")).toHaveLength(0);
    expect(screen.queryByRole("button", { name: "この内容に戻す" })).toBeNull();
    expect(rows()[0]?.textContent).toBe(`${TIME[0]}あなた · 作成`);
  });

  it("lists when and who · why ascending, and the first click diffs against the latest", async () => {
    mocks.diffDocumentRevisionsFn.mockResolvedValue(diffOf(1, 3));
    await draw(THREE);
    expect(rows().map((item) => item.textContent)).toEqual([
      `${TIME[0]}あなた · 作成`,
      `${TIME[1]}Claude · 要約を追加`,
      `${TIME[2]}あなた · 手動編集`,
    ]);
    expect(row(1).getAttribute("aria-pressed")).toBe("false");
    fireEvent.click(row(1));
    expect(row(1).getAttribute("aria-pressed")).toBe("true");
    expect(within(row(1)).getByText("比較元")).toBeTruthy();
    expect(mocks.diffDocumentRevisionsFn).toHaveBeenCalledWith({
      data: {
        documentId: "d1",
        baseRevisionNumber: 1,
        targetRevisionNumber: 3,
      },
    });
    expect(
      screen.getByRole("region", {
        name: `${TIME[0]} → ${TIME[2]}（最新） の差分`,
      }),
    ).toBeTruthy();
    await waitFor(() =>
      expect(
        within(diffRegion())
          .queryAllByRole("deletion")
          .map((el) => el.textContent),
      ).toEqual(["old"]),
    );
    expect(
      within(diffRegion())
        .getAllByRole("insertion")
        .map((el) => el.textContent),
    ).toEqual(["new"]);
    expect(within(diffRegion()).queryByText(/タイトル:/)).toBeNull();
    expect(screen.getByRole("button", { name: "この内容に戻す" })).toBeTruthy();
    expect(screen.getByText(`比較元 · ${TIME[0]}`)).toBeTruthy();
  });

  it("switches to base → target on the second click and shows a title change", async () => {
    mocks.diffDocumentRevisionsFn
      .mockResolvedValueOnce(diffOf(1, 3))
      .mockResolvedValueOnce(diffOf(1, 2, ["旧題", "新題"]))
      .mockResolvedValueOnce(diffOf(1, 3));
    await draw(THREE);
    fireEvent.click(row(1));
    fireEvent.click(row(2));
    expect(within(row(2)).getByText("比較先")).toBeTruthy();
    expect(mocks.diffDocumentRevisionsFn).toHaveBeenLastCalledWith({
      data: {
        documentId: "d1",
        baseRevisionNumber: 1,
        targetRevisionNumber: 2,
      },
    });
    expect(
      screen.getByRole("region", { name: `${TIME[0]} → ${TIME[1]} の差分` }),
    ).toBeTruthy();
    const title = await within(diffRegion()).findByText(/タイトル:/);
    expect(within(title).getByRole("deletion").textContent).toBe("旧題");
    expect(within(title).getByRole("insertion").textContent).toBe("新題");
    // Re-clicking the target drops it and goes back to the latest;
    // re-clicking the base drops both.
    fireEvent.click(row(2));
    expect(within(row(2)).queryByText("比較先")).toBeNull();
    expect(mocks.diffDocumentRevisionsFn).toHaveBeenLastCalledWith({
      data: {
        documentId: "d1",
        baseRevisionNumber: 1,
        targetRevisionNumber: 3,
      },
    });
    fireEvent.click(row(1));
    expect(within(row(1)).queryByText("比較元")).toBeNull();
    expect(screen.queryByRole("button", { name: "この内容に戻す" })).toBeNull();
    expect(screen.queryByRole("region", { name: /の差分$/ })).toBeNull();
  });

  it("does not fetch when the latest revision is chosen first", async () => {
    await draw(THREE);
    fireEvent.click(row(3));
    expect(mocks.diffDocumentRevisionsFn).not.toHaveBeenCalled();
    expect(screen.queryByRole("region", { name: /の差分$/ })).toBeNull();
    expect(screen.getByRole("button", { name: "この内容に戻す" })).toBeTruthy();
  });

  it("rolls back the base after a confirmation, leaves for the document and says so in a toast", async () => {
    mocks.diffDocumentRevisionsFn.mockResolvedValue(diffOf(1, 3));
    mocks.rollbackDocumentFn.mockResolvedValue({
      changed: true,
      latestRevision: 4,
      version: 3,
      updatedAt: AT[2],
    });
    const { router } = await draw(THREE);
    const navigate = vi.spyOn(router, "navigate");
    fireEvent.click(row(1));
    fireEvent.click(screen.getByRole("button", { name: "この内容に戻す" }));
    const dialog = screen.getByRole("dialog", {
      name: "この内容に戻しますか？",
    });
    expect(dialog.textContent).toContain(
      `${TIME[0]} の内容で新しいリビジョンを作ります。これまでの履歴は残ります。`,
    );
    expect(toasts().queryByText(`${TIME[0]} の内容に戻しました`)).toBeNull();
    fireEvent.click(within(dialog).getByRole("button", { name: "戻す" }));
    expect(mocks.rollbackDocumentFn).toHaveBeenCalledWith({
      data: { documentId: "d1", revisionNumber: 1 },
    });
    await waitFor(() =>
      expect(navigate).toHaveBeenCalledWith({
        to: "/documents/$documentId",
        params: { documentId: "d1" },
      }),
    );
    expect(
      await toasts().findByText(`${TIME[0]} の内容に戻しました`),
    ).toBeTruthy();
  });

  it("says so in a toast when the rollback changes nothing, and reports a rejection under the button", async () => {
    mocks.rollbackDocumentFn.mockResolvedValueOnce({
      changed: false,
      latestRevision: 3,
      version: 2,
      updatedAt: AT[2],
    });
    const { router } = await draw(THREE);
    const navigate = vi.spyOn(router, "navigate");
    fireEvent.click(row(3));
    fireEvent.click(screen.getByRole("button", { name: "この内容に戻す" }));
    fireEvent.click(screen.getByRole("button", { name: "戻す" }));
    expect(
      await toasts().findByText("現在の内容は既にこのリビジョンと同じです"),
    ).toBeTruthy();
    expect(navigate).not.toHaveBeenCalled();
    expect(screen.queryByRole("alert")).toBeNull();

    mocks.rollbackDocumentFn.mockRejectedValueOnce(
      new AppServerError({
        kind: "system",
        code: "X",
        message: "x",
        retryable: false,
      }),
    );
    fireEvent.click(screen.getByRole("button", { name: "この内容に戻す" }));
    fireEvent.click(screen.getByRole("button", { name: "戻す" }));
    expect((await screen.findByRole("alert")).textContent).toBe(
      "システムエラーが発生しました",
    );
    expect(toasts().queryByText("システムエラーが発生しました")).toBeNull();
  });

  it("treats a diff of the wrong shape as a system error, and 再試行 fetches again", async () => {
    mocks.diffDocumentRevisionsFn
      .mockResolvedValueOnce({ status: 500 })
      .mockResolvedValueOnce(diffOf(1, 3));
    await draw(THREE);
    fireEvent.click(row(1));
    const alert = await within(diffRegion()).findByRole("alert");
    expect(
      within(alert).getByText("システムエラーが発生しました"),
    ).toBeTruthy();
    fireEvent.click(within(alert).getByRole("button", { name: "再試行" }));
    expect(mocks.diffDocumentRevisionsFn).toHaveBeenLastCalledWith({
      data: {
        documentId: "d1",
        baseRevisionNumber: 1,
        targetRevisionNumber: 3,
      },
    });
    await waitFor(() =>
      expect(within(diffRegion()).queryAllByRole("deletion")).toHaveLength(1),
    );
    expect(within(diffRegion()).queryByRole("alert")).toBeNull();
  });
});

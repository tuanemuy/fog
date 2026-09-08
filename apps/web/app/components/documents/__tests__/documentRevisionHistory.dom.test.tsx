import type { DocumentRevisionMetaView } from "@repo/core/application/knowledge/view";
import { fireEvent, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { renderWithRouter } from "@/components/__tests__/renderWithRouter";
import { DocumentRevisionHistory } from "@/components/documents/DocumentRevisionHistory";
import { AppServerError } from "@/presentation/errorResponse";

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

const AT = new Date("2026-09-08T01:00:00.000Z");

function revision(
  n: number,
  actor: DocumentRevisionMetaView["actor"],
  changeReason: string,
): DocumentRevisionMetaView {
  return { revisionNumber: n, actor, changeReason, createdAt: AT };
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
      createdAt: AT,
    },
    target: {
      revisionNumber: target,
      title: titles[1],
      body: "a\nnew",
      actor: { kind: "user" },
      changeReason: "y",
      createdAt: AT,
    },
  };
}

async function draw(revisions: readonly DocumentRevisionMetaView[]) {
  return renderWithRouter(
    <DocumentRevisionHistory
      documentId="d1"
      title="設計メモ"
      latestRevision={revisions[revisions.length - 1]?.revisionNumber ?? 1}
      revisions={revisions}
    />,
    { path: "/documents/$documentId/history" },
  );
}

function rows() {
  return screen.getAllByRole("listitem");
}

describe("DocumentRevisionHistory", () => {
  it("draws a single revision without selection or rollback", async () => {
    await draw([THREE[0] as DocumentRevisionMetaView]);
    expect(rows()).toHaveLength(1);
    expect(screen.queryAllByRole("button", { pressed: false })).toHaveLength(0);
    expect(document.querySelectorAll("[aria-pressed]")).toHaveLength(0);
    expect(screen.queryByRole("button", { name: "この内容に戻す" })).toBeNull();
    expect(screen.getByText(/あなた · 作成/)).toBeTruthy();
  });

  it("lists who · why ascending, and the first click diffs against the latest", async () => {
    mocks.diffDocumentRevisionsFn.mockResolvedValue(diffOf(1, 3));
    await draw(THREE);
    expect(rows().map((row) => row.textContent)).toEqual([
      expect.stringContaining("あなた · 作成 · リビジョン 1"),
      expect.stringContaining("Claude · 要約を追加 · リビジョン 2"),
      expect.stringContaining("あなた · 手動編集 · リビジョン 3"),
    ]);
    fireEvent.click(screen.getByRole("button", { name: /リビジョン 1/ }));
    expect(screen.getByText("比較元")).toBeTruthy();
    expect(mocks.diffDocumentRevisionsFn).toHaveBeenCalledWith({
      data: {
        documentId: "d1",
        baseRevisionNumber: 1,
        targetRevisionNumber: 3,
      },
    });
    expect(
      screen.getByText(/リビジョン 1 → リビジョン 3（最新） の差分/),
    ).toBeTruthy();
    await waitFor(() =>
      expect(
        document.querySelector(".fog-diff-line.removed")?.textContent,
      ).toContain("old"),
    );
    expect(
      document.querySelector(".fog-diff-line.added")?.textContent,
    ).toContain("new");
    expect(document.querySelector(".fog-diff-title")).toBeNull();
    expect(screen.getByRole("button", { name: "この内容に戻す" })).toBeTruthy();
  });

  it("switches to base → target on the second click and shows a title change", async () => {
    mocks.diffDocumentRevisionsFn
      .mockResolvedValueOnce(diffOf(1, 3))
      .mockResolvedValueOnce(diffOf(1, 2, ["旧題", "新題"]));
    await draw(THREE);
    fireEvent.click(screen.getByRole("button", { name: /リビジョン 1/ }));
    fireEvent.click(screen.getByRole("button", { name: /リビジョン 2/ }));
    expect(screen.getByText("比較先")).toBeTruthy();
    expect(mocks.diffDocumentRevisionsFn).toHaveBeenLastCalledWith({
      data: {
        documentId: "d1",
        baseRevisionNumber: 1,
        targetRevisionNumber: 2,
      },
    });
    await waitFor(() =>
      expect(document.querySelector(".fog-diff-title")?.textContent).toContain(
        "旧題",
      ),
    );
    expect(document.querySelector(".fog-diff-title")?.textContent).toContain(
      "新題",
    );
    // Re-clicking the target drops it; re-clicking the base drops both.
    fireEvent.click(screen.getByRole("button", { name: /リビジョン 2/ }));
    expect(screen.queryByText("比較先")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /リビジョン 1/ }));
    expect(screen.queryByText("比較元")).toBeNull();
    expect(screen.queryByRole("button", { name: "この内容に戻す" })).toBeNull();
  });

  it("does not fetch when the latest revision is chosen first", async () => {
    await draw(THREE);
    fireEvent.click(screen.getByRole("button", { name: /リビジョン 3/ }));
    expect(mocks.diffDocumentRevisionsFn).not.toHaveBeenCalled();
    expect(screen.queryByRole("region", { name: "差分" })).toBeNull();
    expect(screen.getByRole("button", { name: "この内容に戻す" })).toBeTruthy();
  });

  it("rolls back the base after a confirmation and leaves for the document", async () => {
    mocks.diffDocumentRevisionsFn.mockResolvedValue(diffOf(1, 3));
    mocks.rollbackDocumentFn.mockResolvedValue({
      changed: true,
      latestRevision: 4,
      version: 3,
      updatedAt: AT,
    });
    const { router } = await draw(THREE);
    const navigate = vi.spyOn(router, "navigate");
    fireEvent.click(screen.getByRole("button", { name: /リビジョン 1/ }));
    fireEvent.click(screen.getByRole("button", { name: "この内容に戻す" }));
    expect(
      screen.getByRole("dialog", { name: "この内容に戻しますか？" }),
    ).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "戻す" }));
    expect(mocks.rollbackDocumentFn).toHaveBeenCalledWith({
      data: { documentId: "d1", revisionNumber: 1 },
    });
    await waitFor(() =>
      expect(navigate).toHaveBeenCalledWith({
        to: "/documents/$documentId",
        params: { documentId: "d1" },
      }),
    );
  });

  it("says so when the rollback changes nothing, and reports a rejection", async () => {
    mocks.rollbackDocumentFn.mockResolvedValueOnce({
      changed: false,
      latestRevision: 3,
      version: 2,
      updatedAt: AT,
    });
    const { router } = await draw(THREE);
    const navigate = vi.spyOn(router, "navigate");
    fireEvent.click(screen.getByRole("button", { name: /リビジョン 3/ }));
    fireEvent.click(screen.getByRole("button", { name: "この内容に戻す" }));
    fireEvent.click(screen.getByRole("button", { name: "戻す" }));
    expect((await screen.findByRole("status")).textContent).toBe(
      "現在の内容は既にこのリビジョンと同じです",
    );
    expect(navigate).not.toHaveBeenCalled();

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
  });

  it("treats a diff of the wrong shape as a system error", async () => {
    mocks.diffDocumentRevisionsFn.mockResolvedValue({ status: 500 });
    await draw(THREE);
    fireEvent.click(screen.getByRole("button", { name: /リビジョン 1/ }));
    expect((await screen.findByRole("alert")).textContent).toBe(
      "システムエラーが発生しました",
    );
  });
});

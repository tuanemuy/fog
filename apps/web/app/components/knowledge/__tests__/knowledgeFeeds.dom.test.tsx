import {
  NotFoundError,
  SystemError,
  SystemErrorCode,
} from "@repo/core/application/errors";
import { screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { renderWithRouter } from "@/components/__tests__/renderWithRouter";
import { DocumentFeed } from "@/components/documents/DocumentFeed";
import { DocumentHistoryFeed } from "@/components/documents/DocumentHistoryFeed";
import { TopicDetailFeed } from "@/components/topics/TopicDetailFeed";

const mocks = vi.hoisted(() => ({
  requireUserId: vi.fn<() => Promise<string>>(),
  loaders: [] as Array<ReturnType<typeof vi.fn>>,
}));

vi.mock("@tanstack/react-start", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@tanstack/react-start")>()),
  useServerFn: (fn: unknown) => fn,
}));

vi.mock("@/components/documents/actions", () => ({
  createDocumentFn: vi.fn(),
  editDocumentFn: vi.fn(),
  trashDocumentFn: vi.fn(),
  rollbackDocumentFn: vi.fn(),
  diffDocumentRevisionsFn: vi.fn(),
}));

// `DocumentHistoryFeed` reaches the timeline's `actorLabel`, and with it the
// module that builds the real server functions.
vi.mock("@/components/timeline/actions", () => ({
  postMemoFn: vi.fn(),
  loadTimelinePageFn: vi.fn(),
  editMemoFn: vi.fn(),
  softDeleteMemoFn: vi.fn(),
}));

vi.mock("@/components/topics/actions", () => ({
  createTopicFn: vi.fn(),
  updateTopicFn: vi.fn(),
  trashTopicFn: vi.fn(),
}));

vi.mock("@/presentation/currentUser", () => ({
  requireUserId: mocks.requireUserId,
}));

// The guard's redaction and logging are the middleware's tests; here it
// only has to let the failure through as the leaf sees it.
vi.mock("@/presentation/errorResponseMiddleware", () => ({
  guardStreamedRender: (load: () => Promise<unknown>) => load(),
}));

// `serverData` runs at module load, in import order: DocumentFeed's three
// loaders (document, sources, topic name), DocumentHistoryFeed's two
// (revisions, document), then TopicDetailFeed's one.
vi.mock("@/presentation/serverAction", () => ({
  serverData: () => {
    const loader = vi.fn();
    mocks.loaders.push(loader);
    return loader;
  },
}));

const USER_ID = "01950000-0000-7000-8000-000000000001";

// The routes validate `$documentId` / `$topicId` as a 1–200 character
// string and hand it to these streamed leaves; an id that names nothing
// (unknown, trashed, another user's — the object answers the same) comes
// back as a notFound, which the leaf draws as a screen state.
describe("the knowledge leaves' not-found branch", () => {
  it("DocumentFeed draws 「ドキュメントが見つかりません」 for a notFound", async () => {
    const [loadDocument] = mocks.loaders;
    mocks.requireUserId.mockResolvedValue(USER_ID);
    loadDocument?.mockRejectedValue(
      new NotFoundError("DOCUMENT_NOT_FOUND", "The document was not found"),
    );
    await renderWithRouter(await DocumentFeed({ documentId: "missing" }), {
      path: "/documents/$documentId",
    });
    // P-08 leaves the `h1` to the document's title, so this sentence, drawn
    // in its place, is the page's heading.
    expect(screen.getByText("ドキュメントが見つかりません").tagName).toBe("H1");
    expect(
      screen.getByRole("link", { name: "トピック一覧へ" }).getAttribute("href"),
    ).toBe("/topics");
    expect(loadDocument).toHaveBeenCalledWith(USER_ID, "missing");
  });

  it("DocumentFeed lets any other failure through to the route's error boundary", async () => {
    const [loadDocument] = mocks.loaders;
    mocks.requireUserId.mockResolvedValue(USER_ID);
    loadDocument?.mockRejectedValue(
      new SystemError(SystemErrorCode.DatabaseError, "down"),
    );
    await expect(DocumentFeed({ documentId: "any" })).rejects.toThrow("down");
  });

  // P-10 declares `h1: "sheet"` too, so this sentence standing in for the
  // document's title is the page's only heading.
  it("DocumentHistoryFeed draws 「ドキュメントが見つかりません」 for a notFound", async () => {
    const loadRevisions = mocks.loaders[3];
    mocks.requireUserId.mockResolvedValue(USER_ID);
    loadRevisions?.mockRejectedValue(
      new NotFoundError("DOCUMENT_NOT_FOUND", "The document was not found"),
    );
    await renderWithRouter(
      await DocumentHistoryFeed({ documentId: "missing" }),
      { path: "/documents/$documentId/history" },
    );
    expect(screen.getByText("ドキュメントが見つかりません").tagName).toBe("H1");
    expect(
      screen.getByRole("link", { name: "トピック一覧へ" }).getAttribute("href"),
    ).toBe("/topics");
    expect(loadRevisions).toHaveBeenCalledWith(USER_ID, "missing");
  });

  it("DocumentHistoryFeed lets any other failure through to the route's error boundary", async () => {
    const loadRevisions = mocks.loaders[3];
    mocks.requireUserId.mockResolvedValue(USER_ID);
    loadRevisions?.mockRejectedValue(
      new SystemError(SystemErrorCode.DatabaseError, "down"),
    );
    await expect(DocumentHistoryFeed({ documentId: "any" })).rejects.toThrow(
      "down",
    );
  });

  it("TopicDetailFeed draws 「トピックが見つかりません」 for a notFound", async () => {
    const loadTopic = mocks.loaders[5];
    mocks.requireUserId.mockResolvedValue(USER_ID);
    loadTopic?.mockRejectedValue(
      new NotFoundError("TOPIC_NOT_FOUND", "The topic was not found"),
    );
    await renderWithRouter(await TopicDetailFeed({ topicId: "missing" }), {
      path: "/topics/$topicId",
    });
    expect(screen.getByText("トピックが見つかりません").tagName).toBe("H1");
    expect(
      screen.getByRole("link", { name: "トピック一覧へ" }).getAttribute("href"),
    ).toBe("/topics");
    expect(screen.queryByRole("region", { name: "ドキュメント" })).toBeNull();
    expect(loadTopic).toHaveBeenCalledWith(USER_ID, "missing");
  });

  it("TopicDetailFeed draws the head, the documents and the related memos when the topic is there", async () => {
    const loadTopic = mocks.loaders[5];
    mocks.requireUserId.mockResolvedValue(USER_ID);
    const at = new Date("2026-01-01T14:00:00Z");
    loadTopic?.mockResolvedValue({
      topic: {
        id: "t1",
        name: "ブランド刷新",
        description: null,
        status: "active",
        version: 0,
        createdAt: at,
        updatedAt: at,
      },
      documents: [{ id: "d1", title: "サイト構成の方針", updatedAt: at }],
      relatedMemos: [
        { memoId: "m1", snippet: "紺は残す", postedAt: at, deleted: false },
      ],
    });
    await renderWithRouter(await TopicDetailFeed({ topicId: "t1" }), {
      path: "/topics/$topicId",
    });
    expect(screen.getByRole("heading", { level: 1 }).textContent).toBe(
      "ブランド刷新",
    );
    expect(screen.queryByText("トピックが見つかりません")).toBeNull();
    expect(
      screen
        .getAllByRole("heading", { level: 2 })
        .map((heading) => heading.textContent),
    ).toEqual(["ドキュメント", "関連メモ"]);
    expect(
      screen
        .getByRole("link", { name: /サイト構成の方針/ })
        .getAttribute("href"),
    ).toBe("/documents/d1");
    expect(
      screen.getByRole("link", { name: "タイムラインで表示: 紺は残す" }),
    ).toBeTruthy();
  });
});

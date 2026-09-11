import {
  NotFoundError,
  SystemError,
  SystemErrorCode,
} from "@repo/core/application/errors";
import { screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { renderWithRouter } from "@/components/__tests__/renderWithRouter";
import { DocumentFeed } from "@/components/documents/DocumentFeed";
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
// loaders (document, sources, topic name), then TopicDetailFeed's one.
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
    expect(screen.getByRole("heading", { level: 2 }).textContent).toBe(
      "ドキュメントが見つかりません",
    );
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

  it("TopicDetailFeed draws 「トピックが見つかりません」 for a notFound", async () => {
    const loadTopic = mocks.loaders[3];
    mocks.requireUserId.mockResolvedValue(USER_ID);
    loadTopic?.mockRejectedValue(
      new NotFoundError("TOPIC_NOT_FOUND", "The topic was not found"),
    );
    await renderWithRouter(await TopicDetailFeed({ topicId: "missing" }), {
      path: "/topics/$topicId",
    });
    expect(screen.getByRole("heading", { level: 2 }).textContent).toBe(
      "トピックが見つかりません",
    );
    expect(loadTopic).toHaveBeenCalledWith(USER_ID, "missing");
  });
});

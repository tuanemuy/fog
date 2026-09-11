import type {
  DocumentView,
  SourceMemoView,
} from "@repo/core/application/knowledge/view";
import {
  createRouter,
  type StaticDataRouteOption,
} from "@tanstack/react-router";
import { screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { renderWithRouter } from "@/components/__tests__/renderWithRouter";
import { DocumentFeed } from "@/components/documents/DocumentFeed";
import { DocumentSkeleton } from "@/components/documents/DocumentSkeleton";
import { AppShell } from "@/components/layout/AppShell";
import { routeTree } from "@/routeTree.gen";

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

vi.mock("@/presentation/currentUser", () => ({
  requireUserId: mocks.requireUserId,
}));

// `serverData` runs at module load: DocumentFeed's three loaders, in the
// order it declares them (document, sources, topic name).
vi.mock("@/presentation/serverAction", () => ({
  serverData: () => {
    const loader = vi.fn();
    mocks.loaders.push(loader);
    return loader;
  },
}));

afterEach(() => {
  vi.clearAllMocks();
});

const NOW = new Date("2026-09-08T01:00:00.000Z");

const DOCUMENT: DocumentView = {
  id: "d1",
  topicId: "t1",
  title: "サイト構成の方針",
  body: "トップは姿勢を見せる。\n\n## 構成\n\n- トップ\n- 事例",
  latestRevision: 2,
  version: 3,
  createdAt: NOW,
  updatedAt: NOW,
};

const SOURCE: SourceMemoView = {
  memoId: "m1",
  snippet: "ワイヤーフレームの構成",
  postedAt: NOW,
  deleted: false,
  linkedAt: NOW,
};

/** The header P-08 declares in the production route tree. */
function productionDocumentHeader(): StaticDataRouteOption {
  const route = new Map(
    Object.entries(createRouter({ routeTree }).routesByPath),
  ).get("/documents/$documentId");
  return (route?.options.staticData ?? {}) as StaticDataRouteOption;
}

async function drawDocument(sourceMemos: readonly SourceMemoView[]) {
  const [loadDocument, loadSources, loadTopicName] = mocks.loaders;
  mocks.requireUserId.mockResolvedValue("u1");
  loadDocument?.mockResolvedValue(DOCUMENT);
  loadSources?.mockResolvedValue({ sourceMemos });
  loadTopicName?.mockResolvedValue({ topicId: "t1", name: "ブランド刷新" });
  const rendered = await renderWithRouter(
    <AppShell>{await DocumentFeed({ documentId: "d1" })}</AppShell>,
    {
      path: "/documents/$documentId",
      staticData: { "/documents/$documentId": productionDocumentHeader() },
    },
  );
  await within(screen.getByRole("banner")).findByRole("button", {
    name: "削除",
  });
  return rendered;
}

describe("DocumentFeed", () => {
  it("makes the document's title the page's one h1, under the topic, and the header's name a label", async () => {
    const { expectInternalHrefsToResolve } = await drawDocument([SOURCE]);
    const headings = screen.getAllByRole("heading", { level: 1 });
    expect(headings.map((heading) => heading.textContent)).toEqual([
      "サイト構成の方針",
    ]);
    const sheet = screen.getByRole("main");
    expect(sheet.contains(headings[0] ?? null)).toBe(true);
    expect(
      within(screen.getByRole("banner")).getByText("document"),
    ).toBeTruthy();
    const article = screen.getByRole("article", { name: "サイト構成の方針" });
    const topic = within(article).getByRole("link", { name: "ブランド刷新" });
    expect(topic.getAttribute("href")).toBe("/topics/t1");
    expect(
      topic.compareDocumentPosition(headings[0] as Node) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(article.querySelector("time")?.getAttribute("dateTime")).toBe(
      NOW.toISOString(),
    );
    expect(article.textContent).toContain("更新");
    expectInternalHrefsToResolve();
  });

  it("sets the body in the document typesetting and lists its sources under 「出典」", async () => {
    await drawDocument([SOURCE]);
    const article = screen.getByRole("article");
    expect(
      within(article).getByRole("heading", { level: 2, name: "構成" }),
    ).toBeTruthy();
    expect(
      within(article)
        .getAllByRole("listitem")
        .map((item) => item.textContent),
    ).toEqual(expect.arrayContaining(["トップ", "事例"]));
    const sources = within(article).getByRole("region", { name: "出典" });
    expect(sources.textContent).toContain("ワイヤーフレームの構成");
  });

  it("leaves the sources out when there is none, the sheet ending with the body", async () => {
    await drawDocument([]);
    const article = screen.getByRole("article");
    expect(within(article).queryByRole("region")).toBeNull();
    expect(within(article).getByText("トップは姿勢を見せる。")).toBeTruthy();
  });
});

describe("DocumentSkeleton", () => {
  it("draws P-08's lines — topic, title, update time, body — busy, hidden, and headed only by its loading label", async () => {
    await renderWithRouter(<DocumentSkeleton mode="read" />);
    const region = screen.getByRole("status");
    expect(region.getAttribute("aria-busy")).toBe("true");
    expect(region.textContent).toContain("読み込み中");
    // P-08's `h1` is the document's title; until it arrives the loading
    // label is the page's heading, and the stand-in title is not one.
    const heading = within(region).getByRole("heading");
    expect([heading.tagName, heading.textContent]).toEqual([
      "H1",
      "読み込み中",
    ]);
    expect(within(region).getByText("2026年7月20日 12:42 更新")).toBeTruthy();
    const standIns = [...region.querySelectorAll("[aria-hidden='true']")];
    expect(standIns.length).toBe(5);
  });

  it("draws the editor's lines — topic, title, body — without the update time", async () => {
    await renderWithRouter(<DocumentSkeleton mode="edit" />);
    const region = screen.getByRole("status");
    expect(region.getAttribute("aria-busy")).toBe("true");
    expect(within(region).queryByText("2026年7月20日 12:42 更新")).toBeNull();
    // P-09 keeps its `h1` in the header, so the label is not one here.
    expect(within(region).queryByRole("heading")).toBeNull();
    const standIns = [...region.querySelectorAll("[aria-hidden='true']")];
    expect(standIns.length).toBe(4);
  });
});

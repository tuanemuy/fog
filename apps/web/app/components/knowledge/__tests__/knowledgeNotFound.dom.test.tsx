import { screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { renderWithRouter } from "@/components/__tests__/renderWithRouter";
import { KnowledgeNotFound } from "@/components/knowledge/KnowledgeNotFound";

describe("KnowledgeNotFound", () => {
  it("is one sentence naming the subject, and the way back to the topic list", async () => {
    const { container, expectInternalHrefsToResolve } = await renderWithRouter(
      <KnowledgeNotFound subject="トピック" />,
      { path: "/topics/$topicId" },
    );
    const sentence = screen.getByText("トピックが見つかりません");
    expect(sentence.tagName).toBe("P");
    expect(screen.queryByRole("heading")).toBeNull();
    const back = screen.getByRole("link", { name: "トピック一覧へ" });
    expect(back.getAttribute("href")).toBe("/topics");
    expect(container.textContent).toBe(
      "トピックが見つかりませんトピック一覧へ",
    );
    expectInternalHrefsToResolve();
  });

  it("does the same for a document", async () => {
    await renderWithRouter(<KnowledgeNotFound subject="ドキュメント" />, {
      path: "/documents/$documentId",
    });
    expect(screen.getByText("ドキュメントが見つかりません").tagName).toBe("P");
    expect(
      screen.getByRole("link", { name: "トピック一覧へ" }).getAttribute("href"),
    ).toBe("/topics");
  });
});

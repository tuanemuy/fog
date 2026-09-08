import { screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { renderWithRouter } from "@/components/__tests__/renderWithRouter";
import { KnowledgeNotFound } from "@/components/knowledge/KnowledgeNotFound";

describe("KnowledgeNotFound", () => {
  it("names the subject and links back to the topic list", async () => {
    const { expectInternalHrefsToResolve } = await renderWithRouter(
      <KnowledgeNotFound subject="トピック" />,
      { path: "/topics/$topicId" },
    );
    expect(screen.getByRole("status").textContent).toContain(
      "トピックが見つかりません",
    );
    expect(
      screen.getByRole("link", { name: "トピック一覧へ" }).getAttribute("href"),
    ).toBe("/topics");
    expectInternalHrefsToResolve();
  });

  it("does the same for a document", async () => {
    await renderWithRouter(<KnowledgeNotFound subject="ドキュメント" />, {
      path: "/documents/$documentId",
    });
    expect(screen.getByRole("status").textContent).toContain(
      "ドキュメントが見つかりません",
    );
  });
});

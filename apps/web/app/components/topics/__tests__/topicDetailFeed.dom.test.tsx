import { screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { renderWithRouter } from "@/components/__tests__/renderWithRouter";
import { TopicDocuments } from "@/components/topics/TopicDetailFeed";
import { formatDay } from "@/presentation/time";

describe("TopicDocuments", () => {
  it("links each document with its title and update day, and offers the new-document link", async () => {
    const updatedAt = new Date("2026-01-01T14:00:00Z");
    const { expectInternalHrefsToResolve } = await renderWithRouter(
      <TopicDocuments
        topicId="t1"
        documents={[{ id: "d1", title: "サイト構成の方針", updatedAt }]}
      />,
      { path: "/topics/$topicId" },
    );
    const doc = screen.getByRole("link", { name: /サイト構成の方針/ });
    expect(doc.getAttribute("href")).toBe("/documents/d1");
    expect(doc.textContent).toContain(`${formatDay(updatedAt)} 更新`);
    expect(
      screen
        .getByRole("link", { name: /新しいドキュメント/ })
        .getAttribute("href"),
    ).toBe("/topics/t1/documents/new");
    expect(screen.queryByText("まだドキュメントがありません")).toBeNull();
    expectInternalHrefsToResolve();
  });

  it("says so when there is no document", async () => {
    await renderWithRouter(<TopicDocuments topicId="t1" documents={[]} />, {
      path: "/topics/$topicId",
    });
    expect(screen.getByText("まだドキュメントがありません")).toBeTruthy();
    expect(
      screen.getByRole("link", { name: /新しいドキュメント/ }),
    ).toBeTruthy();
  });
});

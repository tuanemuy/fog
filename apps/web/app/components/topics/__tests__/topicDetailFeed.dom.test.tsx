import { screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { renderWithRouter } from "@/components/__tests__/renderWithRouter";
import { TopicDocuments } from "@/components/topics/TopicDetailFeed";
import { formatDay } from "@/presentation/time";

describe("TopicDocuments", () => {
  it("lists each document as a row link with its title and update day, then 新しいドキュメント last", async () => {
    const updatedAt = new Date("2026-01-01T14:00:00Z");
    const { expectInternalHrefsToResolve } = await renderWithRouter(
      <TopicDocuments
        topicId="t1"
        documents={[
          { id: "d1", title: "サイト構成の方針", updatedAt },
          { id: "d2", title: "ロゴ検討の経緯", updatedAt },
        ]}
      />,
      { path: "/topics/$topicId" },
    );
    const section = screen.getByRole("region", { name: "ドキュメント" });
    expect(within(section).getByRole("heading", { level: 3 }).textContent).toBe(
      "ドキュメント",
    );
    const items = within(section).getAllByRole("listitem");
    expect(items).toHaveLength(3);
    const doc = within(items[0] as HTMLElement).getByRole("link");
    expect(doc.getAttribute("href")).toBe("/documents/d1");
    expect(doc.textContent).toBe(
      `サイト構成の方針${formatDay(updatedAt)} 更新`,
    );
    expect(doc.querySelector("svg")?.getAttribute("data-icon")).toBe("jump");
    const add = within(items[2] as HTMLElement).getByRole("link");
    expect(add.textContent).toBe("新しいドキュメント");
    expect(add.getAttribute("href")).toBe("/topics/t1/documents/new");
    expect(add.querySelector("svg")?.getAttribute("data-icon")).toBe("plus");
    expectInternalHrefsToResolve();
  });

  it("offers only 新しいドキュメント when there is no document", async () => {
    await renderWithRouter(<TopicDocuments topicId="t1" documents={[]} />, {
      path: "/topics/$topicId",
    });
    const section = screen.getByRole("region", { name: "ドキュメント" });
    const items = within(section).getAllByRole("listitem");
    expect(items).toHaveLength(1);
    expect(
      within(section)
        .getAllByRole("link")
        .map((l) => l.textContent),
    ).toEqual(["新しいドキュメント"]);
    expect(section.textContent).not.toContain("まだ");
  });
});

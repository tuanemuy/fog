import { screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { renderWithRouter } from "@/components/__tests__/renderWithRouter";
import { SourceDocumentLinks } from "@/components/timeline/SourceDocumentLinks";

describe("SourceDocumentLinks", () => {
  it("renders nothing for an empty trail", async () => {
    const { container } = await renderWithRouter(
      <SourceDocumentLinks documents={[]} />,
    );
    expect(container.querySelector("nav")).toBeNull();
  });

  it("links a live document and disables a trashed one", async () => {
    const { expectInternalHrefsToResolve } = await renderWithRouter(
      <SourceDocumentLinks
        documents={[
          { documentId: "d1", title: "サイト構成の方針", isTrashed: false },
          { documentId: "d2", title: "hidden", isTrashed: true },
        ]}
      />,
    );
    const nav = screen.getByRole("navigation", {
      name: "出典になっているドキュメント",
    });
    const link = screen.getByRole("link", { name: /サイト構成の方針/ });
    expect(link.getAttribute("href")).toBe("/documents/d1");
    const disabled = nav.querySelector('[aria-disabled="true"]');
    expect(disabled?.textContent).toContain("削除済みのドキュメント");
    expect(nav.textContent).not.toContain("hidden");
    expectInternalHrefsToResolve();
  });
});

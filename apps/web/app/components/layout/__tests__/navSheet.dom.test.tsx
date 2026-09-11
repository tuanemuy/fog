import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { renderWithRouter } from "@/components/__tests__/renderWithRouter";
import { AppShell } from "@/components/layout/AppShell";
import { NAV_ITEMS } from "@/components/layout/navigation";

const menuButton = () => screen.getByRole("button", { name: "メニュー" });

const sheetNav = () =>
  screen.queryByRole("navigation", { name: "モバイルナビゲーション" });

function dialog(): HTMLDialogElement {
  const id = menuButton().getAttribute("aria-controls");
  const element = id === null ? null : document.getElementById(id);
  if (!(element instanceof HTMLDialogElement)) throw new Error("no sheet");
  return element;
}

async function openSheet(
  path: "/" | "/documents/$documentId" | "/memos/$memoId/history" = "/",
) {
  const rendered = await renderWithRouter(<AppShell>x</AppShell>, { path });
  fireEvent.click(menuButton());
  await waitFor(() => expect(dialog().open).toBe(true));
  return rendered;
}

describe("NavSheet", () => {
  it("stays shut until the menu opens it", async () => {
    await renderWithRouter(<AppShell>x</AppShell>);
    expect(menuButton().getAttribute("aria-expanded")).toBe("false");
    expect(dialog().open).toBe(false);
    expect(sheetNav()).toBeNull();
    fireEvent.click(menuButton());
    await waitFor(() => expect(dialog().open).toBe(true));
    expect(menuButton().getAttribute("aria-expanded")).toBe("true");
    expect(sheetNav()).not.toBeNull();
  });

  it("is a white card with a handle, on the sheet's frame, over the overlay", async () => {
    await openSheet();
    const sheet = dialog();
    expect(sheet.getAttribute("aria-label")).toBe("メニュー");
    for (const utility of ["inset-x-sheet-inset", "backdrop:bg-overlay"]) {
      expect(sheet.classList.contains(utility), utility).toBe(true);
    }
    const card = sheet.firstElementChild;
    for (const utility of ["bg-bg-card", "shadow-lg", "rounded-t-lg"]) {
      expect(card?.classList.contains(utility), utility).toBe(true);
    }
    const handle = card?.firstElementChild;
    expect(handle?.getAttribute("aria-hidden")).toBe("true");
    expect(handle?.classList.contains("w-handle-w")).toBe(true);
  });

  // Paths no nav item links to, so the mark is the shell's `match` and not
  // the router's own active-link logic.
  it.each([
    ["/documents/$documentId", "トピック", "タイムライン"],
    ["/memos/$memoId/history", "タイムライン", "トピック"],
  ] as const)(
    "lists the five destinations and marks the current one on %s",
    async (path, current, other) => {
      await openSheet(path);
      const nav = sheetNav();
      if (nav === null) throw new Error("no nav");
      const links = within(nav).getAllByRole("link");
      expect(links.map((link) => link.textContent)).toEqual(
        NAV_ITEMS.map((item) => item.label),
      );
      expect(
        within(nav)
          .getByRole("link", { name: current })
          .getAttribute("aria-current"),
      ).toBe("page");
      expect(
        within(nav)
          .getByRole("link", { name: other })
          .getAttribute("aria-current"),
      ).toBeNull();
    },
  );

  it("closes once an item is chosen, and goes there", async () => {
    const { router } = await openSheet("/");
    const nav = sheetNav();
    if (nav === null) throw new Error("no nav");
    fireEvent.click(within(nav).getByRole("link", { name: "検索" }));
    await waitFor(() => expect(dialog().open).toBe(false));
    expect(menuButton().getAttribute("aria-expanded")).toBe("false");
    await waitFor(() => expect(router.state.location.pathname).toBe("/search"));
  });

  it("closes on a press on the overlay and not on one inside the card", async () => {
    await openSheet();
    const sheet = dialog();
    const nav = sheetNav();
    if (nav === null) throw new Error("no nav");
    fireEvent.click(nav);
    expect(sheet.open).toBe(true);
    fireEvent.click(sheet);
    await waitFor(() => expect(sheet.open).toBe(false));
    expect(menuButton().getAttribute("aria-expanded")).toBe("false");
  });

  it("follows a close the browser made itself (Escape)", async () => {
    await openSheet();
    const sheet = dialog();
    sheet.removeAttribute("open");
    fireEvent(sheet, new Event("close"));
    await waitFor(() =>
      expect(menuButton().getAttribute("aria-expanded")).toBe("false"),
    );
    fireEvent.click(menuButton());
    await waitFor(() => expect(sheet.open).toBe(true));
  });
});

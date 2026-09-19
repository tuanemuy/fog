import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, expectTypeOf, it, vi } from "vitest";
import { renderWithRouter } from "@/components/__tests__/renderWithRouter";
import {
  ICON_NAMES,
  Icon,
  type IconName,
  type IconSize,
} from "@/components/ui/Icon";
import { IconButton } from "@/components/ui/IconButton";
import { IconButtonLink } from "@/components/ui/IconButtonLink";

const SIZES: readonly IconSize[] = ["lg", "md", "sm", "xs"];

const glyph = (element: Element) => {
  const svg = element.querySelector("svg");
  if (svg === null) throw new Error("no glyph drawn");
  return svg;
};

describe("Icon", () => {
  it("draws a different glyph for every name, hidden from assistive technology", () => {
    const { container } = render(
      <div>
        {ICON_NAMES.map((name) => (
          <Icon key={name} name={name} size="md" />
        ))}
      </div>,
    );
    const svgs = [...container.querySelectorAll("svg")];
    expect(svgs.map((svg) => svg.getAttribute("data-icon"))).toEqual([
      ...ICON_NAMES,
    ]);
    expect(new Set(svgs.map((svg) => svg.innerHTML)).size).toBe(
      ICON_NAMES.length,
    );
    for (const svg of svgs) {
      expect(svg.getAttribute("aria-hidden")).toBe("true");
    }
  });

  it.each(SIZES)("sizes a glyph to the %s token and to no other", (size) => {
    const { container } = render(<Icon name="edit" size={size} />);
    const svg = glyph(container);
    for (const other of SIZES) {
      expect(svg.classList.contains(`size-icon-${other}`), other).toBe(
        other === size,
      );
    }
  });

  it("spins the spinner and nothing else", () => {
    const { container } = render(
      <>
        <Icon name="spinner" size="xs" />
        <Icon name="restore" size="xs" />
      </>,
    );
    const [spinner, restore] = [...container.querySelectorAll("svg")];
    expect(spinner?.classList.contains("animate-spin")).toBe(true);
    expect(restore?.classList.contains("animate-spin")).toBe(false);
  });

  // Held by `pnpm typecheck`, not at run time.
  it("takes a name and a size from closed sets", () => {
    expectTypeOf<"star">().not.toExtend<IconName>();
    expectTypeOf<"xl">().not.toExtend<IconSize>();
  });
});

describe("IconButton", () => {
  it("is named by its label and shows only the glyph", () => {
    const onClick = vi.fn();
    render(
      <IconButton
        icon="delete"
        label="完全に削除"
        size="md"
        placement="row"
        tone="danger"
        onClick={onClick}
      />,
    );
    const button = screen.getByRole("button", { name: "完全に削除" });
    expect(button.textContent).toBe("");
    expect(button.getAttribute("type")).toBe("button");
    const svg = glyph(button);
    expect(svg.getAttribute("data-icon")).toBe("delete");
    expect(svg.classList.contains("size-icon-md")).toBe(true);
    fireEvent.click(button);
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it("gives the header placement a hover surface and the row placement none", () => {
    render(
      <>
        <IconButton icon="edit" label="編集" size="md" placement="header" />
        <IconButton icon="restore" label="復元" size="md" placement="row" />
      </>,
    );
    const header = screen.getByRole("button", { name: "編集" });
    const row = screen.getByRole("button", { name: "復元" });
    expect(header.classList.contains("not-disabled:hover:bg-bg-hover")).toBe(
      true,
    );
    expect(row.classList.contains("not-disabled:hover:bg-bg-hover")).toBe(
      false,
    );
    expect(header.classList.contains("p-sm")).toBe(true);
    expect(row.classList.contains("p-xs")).toBe(true);
  });

  it("colors by tone and keeps the red focus ring for danger", () => {
    render(
      <>
        <IconButton
          icon="restore"
          label="復元"
          size="md"
          placement="row"
          tone="primary"
        />
        <IconButton
          icon="delete"
          label="削除"
          size="md"
          placement="row"
          tone="danger"
        />
        <IconButton icon="more" label="操作" size="sm" placement="row" />
      </>,
    );
    const primary = screen.getByRole("button", { name: "復元" });
    const danger = screen.getByRole("button", { name: "削除" });
    const neutral = screen.getByRole("button", { name: "操作" });
    expect(primary.classList.contains("text-primary")).toBe(true);
    expect(
      danger.classList.contains("focus-visible:outline-focus-danger"),
    ).toBe(true);
    expect(neutral.classList.contains("text-neutral-500")).toBe(true);
    expect(
      neutral.classList.contains("focus-visible:outline-focus-danger"),
    ).toBe(false);
  });

  it("passes aria state and disabled through", () => {
    render(
      <IconButton
        icon="menu"
        label="メニュー"
        size="md"
        placement="header"
        aria-expanded={false}
        aria-controls="nav"
        disabled
      />,
    );
    const button = screen.getByRole("button", { name: "メニュー" });
    expect(button.getAttribute("aria-expanded")).toBe("false");
    expect(button.getAttribute("aria-controls")).toBe("nav");
    expect((button as HTMLButtonElement).disabled).toBe(true);
  });

  // Held by `pnpm typecheck`: the elements are built, never drawn.
  it("cannot be written without a name or with content of its own", () => {
    const refused = [
      // @ts-expect-error — an icon-only control needs its accessible name
      <IconButton key="a" icon="close" size="sm" placement="row" />,
      // @ts-expect-error — the glyph is the only content
      <IconButton key="b" icon="plus" label="追加" size="sm" placement="row">
        ＋
      </IconButton>,
    ];
    expect(refused).toHaveLength(2);
  });

  it("keeps its label and look over what a caller forces through", () => {
    render(
      <>
        <IconButton
          icon="back"
          label="戻る"
          size="lg"
          placement="header"
          // @ts-expect-error — no className on a primitive
          className="p-md"
        />
        {/* JSX lets any hyphenated attribute through the types */}
        <IconButton
          icon="plus"
          label="追加"
          size="sm"
          placement="row"
          aria-label="別の名前"
        />
      </>,
    );
    const button = screen.getByRole("button", { name: "戻る" });
    expect(button.classList.contains("p-md")).toBe(false);
    expect(button.classList.contains("p-sm")).toBe(true);
    expect(screen.getByRole("button", { name: "追加" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "別の名前" })).toBeNull();
  });
});

describe("IconButtonLink", () => {
  it("is a router link named by its label", async () => {
    const { expectInternalHrefsToResolve } = await renderWithRouter(
      <IconButtonLink
        to="/documents/$documentId/history"
        params={{ documentId: "d1" }}
        icon="history"
        label="履歴を表示"
        size="md"
        placement="header"
      />,
    );
    const link = screen.getByRole("link", { name: "履歴を表示" });
    expect(link.getAttribute("href")).toBe("/documents/d1/history");
    expect(link.textContent).toBe("");
    expect(glyph(link).getAttribute("data-icon")).toBe("history");
    expect(expectInternalHrefsToResolve()).toEqual(["/documents/d1/history"]);
  });

  it("drops a className the router would merge in", async () => {
    await renderWithRouter(
      <IconButtonLink
        to="/documents/$documentId/edit"
        params={{ documentId: "d1" }}
        icon="edit"
        label="編集"
        size="md"
        placement="header"
        // @ts-expect-error — no className on a primitive
        className="p-md"
      />,
    );
    const link = screen.getByRole("link", { name: "編集" });
    expect(link.classList.contains("p-md")).toBe(false);
    expect(link.classList.contains("p-sm")).toBe(true);
  });
});

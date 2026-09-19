import { render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { renderWithRouter } from "@/components/__tests__/renderWithRouter";
import { IconButton } from "@/components/ui/IconButton";
import { Row } from "@/components/ui/Row";
import { RowLink } from "@/components/ui/RowLink";
import { RowList } from "@/components/ui/RowList";

// The row's line is the element that lays the text column and the controls
// side by side; the text column is the element holding the text.
const lineOf = (text: string) => {
  const line = screen.getByText(text).parentElement;
  if (line === null) throw new Error(`no line around ${text}`);
  return line;
};

describe("RowList", () => {
  it("is an ordered list only when asked, named by its label", () => {
    render(
      <>
        <RowList aria-label="検索結果" ordered>
          <li>a</li>
        </RowList>
        <RowList aria-label="ゴミ箱の項目">
          <li>b</li>
        </RowList>
      </>,
    );
    expect(screen.getByRole("list", { name: "検索結果" }).tagName).toBe("OL");
    expect(screen.getByRole("list", { name: "ゴミ箱の項目" }).tagName).toBe(
      "UL",
    );
  });

  it("draws the hairline between its items, not above the first", () => {
    render(
      <RowList aria-label="一覧">
        <li>a</li>
        <li>b</li>
      </RowList>,
    );
    const list = screen.getByRole("list", { name: "一覧" });
    expect(list.classList.contains("*:not-first:border-t")).toBe(true);
    expect(list.classList.contains("*:border-neutral-100")).toBe(true);
  });
});

describe("RowLink", () => {
  it("makes the whole row one link, ending in the jump mark", async () => {
    const { expectInternalHrefsToResolve } = await renderWithRouter(
      <RowLink to="/documents/$documentId" params={{ documentId: "d1" }}>
        <span>サイト構成の方針</span>
        <span>7月20日 更新</span>
      </RowLink>,
    );
    const link = screen.getByRole("link", {
      name: "サイト構成の方針7月20日 更新",
    });
    expect(link.getAttribute("href")).toBe("/documents/d1");
    const marks = link.querySelectorAll("svg");
    expect(marks).toHaveLength(1);
    expect(marks[0]?.getAttribute("data-icon")).toBe("jump");
    expect(marks[0]?.getAttribute("aria-hidden")).toBe("true");
    expect(link.classList.contains("hover:bg-neutral-50")).toBe(true);
    expect(expectInternalHrefsToResolve()).toEqual(["/documents/d1"]);
  });

  it("drops a className the router would merge in", async () => {
    await renderWithRouter(
      // @ts-expect-error — no className on a primitive
      <RowLink to="/topics" className="p-md">
        トピック
      </RowLink>,
    );
    const link = screen.getByRole("link", { name: "トピック" });
    expect(link.classList.contains("p-md")).toBe(false);
    expect(link.classList.contains("py-row")).toBe(true);
  });
});

describe("Row", () => {
  it("lays its controls beside the text", () => {
    render(
      <Row
        actions={
          <IconButton icon="restore" label="復元" size="md" placement="row" />
        }
      >
        打ち合わせ前の走り書き。
      </Row>,
    );
    const line = lineOf("打ち合わせ前の走り書き。");
    expect(within(line).getByRole("button", { name: "復元" })).toBeTruthy();
    expect(line.classList.contains("pt-row")).toBe(true);
  });

  it("draws an error under the row, outside the text column, and tightens the row above it", () => {
    render(
      <>
        <Row error={<p role="alert">復元できませんでした</p>}>失敗した行</Row>
        <Row error={null}>普通の行</Row>
      </>,
    );
    const failed = lineOf("失敗した行");
    const alert = screen.getByRole("alert");
    expect(alert.textContent).toBe("復元できませんでした");
    expect(failed.contains(alert)).toBe(false);
    expect(failed.parentElement?.contains(alert)).toBe(true);
    expect(failed.classList.contains("pb-sm")).toBe(true);
    expect(failed.classList.contains("pb-row")).toBe(false);

    const plain = lineOf("普通の行");
    expect(plain.parentElement?.childElementCount).toBe(1);
    expect(plain.classList.contains("pb-row")).toBe(true);
    expect(plain.classList.contains("pb-sm")).toBe(false);
  });

  it("sets a nested row smaller and indented under its item", () => {
    render(
      <>
        <Row>旧サイト運用</Row>
        <Row level="nested">ドメイン管理の手続き</Row>
      </>,
    );
    const item = lineOf("旧サイト運用");
    const nested = lineOf("ドメイン管理の手続き");
    expect(nested.classList.contains("pl-lg")).toBe(true);
    expect(nested.classList.contains("text-sm")).toBe(true);
    expect(item.classList.contains("pl-lg")).toBe(false);
    expect(item.classList.contains("text-base")).toBe(true);
  });

  it("marks the row busy only while an action is in flight", () => {
    render(
      <>
        <Row busy>復元中の行</Row>
        <Row>待機中の行</Row>
      </>,
    );
    expect(lineOf("復元中の行").parentElement?.getAttribute("aria-busy")).toBe(
      "true",
    );
    expect(lineOf("待機中の行").parentElement?.hasAttribute("aria-busy")).toBe(
      false,
    );
  });
});

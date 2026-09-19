import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, expectTypeOf, it, vi } from "vitest";
import { ComposerError } from "@/components/ui/ComposerError";
import { IconButton } from "@/components/ui/IconButton";
import {
  InlineAlert,
  type InlineAlertProps,
  type InlineAlertTone,
} from "@/components/ui/InlineAlert";
import { Row } from "@/components/ui/Row";
import { RowError } from "@/components/ui/RowError";

const glyphsIn = (element: Element) =>
  [...element.querySelectorAll("svg")].map((svg) =>
    svg.getAttribute("data-icon"),
  );

describe("RowError", () => {
  it("is an alert with the error glyph and one sentence, and a retry only when given one", () => {
    const onRetry = vi.fn();
    render(
      <>
        <RowError
          message="復元できませんでした"
          retry={{ label: "リトライ", onRetry }}
        />
        <RowError message="生成できませんでした" />
      </>,
    );
    const [withRetry, without] = screen.getAllByRole("alert");
    if (withRetry === undefined || without === undefined) {
      throw new Error("expected two alerts");
    }
    expect(glyphsIn(withRetry)).toEqual(["error"]);
    expect(within(withRetry).getByText("復元できませんでした")).toBeTruthy();
    fireEvent.click(
      within(withRetry).getByRole("button", { name: "リトライ" }),
    );
    expect(onRetry).toHaveBeenCalledTimes(1);

    expect(within(without).getByText("生成できませんでした")).toBeTruthy();
    expect(within(without).queryByRole("button")).toBeNull();
  });

  it("goes under the row in Row's error slot, outside its text column", () => {
    render(
      <Row
        actions={
          <IconButton icon="restore" label="復元" size="md" placement="row" />
        }
        error={<RowError message="復元できませんでした" />}
      >
        打ち合わせ前の走り書き。
      </Row>,
    );
    const alert = screen.getByRole("alert");
    const line = screen.getByText("打ち合わせ前の走り書き。").parentElement;
    expect(line?.contains(alert)).toBe(false);
    expect(line?.contains(screen.getByRole("button", { name: "復元" }))).toBe(
      true,
    );
    expect(line?.parentElement?.lastElementChild?.contains(alert)).toBe(true);
    expect(line?.classList.contains("pb-sm")).toBe(true);
  });
});

describe("InlineAlert", () => {
  const CASES: ReadonlyArray<
    readonly [InlineAlertTone, "status" | "alert", string | null, string]
  > = [
    ["info", "status", null, "bg-info-bg"],
    ["warning", "alert", "warning", "bg-warning-bg"],
    ["error", "alert", "error", "bg-error-bg"],
  ];

  it.each(CASES)(
    "speaks the %s tone as %s, with its glyph and surface",
    (tone, role, glyph, surface) => {
      render(<InlineAlert tone={tone}>保存できませんでした</InlineAlert>);
      const alert = screen.getByRole(role);
      expect(alert.textContent).toBe("保存できませんでした");
      expect(glyphsIn(alert)).toEqual(glyph === null ? [] : [glyph]);
      expect(alert.classList.contains(surface)).toBe(true);
    },
  );

  it("offers a retry on the error tone when given one", () => {
    const onRetry = vi.fn();
    render(
      <>
        <InlineAlert tone="error" retry={{ label: "再試行", onRetry }}>
          保存できませんでした
        </InlineAlert>
        <InlineAlert tone="warning">
          編集中に Claude Desktop がこのメモを更新しました。
        </InlineAlert>
      </>,
    );
    const [failed, warned] = screen.getAllByRole("alert");
    if (failed === undefined || warned === undefined) {
      throw new Error("expected two alerts");
    }
    fireEvent.click(within(failed).getByRole("button", { name: "再試行" }));
    expect(onRetry).toHaveBeenCalledTimes(1);
    expect(within(warned).getByText(/Claude Desktop/)).toBeTruthy();
    expect(within(warned).queryByRole("button")).toBeNull();
  });

  // Held by `pnpm typecheck`, not at run time.
  it("takes a retry on the error tone only", () => {
    const retry = { label: "再試行", onRetry: () => {} };
    expectTypeOf({
      tone: "error",
      retry,
      children: "x",
    } as const).toExtend<InlineAlertProps>();
    expectTypeOf({
      tone: "warning",
      retry,
      children: "x",
    } as const).not.toExtend<InlineAlertProps>();
    expectTypeOf({
      tone: "info",
      retry,
      children: "x",
    } as const).not.toExtend<InlineAlertProps>();
  });
});

describe("ComposerError", () => {
  it("floats the failed post over the composer with its retry", () => {
    const onRetry = vi.fn();
    render(
      <ComposerError
        message="投稿できませんでした"
        retry={{ label: "再試行", onRetry }}
      />,
    );
    const alert = screen.getByRole("alert");
    expect(alert.textContent).toBe("投稿できませんでした再試行");
    expect(glyphsIn(alert)).toEqual(["error"]);
    expect(alert.classList.contains("shadow-md")).toBe(true);
    fireEvent.click(within(alert).getByRole("button", { name: "再試行" }));
    expect(onRetry).toHaveBeenCalledTimes(1);
  });

  it("has no control without a retry", () => {
    render(<ComposerError message="投稿できませんでした" />);
    const alert = screen.getByRole("alert");
    expect(alert.textContent).toBe("投稿できませんでした");
    expect(within(alert).queryByRole("button")).toBeNull();
  });
});

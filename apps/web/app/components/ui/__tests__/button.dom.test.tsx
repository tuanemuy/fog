import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, expectTypeOf, it, vi } from "vitest";
import { renderWithRouter } from "@/components/__tests__/renderWithRouter";
import {
  Button,
  type ButtonProps,
  type ButtonVariant,
} from "@/components/ui/Button";
import { ButtonLink } from "@/components/ui/ButtonLink";

// What tells the steps apart: the box (padding token or border) and, for the
// destructive step only, the red focus ring.
const SIGNATURE: Record<ButtonVariant, readonly string[]> = {
  fill: ["bg-primary-dark", "p-(--pad-btn)", "text-text-inverse"],
  "fill-sm": ["bg-primary-dark", "p-(--pad-btn-sm)", "text-text-inverse"],
  outline: ["[border:var(--border-input)]", "p-(--pad-btn-sm)"],
  text: ["text-neutral-600", "p-(--pad-btn-sm)"],
  "danger-text": ["text-error", "focus-visible:outline-focus-danger"],
};
const VARIANTS = Object.keys(SIGNATURE) as ButtonVariant[];

describe("Button", () => {
  it.each(VARIANTS)("draws the %s step", (variant) => {
    render(<Button variant={variant}>保存</Button>);
    const button = screen.getByRole("button", { name: "保存" });
    for (const utility of SIGNATURE[variant]) {
      expect(button.classList.contains(utility), utility).toBe(true);
    }
  });

  it("gives the red focus ring to the destructive step only", () => {
    render(
      <>
        <Button variant="danger-text">連携を解除</Button>
        <Button variant="fill">保存</Button>
      </>,
    );
    const danger = screen.getByRole("button", { name: "連携を解除" });
    const fill = screen.getByRole("button", { name: "保存" });
    expect(
      danger.classList.contains("focus-visible:outline-focus-danger"),
    ).toBe(true);
    expect(danger.classList.contains("focus-visible:outline-focus")).toBe(
      false,
    );
    expect(fill.classList.contains("focus-visible:outline-focus")).toBe(true);
    expect(fill.classList.contains("focus-visible:outline-focus-danger")).toBe(
      false,
    );
  });

  it("does not submit its form unless it is a submit button", () => {
    const onSubmit = vi.fn((event: { preventDefault: () => void }) =>
      event.preventDefault(),
    );
    render(
      <form onSubmit={onSubmit}>
        <Button variant="text">キャンセル</Button>
        <Button variant="fill" type="submit">
          ログイン
        </Button>
      </form>,
    );
    fireEvent.click(screen.getByRole("button", { name: "キャンセル" }));
    expect(onSubmit).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "ログイン" }));
    expect(onSubmit).toHaveBeenCalledTimes(1);
  });

  it("passes the native props through", () => {
    const onClick = vi.fn();
    render(
      <>
        <Button variant="fill-sm" onClick={onClick}>
          保存
        </Button>
        <Button variant="fill-sm" onClick={onClick} disabled>
          保存中…
        </Button>
      </>,
    );
    fireEvent.click(screen.getByRole("button", { name: "保存" }));
    expect(onClick).toHaveBeenCalledTimes(1);
    const pending = screen.getByRole("button", { name: "保存中…" });
    expect((pending as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(pending);
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  // Held by `pnpm typecheck`, not at run time.
  it("takes a step from a closed set and no look of the screen's own", () => {
    expectTypeOf<"ghost">().not.toExtend<ButtonVariant>();
    expectTypeOf<ButtonProps>().not.toHaveProperty("className");
    expectTypeOf<ButtonProps>().not.toHaveProperty("style");
  });

  it("drops a className a caller forces through", () => {
    render(
      <>
        {/* @ts-expect-error — no className on a primitive */}
        <Button variant="fill" className="p-md">
          a
        </Button>
        {/* @ts-expect-error — no style on a primitive */}
        <Button variant="fill" style={{ padding: 0 }}>
          b
        </Button>
      </>,
    );
    const a = screen.getByRole("button", { name: "a" });
    expect(a.classList.contains("p-md")).toBe(false);
    expect(a.classList.contains("p-(--pad-btn)")).toBe(true);
    expect(
      screen.getByRole("button", { name: "b" }).getAttribute("style"),
    ).toBeNull();
  });
});

describe("ButtonLink", () => {
  it("is a router link with a button step's look", async () => {
    const { expectInternalHrefsToResolve } = await renderWithRouter(
      <ButtonLink
        to="/topics/$topicId"
        params={{ topicId: "t1" }}
        variant="fill"
      >
        トピックへ
      </ButtonLink>,
    );
    const link = screen.getByRole("link", { name: "トピックへ" });
    expect(link.getAttribute("href")).toBe("/topics/t1");
    for (const utility of SIGNATURE.fill) {
      expect(link.classList.contains(utility), utility).toBe(true);
    }
    expect(expectInternalHrefsToResolve()).toEqual(["/topics/t1"]);
  });

  it("drops a className or style the router would merge in", async () => {
    await renderWithRouter(
      <>
        {/* @ts-expect-error — no className on a primitive */}
        <ButtonLink to="/topics" variant="outline" className="p-md">
          一覧
        </ButtonLink>
        <ButtonLink
          to="/topics"
          variant="outline"
          // @ts-expect-error — nor through the active-state props
          activeProps={{ style: { padding: 0 } }}
        >
          現在地
        </ButtonLink>
      </>,
      { path: "/topics" },
    );
    const link = screen.getByRole("link", { name: "一覧" });
    expect(link.classList.contains("p-md")).toBe(false);
    expect(link.classList.contains("[border:var(--border-input)]")).toBe(true);
    const active = screen.getByRole("link", { name: "現在地" });
    expect(active.getAttribute("aria-current")).toBe("page");
    expect(active.getAttribute("style")).toBeNull();
  });
});

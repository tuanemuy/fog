import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { Icon } from "@/components/ui/Icon";
import { Sk } from "@/components/ui/Sk";

describe("Sk", () => {
  it("keeps the stand-in text in the line but hides it, from the eye and from assistive technology", () => {
    render(
      <p>
        <Sk>サイト構成の方針</Sk>
      </p>,
    );
    const stand = screen.getByText("サイト構成の方針");
    expect(stand.getAttribute("aria-hidden")).toBe("true");
    expect(stand.classList.contains("text-transparent")).toBe(true);
    expect(stand.classList.contains("bg-neutral-100")).toBe(true);
    expect(stand.classList.contains("box-decoration-clone")).toBe(true);
  });

  it("does not animate", () => {
    const { container } = render(
      <>
        <Icon name="spinner" size="xs" />
        <Sk>読み込み中の文</Sk>
      </>,
    );
    const animated = (element: Element) =>
      [...element.classList].some((name) => name.startsWith("animate-"));
    const spinner = container.querySelector("svg");
    expect(spinner !== null && animated(spinner)).toBe(true);
    expect(animated(screen.getByText("読み込み中の文"))).toBe(false);
  });
});

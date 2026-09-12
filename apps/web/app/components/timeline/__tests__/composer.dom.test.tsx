import { fireEvent, screen, within } from "@testing-library/react";
import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { renderWithRouter } from "@/components/__tests__/renderWithRouter";
import { AppShell } from "@/components/layout/AppShell";
import { Composer, type ComposerProps } from "@/components/timeline/Composer";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function Harness(
  props: Readonly<Partial<Omit<ComposerProps, "draft" | "onDraftChange">>>,
) {
  const [draft, setDraft] = useState("");
  return (
    <Composer
      draft={draft}
      onDraftChange={setDraft}
      action={props.action ?? (() => {})}
      onSubmit={props.onSubmit ?? (() => {})}
      pending={props.pending ?? false}
      error={props.error ?? null}
    />
  );
}

function renderComposer(props: Parameters<typeof Harness>[0] = {}) {
  return renderWithRouter(
    <AppShell>
      <Harness {...props} />
    </AppShell>,
  );
}

function parts() {
  const form = screen.getByRole("form", { name: "メモを投稿" });
  return {
    form,
    input: within(form).getByRole("textbox", {
      name: "メモを入力",
    }) as HTMLTextAreaElement,
    submit: within(form).getByRole("button", {
      name: "メモを追加",
    }) as HTMLButtonElement,
  };
}

const glyphOf = (button: HTMLElement) =>
  button.querySelector("svg")?.getAttribute("data-icon");

describe("Composer", () => {
  it("is a one-line input led by the 「メモを追加」 glyph, docked outside the sheet", async () => {
    await renderComposer();
    const { form, input, submit } = parts();
    expect(screen.getByRole("main").contains(form)).toBe(false);
    expect(input.getAttribute("rows")).toBe("1");
    expect(input.getAttribute("placeholder")).toBe("メモを入力…");
    expect(
      submit.compareDocumentPosition(input) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(glyphOf(submit)).toBe("plus");
    expect(submit.getAttribute("type")).toBe("submit");
  });

  it("spins the glyph and holds the input while a post is in flight", async () => {
    await renderComposer({ pending: true });
    const { input, submit } = parts();
    expect(glyphOf(submit)).toBe("spinner");
    expect(submit.disabled).toBe(true);
    expect(input.disabled).toBe(true);
  });

  it("puts a failure right above itself with a retry that submits the draft again", async () => {
    const onSubmit = vi.fn((event: { preventDefault: () => void }) =>
      event.preventDefault(),
    );
    await renderComposer({ error: "投稿できませんでした", onSubmit });
    const { form } = parts();
    const alert = screen.getByRole("alert");
    expect(alert.textContent).toContain("投稿できませんでした");
    expect(alert.nextElementSibling).toBe(form);
    fireEvent.click(within(alert).getByRole("button", { name: "再試行" }));
    expect(onSubmit).toHaveBeenCalledTimes(1);
  });

  it("draws no failure without one", async () => {
    await renderComposer();
    expect(parts().form).toBeTruthy();
    expect(screen.queryByRole("alert")).toBeNull();
  });

  // Where the browser cannot size the input by its content, the
  // composer does it on every change.
  it("sizes the input to its content where the browser cannot", async () => {
    vi.stubGlobal("CSS", { supports: () => false });
    vi.spyOn(
      HTMLTextAreaElement.prototype,
      "scrollHeight",
      "get",
    ).mockReturnValue(84);
    await renderComposer();
    const { input } = parts();
    fireEvent.change(input, { target: { value: "a\nb\nc" } });
    expect(input.style.height).toBe("84px");
    fireEvent.change(input, { target: { value: "" } });
    expect(input.style.height).toBe("auto");
  });

  it("leaves the height to the browser where it sizes the input itself", async () => {
    vi.stubGlobal("CSS", {
      supports: (property: string, value: string) =>
        property === "field-sizing" && value === "content",
    });
    vi.spyOn(
      HTMLTextAreaElement.prototype,
      "scrollHeight",
      "get",
    ).mockReturnValue(84);
    await renderComposer();
    const { input } = parts();
    fireEvent.change(input, { target: { value: "a\nb\nc" } });
    expect(input.style.height).toBe("");
  });
});

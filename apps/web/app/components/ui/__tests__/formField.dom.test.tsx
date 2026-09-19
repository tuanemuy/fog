import { fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { describe, expect, expectTypeOf, it, vi } from "vitest";
import { FieldError } from "@/components/ui/FieldError";
import { FormError } from "@/components/ui/FormError";
import { FormGroup } from "@/components/ui/FormGroup";
import { TextAreaField } from "@/components/ui/TextAreaField";
import {
  TextField,
  type TextFieldProps,
  type TextFieldType,
} from "@/components/ui/TextField";

// The texts `aria-describedby` points at, in its order.
const descriptionOf = (control: HTMLElement): string[] =>
  (control.getAttribute("aria-describedby") ?? "")
    .split(" ")
    .filter((id) => id !== "")
    .map((id) => document.getElementById(id)?.textContent ?? `<missing ${id}>`);

describe("TextField", () => {
  it("is named by its label", () => {
    render(<TextField label="メールアドレス" type="email" name="email" />);
    const input = screen.getByRole("textbox", { name: "メールアドレス" });
    expect(input.getAttribute("type")).toBe("email");
    expect(input.getAttribute("name")).toBe("email");
    const label = screen.getByText("メールアドレス");
    expect(label.tagName).toBe("LABEL");
    expect(label.classList.contains("sr-only")).toBe(false);
  });

  it("keeps a hidden label as the name only", () => {
    render(<TextField label="トピック名" hideLabel placeholder="トピック名" />);
    screen.getByRole("textbox", { name: "トピック名" });
    const label = document.querySelector("label");
    expect(label?.textContent).toBe("トピック名");
    expect(label?.classList.contains("sr-only")).toBe(true);
  });

  it("is invalid and described by its error only while it has one", () => {
    const { rerender } = render(
      <TextField label="パスワード" type="password" helper="8文字以上" />,
    );
    const input = screen.getByLabelText("パスワード");
    expect(input.hasAttribute("aria-invalid")).toBe(false);
    expect(descriptionOf(input)).toEqual(["8文字以上"]);
    expect(screen.queryByRole("alert")).toBeNull();

    rerender(
      <TextField
        label="パスワード"
        type="password"
        helper="8文字以上"
        error="8文字以上で入力してください"
      />,
    );
    expect(input.getAttribute("aria-invalid")).toBe("true");
    expect(descriptionOf(input)).toEqual([
      "8文字以上で入力してください",
      "8文字以上",
    ]);
    expect(screen.getByRole("alert").textContent).toBe(
      "8文字以上で入力してください",
    );
    expect(input.classList.contains("aria-invalid:border-error")).toBe(true);
  });

  it("puts the error under the control and the helper under the label", () => {
    render(
      <TextField
        label="新しいパスワード"
        type="password"
        helper="8文字以上"
        error="8文字以上で入力してください"
      />,
    );
    const input = screen.getByLabelText("新しいパスワード");
    const label = screen.getByText("新しいパスワード");
    expect(label.nextElementSibling?.textContent).toBe("8文字以上");
    expect(input.nextElementSibling).toBe(screen.getByRole("alert"));
  });

  it("describes nothing when it has neither helper nor error", () => {
    render(<TextField label="名前" error={null} />);
    const input = screen.getByRole("textbox", { name: "名前" });
    expect(input.hasAttribute("aria-describedby")).toBe(false);
    expect(input.hasAttribute("aria-invalid")).toBe(false);
  });

  it("passes the native props through", () => {
    const onChange = vi.fn();
    function Controlled() {
      const [value, setValue] = useState("");
      return (
        <TextField
          label="メモ"
          value={value}
          maxLength={10}
          onChange={(event) => {
            onChange(event.target.value);
            setValue(event.target.value);
          }}
        />
      );
    }
    render(<Controlled />);
    const input = screen.getByRole("textbox", { name: "メモ" });
    fireEvent.change(input, { target: { value: "書いた" } });
    expect(onChange).toHaveBeenCalledWith("書いた");
    expect((input as HTMLInputElement).value).toBe("書いた");
    expect(input.getAttribute("maxlength")).toBe("10");
  });

  // Held by `pnpm typecheck`, not at run time.
  it("takes a text type and no look, id or description of the screen's own", () => {
    expectTypeOf<"number">().not.toExtend<TextFieldType>();
    expectTypeOf<"email">().toExtend<TextFieldType>();
    expectTypeOf<TextFieldProps>().not.toHaveProperty("className");
    expectTypeOf<TextFieldProps>().not.toHaveProperty("style");
    expectTypeOf<TextFieldProps>().not.toHaveProperty("id");
    expectTypeOf<TextFieldProps>().not.toHaveProperty("aria-describedby");
  });

  it("drops a className, style or id a caller forces through", () => {
    render(
      // @ts-expect-error — no className, style or id on a primitive
      <TextField label="a" className="p-md" style={{ padding: 0 }} id="x" />,
    );
    const input = screen.getByRole("textbox", { name: "a" });
    expect(input.classList.contains("p-md")).toBe(false);
    expect(input.classList.contains("p-(--pad-input)")).toBe(true);
    expect(input.getAttribute("style")).toBeNull();
    expect(input.id).not.toBe("x");
  });
});

describe("TextAreaField", () => {
  it("is a several-line field wired like TextField, growing with its content", () => {
    render(
      <TextAreaField
        label="説明"
        rows={3}
        error="説明が長すぎます"
        defaultValue="秋の展示会まで"
      />,
    );
    const area = screen.getByRole("textbox", { name: "説明" });
    expect(area.tagName).toBe("TEXTAREA");
    expect(area.getAttribute("rows")).toBe("3");
    expect(area.getAttribute("aria-invalid")).toBe("true");
    expect(descriptionOf(area)).toEqual(["説明が長すぎます"]);
    expect(area.classList.contains("field-sizing-content")).toBe(true);
    expect(area.classList.contains("leading-normal")).toBe(true);
  });
});

describe("FormGroup", () => {
  it("hands its ids to a control it does not draw", () => {
    render(
      <FormGroup
        label="保持期限"
        helper="既存のゴミ箱の項目にも適用されます"
        error="1以上の日数を入力してください"
      >
        {(control) => <input type="number" {...control} />}
      </FormGroup>,
    );
    const input = screen.getByRole("spinbutton", { name: "保持期限" });
    expect(input.getAttribute("aria-invalid")).toBe("true");
    expect(descriptionOf(input)).toEqual([
      "1以上の日数を入力してください",
      "既存のゴミ箱の項目にも適用されます",
    ]);
  });
});

describe("FieldError", () => {
  it("is an alert under the id the control points at", () => {
    render(
      <>
        <input aria-label="タイトル" aria-describedby="title-error" />
        <FieldError id="title-error">タイトルを入力してください</FieldError>
      </>,
    );
    expect(descriptionOf(screen.getByLabelText("タイトル"))).toEqual([
      "タイトルを入力してください",
    ]);
    expect(screen.getByRole("alert").id).toBe("title-error");
  });
});

describe("FormError", () => {
  it("is one alert for the whole form, able to carry the link that resolves it", () => {
    render(
      <FormError>
        このメールアドレスは既に登録されています。
        <a href="/login">ログイン</a>
      </FormError>,
    );
    const alert = screen.getByRole("alert");
    expect(alert.textContent).toBe(
      "このメールアドレスは既に登録されています。ログイン",
    );
    expect(alert.querySelector("a")?.getAttribute("href")).toBe("/login");
    expect(alert.classList.contains("border-error")).toBe(true);
  });
});

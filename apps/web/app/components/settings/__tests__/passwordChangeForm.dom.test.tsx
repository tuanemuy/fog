import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { renderWithRouter } from "@/components/__tests__/renderWithRouter";
import { toastsShown, withToasts } from "@/components/__tests__/toastFrame";
import {
  PASSWORD_CHANGED_MESSAGE,
  PasswordChangeForm,
} from "@/components/settings/PasswordChangeForm";
import { AppServerError } from "@/presentation/errorResponse";

const mocks = vi.hoisted(() => ({
  changePasswordFn: vi.fn<(input: { data: unknown }) => Promise<unknown>>(),
}));

vi.mock("@tanstack/react-start", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@tanstack/react-start")>()),
  useServerFn: (fn: unknown) => fn,
}));

vi.mock("@/components/settings/actions", () => ({
  changePasswordFn: mocks.changePasswordFn,
}));

afterEach(() => {
  vi.clearAllMocks();
});

const drawForm = () =>
  renderWithRouter(withToasts(<PasswordChangeForm />), { path: "/settings" });

const form = () => screen.getByRole("form", { name: "パスワード変更" });
const input = (label: string) =>
  screen.getByLabelText(label) as HTMLInputElement;

function fill(current: string, next: string) {
  fireEvent.change(input("現在のパスワード"), { target: { value: current } });
  fireEvent.change(input("新しいパスワード"), { target: { value: next } });
  fireEvent.submit(form());
}

describe("PasswordChangeForm", () => {
  it("names the requirement under the new password's label and offers the reset", async () => {
    const { expectInternalHrefsToResolve } = await drawForm();
    expect(input("新しいパスワード").getAttribute("aria-describedby")).toBe(
      screen.getByText("8文字以上").id,
    );
    expect(
      within(form())
        .getByRole("link", { name: "パスワードを忘れた" })
        .getAttribute("href"),
    ).toBe("/password-reset");
    expectInternalHrefsToResolve();
  });

  it("holds the fields read-only and says 「変更中…」 while the change runs", async () => {
    let settle!: (value: unknown) => void;
    mocks.changePasswordFn.mockReturnValue(
      new Promise((resolve) => {
        settle = resolve;
      }),
    );
    await drawForm();
    fill("old-pass-1", "new-pass-12");
    const busy = await screen.findByRole("button", { name: "変更中…" });
    expect((busy as HTMLButtonElement).disabled).toBe(true);
    expect(input("現在のパスワード").readOnly).toBe(true);
    expect(input("新しいパスワード").readOnly).toBe(true);
    settle({ ok: true });
    const idle = await screen.findByRole("button", {
      name: "パスワードを変更",
    });
    expect((idle as HTMLButtonElement).disabled).toBe(false);
    expect(input("現在のパスワード").readOnly).toBe(false);
  });

  it("posts both passwords, clears the fields, and says so in a toast rather than on the form", async () => {
    mocks.changePasswordFn.mockResolvedValue({ ok: true });
    await drawForm();
    fill("old-pass-1", "new-pass-12");
    await waitFor(() =>
      expect(toastsShown()).toEqual([PASSWORD_CHANGED_MESSAGE]),
    );
    expect(PASSWORD_CHANGED_MESSAGE).toBe("パスワードを変更しました");
    expect(mocks.changePasswordFn).toHaveBeenCalledWith({
      data: { currentPassword: "old-pass-1", newPassword: "new-pass-12" },
    });
    expect(input("現在のパスワード").value).toBe("");
    expect(input("新しいパスワード").value).toBe("");
    expect(form().textContent).not.toContain(PASSWORD_CHANGED_MESSAGE);
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it.each([
    [
      "a wrong current password on its field",
      { kind: "validation", code: "CURRENT_PASSWORD_MISMATCH", message: "no" },
      "現在のパスワード",
      "新しいパスワード",
      "現在のパスワードが正しくありません",
    ],
    [
      "a weak new password on its field",
      { kind: "business", code: "PASSWORD_TOO_WEAK", message: "no" },
      "新しいパスワード",
      "現在のパスワード",
      "8文字以上で入力してください",
    ],
  ] as const)("draws %s", async (_label, error, field, other, wording) => {
    mocks.changePasswordFn.mockRejectedValue(new AppServerError(error));
    await drawForm();
    fill("old-pass-1", "new-pass-12");
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toBe(wording);
    expect(input(field).getAttribute("aria-invalid")).toBe("true");
    expect(input(field).getAttribute("aria-describedby")).toContain(alert.id);
    expect(input(other).getAttribute("aria-invalid")).toBeNull();
    expect(toastsShown()).toEqual([]);
  });

  // spec/pages/index.md P-13: logged in, the limit is named, not hidden.
  it("draws the attempt limit first in the form with no field marked", async () => {
    mocks.changePasswordFn.mockRejectedValue(
      new AppServerError({
        kind: "validation",
        code: "TOO_MANY_ATTEMPTS",
        message: "no",
      }),
    );
    await drawForm();
    fill("old-pass-1", "new-pass-12");
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toBe(
      "試行が制限されています。しばらくしてからお試しください",
    );
    expect(form().firstElementChild).toBe(alert);
    expect(input("現在のパスワード").getAttribute("aria-invalid")).toBeNull();
    expect(input("新しいパスワード").getAttribute("aria-invalid")).toBeNull();
    expect(toastsShown()).toEqual([]);
  });
});

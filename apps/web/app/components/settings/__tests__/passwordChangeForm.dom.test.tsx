import { fireEvent, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { renderWithRouter } from "@/components/__tests__/renderWithRouter";
import { PasswordChangeForm } from "@/components/settings/PasswordChangeForm";
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

function fill(current: string, next: string) {
  fireEvent.change(screen.getByLabelText("現在のパスワード"), {
    target: { value: current },
  });
  fireEvent.change(screen.getByLabelText("新しいパスワード"), {
    target: { value: next },
  });
  fireEvent.submit(screen.getByRole("form", { name: "パスワードの変更" }));
}

describe("PasswordChangeForm", () => {
  it("posts both passwords, confirms, and clears the fields", async () => {
    mocks.changePasswordFn.mockResolvedValue({ ok: true });
    await renderWithRouter(<PasswordChangeForm />);
    fill("old-pass-1", "new-pass-12");
    await waitFor(() =>
      expect(screen.getByRole("status").textContent).toBe("変更しました"),
    );
    expect(mocks.changePasswordFn).toHaveBeenCalledWith({
      data: { currentPassword: "old-pass-1", newPassword: "new-pass-12" },
    });
    expect(
      (screen.getByLabelText("現在のパスワード") as HTMLInputElement).value,
    ).toBe("");
  });

  it.each([
    [
      "a wrong current password on its field",
      { kind: "validation", code: "CURRENT_PASSWORD_MISMATCH", message: "no" },
      "現在のパスワード",
      "現在のパスワードが正しくありません",
    ],
    [
      "a weak new password on its field",
      { kind: "business", code: "PASSWORD_TOO_WEAK", message: "no" },
      "新しいパスワード",
      "パスワードは8文字以上128文字以下で入力してください",
    ],
  ] as const)("draws %s", async (_label, error, field, wording) => {
    mocks.changePasswordFn.mockRejectedValue(new AppServerError(error));
    await renderWithRouter(<PasswordChangeForm />);
    fill("old-pass-1", "new-pass-12");
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toBe(wording);
    expect(screen.getByLabelText(field).getAttribute("aria-invalid")).toBe(
      "true",
    );
    expect(screen.queryByRole("status")).toBeNull();
  });

  it("draws a lockout as a form-level message with no field marked", async () => {
    mocks.changePasswordFn.mockRejectedValue(
      new AppServerError({
        kind: "validation",
        code: "TOO_MANY_ATTEMPTS",
        message: "no",
      }),
    );
    await renderWithRouter(<PasswordChangeForm />);
    fill("old-pass-1", "new-pass-12");
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toBe(
      "試行回数の上限に達しました。しばらくしてからお試しください",
    );
    expect(
      screen.getByLabelText("現在のパスワード").getAttribute("aria-invalid"),
    ).toBeNull();
    expect(
      screen.getByLabelText("新しいパスワード").getAttribute("aria-invalid"),
    ).toBeNull();
  });
});

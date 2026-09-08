import { fireEvent, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderWithRouter } from "@/components/__tests__/renderWithRouter";
import { PasswordResetForm } from "@/components/auth/PasswordResetForm";
import { PasswordResetRequestForm } from "@/components/auth/PasswordResetRequestForm";
import { AppServerError } from "@/presentation/errorResponse";

const mocks = vi.hoisted(() => ({
  requestPasswordResetFn:
    vi.fn<(input: { data: unknown }) => Promise<unknown>>(),
  executePasswordResetFn:
    vi.fn<(input: { data: unknown }) => Promise<unknown>>(),
}));

vi.mock("@tanstack/react-start", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@tanstack/react-start")>()),
  useServerFn: (fn: unknown) => fn,
}));

vi.mock("@/components/auth/actions", () => ({
  requestPasswordResetFn: mocks.requestPasswordResetFn,
  executePasswordResetFn: mocks.executePasswordResetFn,
  loginFn: vi.fn(),
  registerFn: vi.fn(),
  logoutFn: vi.fn(),
}));

const assign = vi.fn<(url: string) => void>();
const originalLocation = window.location;

beforeEach(() => {
  Object.defineProperty(window, "location", {
    configurable: true,
    value: { ...originalLocation, assign },
  });
});

afterEach(() => {
  Object.defineProperty(window, "location", {
    configurable: true,
    value: originalLocation,
  });
  vi.clearAllMocks();
});

describe("PasswordResetRequestForm", () => {
  it("posts the address and moves to the sent screen, whatever the address", async () => {
    mocks.requestPasswordResetFn.mockResolvedValue({ ok: true });
    const { router } = await renderWithRouter(
      <PasswordResetRequestForm sent={false} />,
      {
        path: "/password-reset",
      },
    );
    fireEvent.change(screen.getByLabelText("メールアドレス"), {
      target: { value: "nobody@example.com" },
    });
    fireEvent.submit(
      screen.getByRole("form", { name: "パスワードリセットの依頼" }),
    );
    await waitFor(() =>
      expect(router.state.location.search).toEqual({ sent: 1 }),
    );
    expect(mocks.requestPasswordResetFn).toHaveBeenCalledWith({
      data: { email: "nobody@example.com" },
    });
  });

  it("the sent screen says only that a mail was sent if the address is registered", async () => {
    const { expectInternalHrefsToResolve } = await renderWithRouter(
      <PasswordResetRequestForm sent />,
      { path: "/password-reset" },
    );
    expect(screen.getByRole("status").textContent).toContain(
      "登録されていれば",
    );
    expect(screen.queryByRole("form")).toBeNull();
    expectInternalHrefsToResolve();
  });
});

describe("PasswordResetForm", () => {
  it("posts the token with the new password and navigates to the done screen", async () => {
    mocks.executePasswordResetFn.mockResolvedValue({ userId: "u1" });
    await renderWithRouter(<PasswordResetForm token="1.0.secret" />, {
      path: "/password-reset",
    });
    fireEvent.change(screen.getByLabelText("新しいパスワード"), {
      target: { value: "new-pass-12" },
    });
    fireEvent.submit(
      screen.getByRole("form", { name: "新しいパスワードの設定" }),
    );
    await waitFor(() =>
      expect(assign).toHaveBeenCalledWith("/password-reset/done"),
    );
    expect(mocks.executePasswordResetFn).toHaveBeenCalledWith({
      data: { token: "1.0.secret", newPassword: "new-pass-12" },
    });
  });

  it("offers a new request when the link is spent or expired", async () => {
    mocks.executePasswordResetFn.mockRejectedValue(
      new AppServerError({
        kind: "validation",
        code: "RESET_TOKEN_INVALID",
        message: "no",
      }),
    );
    const { expectInternalHrefsToResolve } = await renderWithRouter(
      <PasswordResetForm token="1.0.secret" />,
      { path: "/password-reset" },
    );
    fireEvent.change(screen.getByLabelText("新しいパスワード"), {
      target: { value: "new-pass-12" },
    });
    fireEvent.submit(
      screen.getByRole("form", { name: "新しいパスワードの設定" }),
    );
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("リンクが無効か期限切れです");
    expect(
      screen
        .getByRole("link", { name: "もう一度依頼する" })
        .getAttribute("href"),
    ).toBe("/password-reset");
    expect(assign).not.toHaveBeenCalled();
    expectInternalHrefsToResolve();
  });

  it("marks a weak password on its field and keeps the link usable", async () => {
    mocks.executePasswordResetFn.mockRejectedValue(
      new AppServerError({
        kind: "business",
        code: "PASSWORD_TOO_WEAK",
        message: "no",
      }),
    );
    await renderWithRouter(<PasswordResetForm token="1.0.secret" />, {
      path: "/password-reset",
    });
    fireEvent.change(screen.getByLabelText("新しいパスワード"), {
      target: { value: "short" },
    });
    fireEvent.submit(
      screen.getByRole("form", { name: "新しいパスワードの設定" }),
    );
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toBe(
      "パスワードは8文字以上128文字以下で入力してください",
    );
    expect(
      screen.getByLabelText("新しいパスワード").getAttribute("aria-invalid"),
    ).toBe("true");
    expect(screen.queryByRole("link", { name: "もう一度依頼する" })).toBeNull();
  });
});

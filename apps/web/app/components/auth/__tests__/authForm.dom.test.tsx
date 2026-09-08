import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderWithRouter } from "@/components/__tests__/renderWithRouter";
import { AuthForm, classifyAuthError } from "@/components/auth/AuthForm";
import {
  AppServerError,
  type SerializedError,
} from "@/presentation/errorResponse";

const mocks = vi.hoisted(() => ({
  loginFn:
    vi.fn<
      (input: { data: { email: string; password: string } }) => Promise<unknown>
    >(),
  registerFn:
    vi.fn<
      (input: { data: { email: string; password: string } }) => Promise<unknown>
    >(),
}));

vi.mock("@tanstack/react-start", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@tanstack/react-start")>()),
  useServerFn: (fn: unknown) => fn,
}));

vi.mock("@/components/auth/actions", () => ({
  loginFn: mocks.loginFn,
  registerFn: mocks.registerFn,
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

const INVALID_EMAIL: SerializedError = {
  kind: "business",
  code: "INVALID_EMAIL",
  message: "Invalid email",
};
const PASSWORD_TOO_WEAK: SerializedError = {
  kind: "business",
  code: "PASSWORD_TOO_WEAK",
  message: "Weak password",
};
const EMAIL_ALREADY_REGISTERED: SerializedError = {
  kind: "conflict",
  code: "EMAIL_ALREADY_REGISTERED",
  message: "Registered",
};
const INVALID_CREDENTIALS: SerializedError = {
  kind: "validation",
  code: "INVALID_CREDENTIALS",
  message: "Invalid credentials",
};

const EMAIL_MESSAGE = "メールアドレスの形式が正しくありません";
const PASSWORD_MESSAGE = "パスワードは8文字以上128文字以下で入力してください";
const CREDENTIALS_MESSAGE = "メールアドレスまたはパスワードが正しくありません";
const PASSWORD_HINT = "8文字以上128文字以下で設定してください。";

describe("classifyAuthError", () => {
  it("attributes signup failures to their field", () => {
    expect(classifyAuthError(INVALID_EMAIL, "signup")).toEqual({
      fieldErrors: { email: EMAIL_MESSAGE },
      formError: null,
      duplicate: false,
    });
    expect(classifyAuthError(PASSWORD_TOO_WEAK, "signup")).toEqual({
      fieldErrors: { password: PASSWORD_MESSAGE },
      formError: null,
      duplicate: false,
    });
  });

  it("turns a duplicate address into a form error that offers login", () => {
    expect(classifyAuthError(EMAIL_ALREADY_REGISTERED, "signup")).toEqual({
      fieldErrors: {},
      formError: "このメールアドレスは既に登録されています",
      duplicate: true,
    });
  });

  it("collapses every login failure into one form message", () => {
    for (const serialized of [
      INVALID_CREDENTIALS,
      INVALID_EMAIL,
      PASSWORD_TOO_WEAK,
      EMAIL_ALREADY_REGISTERED,
    ]) {
      const state = classifyAuthError(serialized, "login");
      expect(state.fieldErrors).toEqual({});
      expect(state.duplicate).toBe(false);
      expect(state.formError).not.toBeNull();
    }
    expect(classifyAuthError(INVALID_CREDENTIALS, "login").formError).toBe(
      CREDENTIALS_MESSAGE,
    );
  });
});

function fill(email: string, password: string) {
  fireEvent.change(screen.getByLabelText("メールアドレス"), {
    target: { value: email },
  });
  fireEvent.change(screen.getByLabelText("パスワード"), {
    target: { value: password },
  });
}

describe("AuthForm — SSO and reset entries", () => {
  it("offers the providers with the origin and the redirect carried, and the reset link on login", async () => {
    const { expectInternalHrefsToResolve } = await renderWithRouter(
      <AuthForm mode="login" redirectTo="/topics" />,
      { path: "/login" },
    );
    expect(
      screen.getByRole("link", { name: "Google で続行" }).getAttribute("href"),
    ).toBe("/auth/sso/google/start?redirect=%2Ftopics");
    expect(
      screen.getByRole("link", { name: "Apple で続行" }).getAttribute("href"),
    ).toBe("/auth/sso/apple/start?redirect=%2Ftopics");
    expect(
      screen
        .getByRole("link", { name: "パスワードをお忘れの方" })
        .getAttribute("href"),
    ).toBe("/password-reset");
    expectInternalHrefsToResolve();
  });

  it("signup carries its origin so an error returns here, and has no reset link", async () => {
    await renderWithRouter(<AuthForm mode="signup" redirectTo={undefined} />, {
      path: "/signup",
    });
    expect(
      screen.getByRole("link", { name: "Google で続行" }).getAttribute("href"),
    ).toBe("/auth/sso/google/start?from=signup");
    expect(
      screen.queryByRole("link", { name: "パスワードをお忘れの方" }),
    ).toBeNull();
  });

  it("draws a held address from the SSO callback as an error with the login entry", async () => {
    await renderWithRouter(
      <AuthForm
        mode="signup"
        redirectTo={undefined}
        ssoError="email_registered"
      />,
      { path: "/signup" },
    );
    const alert = screen.getByRole("alert");
    expect(alert.textContent).toContain("既に登録されています");
    expect(
      within(alert).getByRole("link", { name: "ログインする" }),
    ).toBeTruthy();
  });

  it("draws a cancelled round trip as an interruption on login", async () => {
    await renderWithRouter(
      <AuthForm mode="login" redirectTo={undefined} ssoError="cancelled" />,
      { path: "/login" },
    );
    expect(screen.getByRole("alert").textContent).toBe(
      "外部アカウントでの認証が中断されました",
    );
  });
});

describe("AuthForm", () => {
  it("signup shows the password hint and links to /login with the redirect", async () => {
    const { expectInternalHrefsToResolve } = await renderWithRouter(
      <AuthForm mode="signup" redirectTo="/settings" />,
      { path: "/signup" },
    );
    expect(screen.getByRole("heading", { level: 1 }).textContent).toBe(
      "アカウント登録",
    );
    expect(screen.getByText(PASSWORD_HINT)).toBeTruthy();
    const link = screen.getByRole("link", { name: "ログイン" });
    const href = link.getAttribute("href") ?? "";
    const url = new URL(href, "http://harness.local");
    expect(url.pathname).toBe("/login");
    expect(url.searchParams.get("redirect")).toBe("/settings");
    expect(screen.queryByRole("link", { name: "アカウント登録" })).toBeNull();
    expectInternalHrefsToResolve();
  });

  it("login links to /signup and omits the hint", async () => {
    const { expectInternalHrefsToResolve } = await renderWithRouter(
      <AuthForm mode="login" redirectTo={undefined} />,
      { path: "/login" },
    );
    expect(screen.getByRole("heading", { level: 1 }).textContent).toBe(
      "ログイン",
    );
    expect(screen.queryByText(PASSWORD_HINT)).toBeNull();
    const link = screen.getByRole("link", { name: "アカウント登録" });
    const url = new URL(
      link.getAttribute("href") ?? "",
      "http://harness.local",
    );
    expect(url.pathname).toBe("/signup");
    expect(url.searchParams.get("redirect")).toBeNull();
    expect(screen.queryByRole("link", { name: "ログイン" })).toBeNull();
    expectInternalHrefsToResolve();
  });

  it("login navigates to the carried target once the session is confirmed", async () => {
    mocks.loginFn.mockResolvedValue({ userId: "u1" });
    await renderWithRouter(<AuthForm mode="login" redirectTo="/settings" />, {
      path: "/login",
    });
    fill("user@example.com", "password1");
    fireEvent.click(screen.getByRole("button", { name: "ログイン" }));
    await waitFor(() => expect(assign).toHaveBeenCalledWith("/settings"));
    expect(screen.queryByRole("alert")).toBeNull();
  });

  // The platform answering a 500 as JSON resolves on the client; that is
  // not a session, and navigating on it would loop through the guard.
  it("treats a resolved value of the wrong shape as a system error and stays", async () => {
    mocks.registerFn.mockResolvedValue({ status: 500, unhandled: true });
    await renderWithRouter(<AuthForm mode="signup" redirectTo={undefined} />, {
      path: "/signup",
    });
    fill("user@example.com", "password1");
    fireEvent.click(screen.getByRole("button", { name: "アカウント登録" }));
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toBe("システムエラーが発生しました");
    expect(assign).not.toHaveBeenCalled();
    expect(
      screen.getByLabelText("メールアドレス").getAttribute("aria-invalid"),
    ).toBeNull();
  });

  it("login draws a rejected attempt as one form message, no field error", async () => {
    mocks.loginFn.mockRejectedValue(new AppServerError(INVALID_CREDENTIALS));
    await renderWithRouter(<AuthForm mode="login" redirectTo={undefined} />, {
      path: "/login",
    });
    fill("user@example.com", "password1");
    fireEvent.click(screen.getByRole("button", { name: "ログイン" }));

    const alerts = await screen.findAllByRole("alert");
    expect(alerts).toHaveLength(1);
    expect(alerts[0]?.textContent).toBe(CREDENTIALS_MESSAGE);
    expect(mocks.loginFn).toHaveBeenCalledWith({
      data: { email: "user@example.com", password: "password1" },
    });
    expect(
      screen.getByLabelText("メールアドレス").getAttribute("aria-invalid"),
    ).toBeNull();
    expect(
      screen.getByLabelText("パスワード").getAttribute("aria-invalid"),
    ).toBeNull();
    expect(within(alerts[0] as HTMLElement).queryByRole("link")).toBeNull();
  });

  it("signup draws an invalid address next to the email field", async () => {
    mocks.registerFn.mockRejectedValue(new AppServerError(INVALID_EMAIL));
    await renderWithRouter(<AuthForm mode="signup" redirectTo={undefined} />, {
      path: "/signup",
    });
    fill("bad@example.com", "password1");
    fireEvent.click(screen.getByRole("button", { name: "アカウント登録" }));

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toBe(EMAIL_MESSAGE);
    const email = screen.getByLabelText("メールアドレス");
    expect(email.getAttribute("aria-invalid")).toBe("true");
    expect(email.getAttribute("aria-describedby")).toBe(alert.id);
    expect(
      screen.getByLabelText("パスワード").getAttribute("aria-invalid"),
    ).toBeNull();
    expect(screen.getByText(PASSWORD_HINT)).toBeTruthy();
    expect(screen.getAllByRole("alert")).toHaveLength(1);
  });

  it("signup draws a duplicate address as a form error with a login link", async () => {
    mocks.registerFn.mockRejectedValue(
      new AppServerError(EMAIL_ALREADY_REGISTERED),
    );
    const { expectInternalHrefsToResolve } = await renderWithRouter(
      <AuthForm mode="signup" redirectTo="/settings" />,
      { path: "/signup" },
    );
    fill("dup@example.com", "password1");
    fireEvent.click(screen.getByRole("button", { name: "アカウント登録" }));

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain(
      "このメールアドレスは既に登録されています",
    );
    const link = within(alert).getByRole("link", { name: "ログインする" });
    const url = new URL(
      link.getAttribute("href") ?? "",
      "http://harness.local",
    );
    expect(url.pathname).toBe("/login");
    expect(url.searchParams.get("redirect")).toBe("/settings");
    expect(
      screen.getByLabelText("メールアドレス").getAttribute("aria-invalid"),
    ).toBeNull();
    expectInternalHrefsToResolve();
  });
});
